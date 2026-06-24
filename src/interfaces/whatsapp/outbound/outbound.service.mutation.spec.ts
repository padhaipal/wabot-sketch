// Targeted Stryker mutation-killers for outbound.service.ts. The existing
// unit spec covers behavior; this spec asserts on specific log strings,
// fetch URLs/headers, retry timings, and the sendSingleItem 5XX→2XX backoff
// loop so string-literal / conditional / arithmetic mutants get caught.

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
  buildE2eAttributes: (outcome: string) => ({ outcome, load_test: 'false' }),
}));

import { Logger } from '@nestjs/common';
import {
  CLAIM_LUA,
  sendReadAndTypingIndicator,
  sendMessage,
  sendNotification,
  uploadMedia,
} from './outbound.service';

const globalFetch = global.fetch;

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

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBaggage.mockReturnValue(undefined);
});
afterEach(() => {
  global.fetch = globalFetch;
});

describe('graphUrl + authHeaders', () => {
  it('builds the exact v21.0 messages URL and Bearer + JSON headers', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    await sendReadAndTypingIndicator('wamid.1');
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/test-phone-id/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('CLAIM_LUA', () => {
  it('is a non-empty string passed as the eval script', async () => {
    expect(CLAIM_LUA).toMatch(/EXISTS/);
    expect(CLAIM_LUA).toMatch(/PTTL/);
    expect(CLAIM_LUA).toMatch(/DEL/);
    mockConnEval.mockResolvedValue(25_000);
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200 })) as never;
    mockConnDel.mockResolvedValue(1);
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    const evalCall = mockConnEval.mock.calls[0] as unknown[];
    expect(evalCall[0]).toBe(CLAIM_LUA);
    expect(evalCall[1]).toBe(2);
    expect(evalCall[2]).toMatch(/inflight:user-id:919999990001:wamid:wamid\.1/);
    expect(evalCall[3]).toMatch(/consecutive-check:user-id:919999990001/);
  });
});

describe('sendSingleItem retry loop (5XX → eventual 2XX)', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('retries on 5XX with 500ms backoff, doubling, then returns on 2XX', async () => {
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 502 }))
      .mockResolvedValueOnce(mockResponse({ status: 503 }))
      .mockResolvedValueOnce(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    const p = sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: true,
      media: [{ type: 'text', body: 'hi' }],
    });
    // Advance through backoff: 500ms after 1st failure, 1000ms after 2nd
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(1000);
    const out = await p;
    expect(out.body.delivered).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WhatsApp returned 502, retrying in 500ms'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WhatsApp returned 503, retrying in 1000ms'),
    );
  });

  it('gives up after deadline, logs the 5XX-persisted error, returns 5XX', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(mockResponse({ status: 502 }));
    global.fetch = fetchSpy as never;
    // Pin Date.now: first call = T, every later call past deadline
    const T = 1_000_000;
    let calls = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      return calls === 1 ? T : T + 10_000; // 5s deadline → exceeded
    });
    const out = await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: true,
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(out.status).toBe(502);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('WhatsApp 5XX persisted after retries for user'),
    );
  });
});

describe('safeReadErrorBody — JSON path + sanitization', () => {
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    mockConnEval.mockResolvedValue(25_000);
    mockConnSet.mockResolvedValue('OK');
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('extracts {code,type,error_subcode,fbtrace_id,message} and sanitizes phone/email', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 400,
        text: JSON.stringify({
          error: {
            code: 131_026,
            type: 'OAuthException',
            error_subcode: 2_018_278,
            fbtrace_id: 'trace-XYZ',
            message:
              'Cannot deliver to +919999990001 because user@example.com is blocked',
          },
        }),
      }),
    ) as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    const logged = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('WhatsApp returned 400'));
    expect(logged).toBeDefined();
    const json = logged!.slice(logged!.indexOf('{'));
    expect(json).toContain('"code":131026');
    expect(json).toContain('"type":"OAuthException"');
    expect(json).toContain('"error_subcode":2018278');
    expect(json).toContain('"fbtrace_id":"trace-XYZ"');
    expect(json).toContain('[REDACTED_PHONE]');
    expect(json).toContain('[REDACTED_EMAIL]');
    expect(json).not.toContain('+919999990001');
    expect(json).not.toContain('user@example.com');
  });

  it('non-JSON body → falls back to sanitized text (phone redacted in plain text)', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 400,
        text: 'plain text 919999990001 fail user@x.io',
      }),
    ) as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    const logged = errorSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('WhatsApp returned 400'));
    expect(logged).toContain('[REDACTED_PHONE]');
    expect(logged).toContain('[REDACTED_EMAIL]');
  });
});

describe('sendFallbackRaw / sendFallbackWithRetry', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    mockConnEval.mockResolvedValue(25_000);
    mockConnSet
      .mockRejectedValueOnce(new Error('redis-1'))
      .mockRejectedValueOnce(new Error('redis-2'));
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
  });

  it('no FALL_BACK env → logs error + does not call fetch for fallback', async () => {
    delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }));
    global.fetch = fetchSpy as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'FALL_BACK_MESSAGE_PUBLIC_URL not configured — cannot send fallback',
      ),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the original send
  });

  it('fallback URL ending in .mp3 → type=audio in WA payload', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/x.mp3';
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }))
      .mockResolvedValueOnce(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    const fallbackBody = JSON.parse(
      (fetchSpy.mock.calls[1][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(fallbackBody.type).toBe('audio');
    expect(fallbackBody.audio).toEqual({ link: 'https://cdn/x.mp3' });
  });

  it('fallback URL ending in .mp4 → type=video in WA payload', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/x.mp4';
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }))
      .mockResolvedValueOnce(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    const fallbackBody = JSON.parse(
      (fetchSpy.mock.calls[1][1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(fallbackBody.type).toBe('video');
    expect(fallbackBody.video).toEqual({ link: 'https://cdn/x.mp4' });
  });

  it.each(['.ogg', '.opus', '.aac', '.m4a'])(
    'fallback URL ending in %s → type=audio',
    async (ext) => {
      process.env.FALL_BACK_MESSAGE_PUBLIC_URL = `https://cdn/x${ext}`;
      const fetchSpy = jest
        .fn()
        .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }))
        .mockResolvedValueOnce(mockResponse({ status: 200 }));
      global.fetch = fetchSpy as never;
      await sendMessage({
        user_id: '919999990001',
        wamid: 'wamid.1',
        consecutive: false,
        media: [{ type: 'text', body: 'hi' }],
      });
      const fallbackBody = JSON.parse(
        (fetchSpy.mock.calls[1][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      expect(fallbackBody.type).toBe('audio');
    },
  );

  it('fallback non-2xx → warns with status + sanitized error body, returns false (triggers 2nd attempt)', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/x.mp3';
    jest.useFakeTimers();
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' })) // original
      .mockResolvedValueOnce(
        mockResponse({
          status: 500,
          text: JSON.stringify({ error: { message: 'fail' } }),
        }),
      ) // fallback 1st attempt
      .mockResolvedValueOnce(mockResponse({ status: 200 })); // fallback 2nd attempt
    global.fetch = fetchSpy as never;
    const p = sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    await jest.advanceTimersByTimeAsync(1000); // the 1s retry wait
    await p;
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fallback returned 500 for user'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fallback delivered (2nd attempt)'),
    );
    jest.useRealTimers();
  });

  it('fallback fetch throws → warns "Fallback threw" + returns false; both attempts throwing → final error log', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/x.mp4';
    jest.useFakeTimers();
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }))
      .mockRejectedValueOnce(new Error('net-down-1'))
      .mockRejectedValueOnce(new Error('net-down-2'));
    global.fetch = fetchSpy as never;
    const p = sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    await jest.advanceTimersByTimeAsync(1000);
    await p;
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fallback threw for user'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Fallback failed twice for user'),
    );
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes('giving up')),
    ).toBe(true);
    jest.useRealTimers();
  });
});

describe('recreateInflightWithRetry', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockConnEval.mockResolvedValue(25_000);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
  });

  it('1st recreate fails, 2nd succeeds → warns once, no fallback', async () => {
    mockConnSet
      .mockRejectedValueOnce(new Error('redis-down-1'))
      .mockResolvedValueOnce('OK');
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }));
    global.fetch = fetchSpy as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Inflight recreate failed (1st attempt) for user',
      ),
    );
    expect(mockConnSet).toHaveBeenCalledTimes(2);
    // No fallback was triggered: only the original fetch ran.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('both recreate attempts fail → errors with "2nd attempt" + falls through', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/x.mp3';
    mockConnSet
      .mockRejectedValueOnce(new Error('redis-down-1'))
      .mockRejectedValueOnce(new Error('redis-down-2'));
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }))
      .mockResolvedValueOnce(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Inflight recreate failed (2nd attempt) for user',
      ),
    );
  });

  it('TTL exhausted → warns with elapsed/original ms + skips recreate', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/x.mp3';
    const T = 1_000_000;
    let nowCalls = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1;
      // Each subsequent call is way past claimAtMs + claimedTtlMs (25_000)
      return nowCalls === 1 ? T : T + 60_000;
    });
    const fetchSpy = jest
      .fn()
      .mockResolvedValueOnce(mockResponse({ status: 400, text: '{}' }))
      .mockResolvedValueOnce(mockResponse({ status: 200 }));
    global.fetch = fetchSpy as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Inflight TTL exhausted by WA round-trip \(elapsed=\d+ms, original=25000ms\)/,
      ),
    );
    // recreate was skipped: connection.set was not called for inflight recreation.
    expect(mockConnSet).not.toHaveBeenCalled();
  });
});

describe('deleteConsecutiveWithRetry', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockConnEval.mockResolvedValue(25_000);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('1st DEL fails, 2nd succeeds → warns once, no error log', async () => {
    mockConnDel
      .mockRejectedValueOnce(new Error('redis-1'))
      .mockResolvedValueOnce(1);
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200 })) as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Consec delete failed (1st attempt) for user'),
    );
    expect(
      errorSpy.mock.calls.some((c) => String(c[0]).includes('Consec delete')),
    ).toBe(false);
  });

  it('both DELs fail → errors with "2nd attempt" + giving up', async () => {
    mockConnDel
      .mockRejectedValueOnce(new Error('redis-1'))
      .mockRejectedValueOnce(new Error('redis-2'));
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockResponse({ status: 200 })) as never;
    await sendMessage({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Consec delete failed (2nd attempt) for user'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('giving up (TTL will expire)'),
    );
  });
});

describe('sendNotification — extra log shape', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('130429 → warn includes the literal "WhatsApp rate-limit (130429)" tag', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 400,
        json: { error: { code: 130_429, message: 'rl' } },
      }),
    ) as never;
    await sendNotification({
      user_id: '919999990001',
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WhatsApp rate-limit (130429)'),
    );
  });

  it('131047 → error includes "outside 24-hour window (131047)"', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 400,
        json: { error: { code: 131_047, message: 'oo' } },
      }),
    ) as never;
    await sendNotification({
      user_id: '919999990001',
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('outside 24-hour window (131047)'),
    );
  });

  it('other error code → error includes "for notification to user" + message', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockResponse({
        status: 500,
        json: { error: { code: 99, message: 'down' } },
      }),
    ) as never;
    await sendNotification({
      user_id: '919999990001',
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /WhatsApp returned 500 for notification to user .* down/,
      ),
    );
  });

  it('non-JSON error body → error message uses "unknown"', async () => {
    const fakeResponse = {
      status: 500,
      ok: false,
      json: jest.fn().mockRejectedValue(new Error('not json')),
    } as unknown as Response;
    global.fetch = jest.fn().mockResolvedValue(fakeResponse) as never;
    await sendNotification({
      user_id: '919999990001',
      media: [{ type: 'text', body: 'hi' }],
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('unknown'));
  });
});

describe('uploadMedia URL + headers', () => {
  it('POSTs to /v21.0/<PHONE_NUMBER_ID>/media with Bearer-only headers (no Content-Type — FormData sets it)', async () => {
    const fetchSpy = jest
      .fn()
      .mockResolvedValue(
        mockResponse({ status: 200, json: { id: 'wa://m/1' } }),
      );
    global.fetch = fetchSpy as never;
    await uploadMedia({
      data: Buffer.from('x'),
      content_type: 'image/png',
      media_type: 'image',
    });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/test-phone-id/media');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-token');
    // Content-Type intentionally omitted so the FormData boundary header wins.
    expect(headers['Content-Type']).toBeUndefined();
  });
});
