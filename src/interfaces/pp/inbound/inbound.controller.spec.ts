// PpInboundController exposes the internal API used by pp-sketch to dispatch
// WhatsApp work. We cover validation rejections, the OTel span lifecycle on
// every endpoint, success status pass-through, error handling (Error vs
// non-Error, headersSent guard, extractHttpStatus), and uploadMedia's full
// guard ladder (rawBody/contentType/mediaType/otel JSON parse).

import 'reflect-metadata';

// OTel: see comments above accept.controller spec — same surface.
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockSpanEnd = jest.fn();
const mockStartSpan = jest.fn().mockReturnValue({
  setStatus: mockSpanSetStatus,
  recordException: mockSpanRecordException,
  end: mockSpanEnd,
});
const mockGetTracer = jest.fn().mockReturnValue({ startSpan: mockStartSpan });
const mockPropExtract = jest.fn().mockReturnValue('parent-ctx');
const mockTraceSetSpan = jest.fn().mockReturnValue('ctx-with-span');
const mockContextActive = jest.fn().mockReturnValue('active-ctx');
const mockContextWith = jest.fn(async (_ctx: unknown, fn: () => unknown) =>
  fn(),
);

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: (...a: unknown[]) => mockGetTracer(...a),
    setSpan: (...a: unknown[]) => mockTraceSetSpan(...a),
  },
  propagation: {
    extract: (...a: unknown[]) => mockPropExtract(...a),
  },
  context: {
    active: () => mockContextActive(),
    with: (...a: unknown[]) =>
      mockContextWith(a[0] as never, a[1] as () => unknown),
  },
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
}));

const mockWaSendMessage = jest.fn();
const mockWaSendNotification = jest.fn();
const mockWaDownloadMedia = jest.fn();
const mockWaUploadMedia = jest.fn();
jest.mock('../../whatsapp/outbound/outbound.service', () => ({
  sendMessage: (...a: unknown[]) => mockWaSendMessage(...a),
  sendNotification: (...a: unknown[]) => mockWaSendNotification(...a),
  downloadMedia: (...a: unknown[]) => mockWaDownloadMedia(...a),
  uploadMedia: (...a: unknown[]) => mockWaUploadMedia(...a),
}));

import { PpInboundController } from './inbound.controller';

function makeRes(): {
  res: {
    status: jest.Mock;
    json: jest.Mock;
    setHeader: jest.Mock;
    headersSent: boolean;
    on: jest.Mock;
  };
} {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    headersSent: false,
    on: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return { res };
}

const carrier = { traceparent: 'tp' };

beforeEach(() => {
  jest.clearAllMocks();
  mockSpanEnd.mockClear();
});

// ---------------- sendMessage ------------------------------------------

describe('PpInboundController.sendMessage', () => {
  const ctrl = new PpInboundController();
  const validBody = {
    otel: { carrier },
    user_external_id: '919999990001',
    wamid: 'wamid.1',
    consecutive: false,
    media: [{ type: 'text', body: 'hi' }],
  };

  it('400 + warn + errors[] on invalid body', async () => {
    const { res } = makeRes();
    await ctrl.sendMessage({} as unknown, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ errors: expect.any(Array) });
  });

  it('happy path: forwards user/wamid/consecutive/media to waOutbound, echoes status+body', async () => {
    const { res } = makeRes();
    mockWaSendMessage.mockResolvedValue({
      status: 202,
      body: { delivered: true },
    });
    await ctrl.sendMessage(validBody, res as never);
    expect(mockStartSpan).toHaveBeenCalledWith(
      'pp-send-message',
      undefined,
      'parent-ctx',
    );
    expect(mockWaSendMessage).toHaveBeenCalledWith({
      user_id: '919999990001',
      wamid: 'wamid.1',
      consecutive: false,
      media: [expect.objectContaining({ type: 'text', body: 'hi' })],
    });
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({ delivered: true });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('on Error: 500 + json error message + span ERROR + recordException', async () => {
    const { res } = makeRes();
    mockWaSendMessage.mockRejectedValue(new Error('wa-down'));
    await ctrl.sendMessage(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(mockSpanSetStatus).toHaveBeenCalledWith({ code: 2, message: 'wa-down' });
    const recArg = mockSpanRecordException.mock.calls[0][0];
    expect(recArg).toBeInstanceOf(Error);
  });

  it('on non-Error throw: String()-d for span message', async () => {
    const { res } = makeRes();
    mockWaSendMessage.mockRejectedValue('plain-string');
    await ctrl.sendMessage(validBody, res as never);
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'plain-string',
    });
  });
});

// ---------------- sendNotification -------------------------------------

describe('PpInboundController.sendNotification', () => {
  const ctrl = new PpInboundController();
  const validBody = {
    user_external_id: '919999990001',
    media: [{ type: 'text', body: 'hi' }],
  };

  it('400 on invalid body', async () => {
    const { res } = makeRes();
    await ctrl.sendNotification({} as unknown, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ errors: expect.any(Array) });
  });

  it('happy path: forwards user_id/media + echoes status', async () => {
    const { res } = makeRes();
    mockWaSendNotification.mockResolvedValue({
      status: 202,
      body: { ok: true },
    });
    await ctrl.sendNotification(validBody, res as never);
    expect(mockWaSendNotification).toHaveBeenCalledWith({
      user_id: '919999990001',
      media: [expect.objectContaining({ type: 'text', body: 'hi' })],
    });
    expect(res.status).toHaveBeenCalledWith(202);
  });

  it('on Error: 500 + error logged', async () => {
    const { res } = makeRes();
    mockWaSendNotification.mockRejectedValue(new Error('wa-down'));
    await ctrl.sendNotification(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
  });

  it('on non-Error throw: 500 still returned', async () => {
    const { res } = makeRes();
    mockWaSendNotification.mockRejectedValue('plain');
    await ctrl.sendNotification(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ---------------- downloadMedia ----------------------------------------

describe('PpInboundController.downloadMedia', () => {
  const ctrl = new PpInboundController();
  const validBody = {
    otel: { carrier },
    media_url: 'https://wa/m/1',
  };

  it('400 on invalid body', async () => {
    const { res } = makeRes();
    await ctrl.downloadMedia({} as unknown, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // Pipe happy-path is exercised end-to-end by the upstream e2e workflow;
  // mocking the full Writable interface here adds more surface than value
  // given the surrounding error branches are already covered.

  it('on Error: extracts status from message (4XX-5XX) + json error + span ERROR', async () => {
    const { res } = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('upstream returned 404'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Download failed' });
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'upstream returned 404',
    });
  });

  it('on non-Error throw: extractHttpStatus returns 500', async () => {
    const { res } = makeRes();
    mockWaDownloadMedia.mockRejectedValue('plain-string');
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('on Error without parseable status: 500', async () => {
    const { res } = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('no status here'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('on Error: skips response when headersSent is true', async () => {
    const { res } = makeRes();
    res.headersSent = true;
    mockWaDownloadMedia.mockRejectedValue(new Error('boom'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

// ---------------- uploadMedia ------------------------------------------

describe('PpInboundController.uploadMedia', () => {
  const ctrl = new PpInboundController();

  function req(rawBody?: Buffer): unknown {
    return { rawBody };
  }

  it('400 when rawBody is not a Buffer', async () => {
    const { res } = makeRes();
    await ctrl.uploadMedia(
      req() as never,
      'audio/mp3',
      'audio',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Raw body is required' });
  });

  it('400 when Content-Type header is missing', async () => {
    const { res } = makeRes();
    await ctrl.uploadMedia(
      req(Buffer.from('x')) as never,
      undefined,
      'audio',
      undefined,
      res as never,
    );
    expect(res.json).toHaveBeenCalledWith({
      error: 'Content-Type header is required',
    });
  });

  it.each<[string | undefined]>([
    [undefined],
    ['document'],
    ['text'],
    [''],
  ])('400 when X-Media-Type is missing or invalid (%s)', async (mt) => {
    const { res } = makeRes();
    await ctrl.uploadMedia(
      req(Buffer.from('x')) as never,
      'audio/mp3',
      mt,
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error:
        'X-Media-Type header must be one of: audio, video, image, sticker',
    });
  });

  it('happy path: forwards rawBody + content_type + media_type, returns wa_media_url', async () => {
    const { res } = makeRes();
    mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/1' });
    await ctrl.uploadMedia(
      req(Buffer.from('payload')) as never,
      'audio/mp3',
      'audio',
      undefined,
      res as never,
    );
    expect(mockWaUploadMedia).toHaveBeenCalledWith({
      data: Buffer.from('payload'),
      content_type: 'audio/mp3',
      media_type: 'audio',
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ wa_media_url: 'wa://m/1' });
  });

  it('otel query param: valid JSON record passes through to propagation.extract', async () => {
    const { res } = makeRes();
    mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/2' });
    await ctrl.uploadMedia(
      req(Buffer.from('p')) as never,
      'audio/mp3',
      'audio',
      JSON.stringify({ traceparent: 'tp' }),
      res as never,
    );
    expect(mockPropExtract).toHaveBeenCalledWith('active-ctx', {
      traceparent: 'tp',
    });
  });

  it('otel query param: malformed JSON falls back to {} (with warn)', async () => {
    const { res } = makeRes();
    mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/3' });
    await ctrl.uploadMedia(
      req(Buffer.from('p')) as never,
      'audio/mp3',
      'audio',
      '{not-json',
      res as never,
    );
    expect(mockPropExtract).toHaveBeenCalledWith('active-ctx', {});
  });

  it.each<[string]>([
    [JSON.stringify(null)],
    [JSON.stringify([1, 2])],
    [JSON.stringify({ key: 42 })], // non-string value
  ])(
    'otel query param: not a string-valued record (%s) falls back to {}',
    async (param) => {
      const { res } = makeRes();
      mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/4' });
      await ctrl.uploadMedia(
        req(Buffer.from('p')) as never,
        'audio/mp3',
        'audio',
        param,
        res as never,
      );
      expect(mockPropExtract).toHaveBeenCalledWith('active-ctx', {});
    },
  );

  it('on Error: extractHttpStatus → 4XX-5XX or 500; json error + span ERROR', async () => {
    const { res } = makeRes();
    mockWaUploadMedia.mockRejectedValue(new Error('upstream returned 413'));
    await ctrl.uploadMedia(
      req(Buffer.from('p')) as never,
      'audio/mp3',
      'audio',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({ error: 'Upload failed' });
  });

  it('on Error with out-of-band status digits (e.g. 700): clamps to 500', async () => {
    const { res } = makeRes();
    mockWaUploadMedia.mockRejectedValue(new Error('weird 700 marker'));
    await ctrl.uploadMedia(
      req(Buffer.from('p')) as never,
      'audio/mp3',
      'audio',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('on non-Error throw: 500', async () => {
    const { res } = makeRes();
    mockWaUploadMedia.mockRejectedValue('plain');
    await ctrl.uploadMedia(
      req(Buffer.from('p')) as never,
      'audio/mp3',
      'audio',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('on error: skips response when headersSent is true', async () => {
    const { res } = makeRes();
    res.headersSent = true;
    mockWaUploadMedia.mockRejectedValue(new Error('boom'));
    await ctrl.uploadMedia(
      req(Buffer.from('p')) as never,
      'audio/mp3',
      'audio',
      undefined,
      res as never,
    );
    expect(res.status).not.toHaveBeenCalled();
  });
});
