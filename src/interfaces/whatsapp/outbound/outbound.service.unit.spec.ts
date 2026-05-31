// Unit tests for the whatsapp/outbound service. All side effects (fetch,
// Redis, OTel) are mocked so the suite runs without a real Redis instance
// (the integration counterpart in outbound.service.spec.ts is gated on
// TEST_REDIS_URL and skips by default).

process.env.PHONE_NUMBER_ID ??= 'test-phone-id';
process.env.WHATSAPP_ACCESS_TOKEN ??= 'test-token';
process.env.LOG_PII_HMAC_KEY ??=
  '0000000000000000000000000000000000000000000000000000000000000000';

const mockConnEval = jest.fn();
const mockConnSet = jest.fn();
const mockConnDel = jest.fn();
jest.mock('../../redis/queues', () => ({
  connection: { eval: mockConnEval, set: mockConnSet, del: mockConnDel },
  createQueue: () => null,
  QUEUE_NAMES: {},
}));

const mockGetBaggage = jest.fn();
jest.mock('@opentelemetry/api', () => ({
  context: { active: jest.fn().mockReturnValue('active-ctx') },
  propagation: {
    getBaggage: (...a: unknown[]) => mockGetBaggage(...a),
  },
}));

const mockMetricsRecord = jest.fn();
jest.mock('../../../otel/metrics', () => ({
  messageE2eDuration: { record: mockMetricsRecord },
}));

import { Logger } from '@nestjs/common';
import {
  sendReadAndTypingIndicator,
  sendMessage,
  sendNotification,
  downloadMedia,
  uploadMedia,
} from './outbound.service';

const globalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBaggage.mockReturnValue(undefined); // default: no baggage
});

afterEach(() => {
  global.fetch = globalFetch;
});

function mockResponse(opts: {
  status: number;
  json?: unknown;
  text?: string;
  body?: NodeJS.ReadableStream | null;
  contentType?: string;
}): Response {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
    body: opts.body ?? null,
    headers: {
      get: (k: string) =>
        k === 'content-type' ? (opts.contentType ?? null) : null,
    },
  } as unknown as Response;
}

// ---------------- sendReadAndTypingIndicator ---------------------------

describe('sendReadAndTypingIndicator', () => {
  it('POSTs the read+typing payload to the graph URL and returns on 2xx', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    await sendReadAndTypingIndicator('wamid.1');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://graph.facebook.com/v21.0/test-phone-id/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: 'wamid.1',
          typing_indicator: { type: 'text' },
        }),
      }),
    );
  });

  it('throws when the API returns non-2xx', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 500 })) as never;
    await expect(sendReadAndTypingIndicator('wamid.1')).rejects.toThrow(
      'WhatsApp read/typing API returned 500',
    );
  });
});

// ---------------- sendMessage ------------------------------------------

describe('sendMessage — claim/inflight machinery', () => {
  const baseOpts = {
    user_id: '919999990001',
    wamid: 'wamid.1',
    media: [{ type: 'text' as const, body: 'hi' }],
  };
  const baggageEntry = {
    getEntry: jest.fn().mockReturnValue({ value: '1700000000000' }),
  };

  it('consecutive=true: skips the CLAIM_LUA round-trip and goes straight to send', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200, json: {} })) as never;
    const out = await sendMessage({ ...baseOpts, consecutive: true });
    expect(mockConnEval).not.toHaveBeenCalled();
    expect(out).toEqual({ status: 200, body: { delivered: true } });
  });

  it('consecutive=false + CLAIM_LUA returns 0: returns inflight-expired without sending', async () => {
    mockConnEval.mockResolvedValue(0);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const out = await sendMessage({ ...baseOpts, consecutive: false });
    expect(out).toEqual({
      status: 200,
      body: { delivered: false, reason: 'inflight-expired' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('consecutive=false + claim succeeds + all sends succeed: deletes consec key and returns delivered', async () => {
    mockConnEval.mockResolvedValue(25000);
    mockConnDel.mockResolvedValue(1);
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200 })) as never;
    const out = await sendMessage({ ...baseOpts, consecutive: false });
    expect(mockConnDel).toHaveBeenCalledTimes(1);
    expect(out.body.delivered).toBe(true);
  });

  it('records delivery-latency metric when baggage carries wabot.msg.ts_ms', async () => {
    mockGetBaggage.mockReturnValue(baggageEntry);
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200 })) as never;
    await sendMessage({ ...baseOpts, consecutive: true });
    expect(mockMetricsRecord).toHaveBeenCalledWith(expect.any(Number), {
      outcome: 'delivered',
    });
  });

  it('warns + skips metric when baggage is missing (and on Number.isNaN parse)', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200 })) as never;
    await sendMessage({ ...baseOpts, consecutive: true });
    expect(mockMetricsRecord).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Missing wabot\.msg\.ts_ms baggage/),
    );
    // NaN ts_ms variant
    mockGetBaggage.mockReturnValueOnce({
      getEntry: jest.fn().mockReturnValue({ value: 'not-a-number' }),
    });
    await sendMessage({ ...baseOpts, consecutive: true });
    expect(mockMetricsRecord).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('sendMessage — WA returns 4XX', () => {
  const baseOpts = {
    user_id: '919999990001',
    wamid: 'wamid.1',
    media: [{ type: 'text' as const, body: 'hi' }],
  };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('claimed inflight still has TTL → recreate succeeds → no fallback', async () => {
    mockConnEval.mockResolvedValue(25_000);
    mockConnSet.mockResolvedValue('OK');
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 400,
        text: JSON.stringify({ error: { code: 131_026 } }),
      }),
    ) as never;
    const out = await sendMessage({ ...baseOpts, consecutive: false });
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ delivered: false, reason: 'whatsapp-error' });
    expect(mockConnSet).toHaveBeenCalledTimes(1); // recreate succeeded first try
  });

  it('recreate fails twice → triggers sendFallbackWithRetry', async () => {
    mockConnEval.mockResolvedValue(25_000);
    mockConnSet
      .mockRejectedValueOnce(new Error('redis-down-1'))
      .mockRejectedValueOnce(new Error('redis-down-2'));
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/fallback.mp3';
    const fetchSpy = jest
      .fn()
      // first send: 400
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }))
      // fallback first attempt: succeeds
      .mockResolvedValue(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    const out = await sendMessage({ ...baseOpts, consecutive: false });
    expect(out.status).toBe(400);
    expect(mockConnSet).toHaveBeenCalledTimes(2);
    delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
  });

  it('TTL exhausted by WA round-trip (no remainingMs) → fallback path', async () => {
    mockConnEval.mockResolvedValue(25_000);
    // Pin Date.now so claimAtMs + elapsed > claimedTtlMs
    const original = Date.now();
    const spy = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(original) // initial outer Date.now call
      .mockReturnValue(original + 60_000); // every subsequent call
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/fallback.mp3';
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 500, text: '{}' }))
      .mockResolvedValue(mockResponse({ status: 200 })); // fallback OK
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }))
      .mockResolvedValue(mockResponse({ status: 200 }));
    const out = await sendMessage({ ...baseOpts, consecutive: false });
    expect(out.body.reason).toBe('whatsapp-error');
    spy.mockRestore();
    delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
  });

  it('safeReadErrorBody: malformed JSON falls back to sanitized text', async () => {
    mockConnEval.mockResolvedValue(25_000);
    mockConnSet.mockResolvedValue('OK');
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockResponse({ status: 400, text: 'not json at all' }),
      ) as never;
    const out = await sendMessage({ ...baseOpts, consecutive: false });
    expect(out.status).toBe(400);
  });

  it('safeReadErrorBody: text() throwing returns <body read failed>', async () => {
    mockConnEval.mockResolvedValue(25_000);
    mockConnSet.mockResolvedValue('OK');
    const badResp = {
      status: 400,
      text: jest.fn().mockRejectedValue(new Error('cannot read')),
    } as unknown as Response;
    global.fetch = jest.fn().mockResolvedValue(badResp) as never;
    const out = await sendMessage({ ...baseOpts, consecutive: false });
    expect(out.status).toBe(400);
  });
});

describe('sendMessage — payload shapes', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each<
    [{ type: string; url?: string; body?: string }, Record<string, unknown>]
  >([
    [{ type: 'text', body: 'hello' }, { text: { body: 'hello' } }],
    [
      { type: 'audio', url: 'https://cdn/a.mp3' },
      { audio: { link: 'https://cdn/a.mp3' } },
    ],
    [{ type: 'audio', url: 'media-id-123' }, { audio: { id: 'media-id-123' } }],
    [
      { type: 'video', url: 'https://cdn/v.mp4' },
      { video: { link: 'https://cdn/v.mp4' } },
    ],
    [{ type: 'image', url: 'media-img-1' }, { image: { id: 'media-img-1' } }],
  ])('builds the WA payload correctly for %p', async (item, expectedExtras) => {
    const fetchSpy = jest.fn().mockResolvedValue(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: true,
      media: [item as any],
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    for (const [k, v] of Object.entries(expectedExtras)) {
      expect(body[k]).toEqual(v);
    }
    expect(body.to).toBe('919999990001');
    expect(body.messaging_product).toBe('whatsapp');
  });
});

// ---------------- sendNotification -------------------------------------

describe('sendNotification', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('all sends succeed → status 200, delivered:true', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200 })) as never;
    const out = await sendNotification({
      user_id: '919999990001',
      media: [
        { type: 'text', body: 'hi' },
        { type: 'text', body: 'there' },
      ],
    });
    expect(out).toEqual({ status: 200, delivered: true });
  });

  it('error_code 130429 → 429, delivered:false, error_code surfaced', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 400,
        json: { error: { code: 130429, message: 'rate limit' } },
      }),
    ) as never;
    const out = await sendNotification({
      user_id: '919999990001',
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(out).toEqual({ status: 429, delivered: false, error_code: 130429 });
  });

  it('error_code 131047 → 403, delivered:false, error_code surfaced', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 400,
        json: { error: { code: 131047, message: '24h' } },
      }),
    ) as never;
    const out = await sendNotification({
      user_id: '919999990001',
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(out).toEqual({ status: 403, delivered: false, error_code: 131047 });
  });

  it('other error_code → echoes status, delivered:false, error_code surfaced', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 500,
        json: { error: { code: 4, message: 'fail' } },
      }),
    ) as never;
    const out = await sendNotification({
      user_id: '919999990001',
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(out).toEqual({ status: 500, delivered: false, error_code: 4 });
  });

  it('response body not JSON-parseable → still logs + returns with error_code=undefined', async () => {
    const fakeResponse = {
      status: 500,
      ok: false,
      json: jest.fn().mockRejectedValue(new Error('not json')),
      text: jest.fn(),
    } as unknown as Response;
    global.fetch = jest.fn().mockResolvedValue(fakeResponse) as never;
    const out = await sendNotification({
      user_id: '919999990001',
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(out.delivered).toBe(false);
    expect(out.status).toBe(500);
  });
});

// ---------------- downloadMedia ----------------------------------------

describe('downloadMedia', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('happy path: returns stream + content_type from headers', async () => {
    const fakeBody = { foo: 'bar' };
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: fakeBody as unknown as NodeJS.ReadableStream,
        contentType: 'audio/mpeg',
      }),
    ) as never;
    const out = await downloadMedia('https://wa/m/1');
    expect(out.content_type).toBe('audio/mpeg');
    expect(out.stream).toBe(fakeBody);
  });

  it('defaults content_type to application/octet-stream when header is missing', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 200,
        body: {} as unknown as NodeJS.ReadableStream,
      }),
    ) as never;
    const out = await downloadMedia('https://wa/m/1');
    expect(out.content_type).toBe('application/octet-stream');
  });

  it('throws "Media URL returned 404" on 404', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 404 })) as never;
    await expect(downloadMedia('https://wa/m/1')).rejects.toThrow(
      'Media URL returned 404',
    );
  });

  it('throws on other non-OK status', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 500 })) as never;
    await expect(downloadMedia('https://wa/m/1')).rejects.toThrow(
      'Media download failed with 500',
    );
  });

  it('throws "Response body is null" when body is null', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200, body: null })) as never;
    await expect(downloadMedia('https://wa/m/1')).rejects.toThrow(
      'Response body is null',
    );
  });
});

// ---------------- uploadMedia ------------------------------------------

describe('uploadMedia', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each<[string, string, string]>([
    ['image/jpeg', 'image', 'upload.jpg'],
    ['image/png', 'image', 'upload.png'],
    ['image/webp', 'sticker', 'upload.webp'],
    ['video/mp4', 'video', 'upload.mp4'],
    ['audio/mpeg', 'audio', 'upload.mp3'],
    ['audio/ogg', 'audio', 'upload.ogg'],
    ['application/octet-stream', 'audio', 'upload.mp3'], // fallback by media_type
    ['application/x-weird', 'image', 'upload.jpg'], // fallback by media_type
    ['application/x-weird', 'unknown', 'upload.bin'], // ultimate fallback
  ])(
    'MIME %s + media_type %s → filename %s',
    async (content_type, media_type, expectedName) => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(
          mockResponse({ status: 200, json: { id: 'wa://m/1' } }),
        );
      global.fetch = fetchSpy as never;
      const out = await uploadMedia({
        data: Buffer.from('x'),
        content_type,
        media_type,
      });
      expect(out.wa_media_url).toBe('wa://m/1');
      const form = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
      const file = form.get('file') as File | null;
      expect((file as unknown as { name: string }).name).toBe(expectedName);
      expect(form.get('type')).toBe(content_type);
      expect(form.get('messaging_product')).toBe('whatsapp');
    },
  );

  it('throws on 4XX with sanitized error log', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockResponse({ status: 422, text: 'bad payload' }),
      ) as never;
    await expect(
      uploadMedia({
        data: Buffer.from('x'),
        content_type: 'image/png',
        media_type: 'image',
      }),
    ).rejects.toThrow('Upload failed with 422');
  });

  it('throws on 5XX', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockResponse({ status: 503, text: 'upstream down' }),
      ) as never;
    await expect(
      uploadMedia({
        data: Buffer.from('x'),
        content_type: 'image/png',
        media_type: 'image',
      }),
    ).rejects.toThrow('Upload failed with 503');
  });
});

// ---------------- load-test phone-prefix stub --------------------------

describe('load-test phone-prefix stub', () => {
  const PREFIX = '911000';
  const STUB_USER = `${PREFIX}123456`;
  const REAL_USER = '919999990001';

  beforeEach(() => {
    process.env.LOAD_TEST_PHONE_PREFIX = PREFIX;
  });

  afterEach(() => {
    delete process.env.LOAD_TEST_PHONE_PREFIX;
  });

  describe('sendReadAndTypingIndicator', () => {
    it('short-circuits without calling fetch when userId matches the prefix', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as never;
      await sendReadAndTypingIndicator('wamid.1', STUB_USER);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('calls fetch when userId does not match the prefix', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(mockResponse({ status: 200 }));
      global.fetch = fetchSpy as never;
      await sendReadAndTypingIndicator('wamid.1', REAL_USER);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('calls fetch when userId is omitted (no stub gate possible)', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(mockResponse({ status: 200 }));
      global.fetch = fetchSpy as never;
      await sendReadAndTypingIndicator('wamid.1');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('calls fetch when LOAD_TEST_PHONE_PREFIX is unset, even for matching-looking userId', async () => {
      delete process.env.LOAD_TEST_PHONE_PREFIX;
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(mockResponse({ status: 200 }));
      global.fetch = fetchSpy as never;
      await sendReadAndTypingIndicator('wamid.1', STUB_USER);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('calls fetch when LOAD_TEST_PHONE_PREFIX is empty', async () => {
      process.env.LOAD_TEST_PHONE_PREFIX = '';
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(mockResponse({ status: 200 }));
      global.fetch = fetchSpy as never;
      await sendReadAndTypingIndicator('wamid.1', STUB_USER);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('sendMessage (consecutive=true)', () => {
    const baseOpts = {
      wamid: 'wamid.1',
      consecutive: true as const,
      media: [{ type: 'text' as const, body: 'hi' }],
    };

    it('short-circuits sendSingleItem without calling fetch when user_id matches', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as never;
      const out = await sendMessage({ ...baseOpts, user_id: STUB_USER });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out).toEqual({ status: 200, body: { delivered: true } });
    });

    it('calls fetch when user_id does not match the prefix', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(mockResponse({ status: 200 }));
      global.fetch = fetchSpy as never;
      const out = await sendMessage({ ...baseOpts, user_id: REAL_USER });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(out.body.delivered).toBe(true);
    });
  });

  describe('sendMessage (consecutive=false)', () => {
    it('still runs CLAIM_LUA and only short-circuits the outbound HTTPS call', async () => {
      mockConnEval.mockResolvedValue(25_000);
      mockConnDel.mockResolvedValue(1);
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as never;
      const out = await sendMessage({
        user_id: STUB_USER,
        wamid: 'wamid.1',
        consecutive: false,
        media: [{ type: 'text', body: 'hi' }],
      });
      expect(mockConnEval).toHaveBeenCalledTimes(1);
      expect(mockConnDel).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out.body.delivered).toBe(true);
    });
  });

  describe('sendNotification', () => {
    it('returns delivered without calling fetch when user_id matches', async () => {
      const fetchSpy = jest.fn();
      global.fetch = fetchSpy as never;
      const out = await sendNotification({
        user_id: STUB_USER,
        media: [{ type: 'text', body: 'hi' }],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out).toEqual({ status: 200, delivered: true });
    });

    it('calls fetch when user_id does not match the prefix', async () => {
      const fetchSpy = jest
        .fn()
        .mockResolvedValue(mockResponse({ status: 200 }));
      global.fetch = fetchSpy as never;
      const out = await sendNotification({
        user_id: REAL_USER,
        media: [{ type: 'text', body: 'hi' }],
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(out.delivered).toBe(true);
    });
  });
});
