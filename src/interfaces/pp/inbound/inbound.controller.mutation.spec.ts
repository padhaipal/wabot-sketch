// Targeted Stryker mutation-killers for inbound.controller.ts.
// Pinpoints log strings, span name strings, extractHttpStatus boundaries,
// otel query-param JSON parse guard branches, response-body shapes.

import 'reflect-metadata';

const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockSpanEnd = jest.fn();
const mockStartSpan = jest.fn().mockReturnValue({
  setStatus: mockSpanSetStatus,
  recordException: mockSpanRecordException,
  end: mockSpanEnd,
});
const mockPropExtract = jest.fn().mockReturnValue('parent-ctx');
const mockTraceSetSpan = jest.fn().mockReturnValue('ctx-with-span');
const mockContextWith = jest.fn(async (_ctx: unknown, fn: () => unknown) =>
  fn(),
);

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({ startSpan: mockStartSpan }),
    setSpan: (...a: unknown[]) => mockTraceSetSpan(...a),
  },
  propagation: { extract: (...a: unknown[]) => mockPropExtract(...a) },
  context: {
    active: () => 'active-ctx',
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

import { Logger } from '@nestjs/common';
import { PpInboundController } from './inbound.controller';

function makeRes() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    headersSent: false,
    on: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

const carrier = { traceparent: 'tp' };
const ctrl = new PpInboundController();

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  warnSpy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  errorSpy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('sendMessage — log string + span name + status pass-through', () => {
  const validBody = {
    otel: { carrier },
    user_external_id: '919999990001',
    wamid: 'wamid.1',
    consecutive: false,
    media: [{ type: 'text', body: 'hi' }],
  };

  it('span name is exactly "pp-send-message"', async () => {
    const res = makeRes();
    mockWaSendMessage.mockResolvedValue({ status: 200, body: { ok: true } });
    await ctrl.sendMessage(validBody, res as never);
    expect(mockStartSpan).toHaveBeenCalledWith(
      'pp-send-message',
      undefined,
      'parent-ctx',
    );
  });

  it('validation rejection log starts with "SendMessage validation failed:"', async () => {
    const res = makeRes();
    await ctrl.sendMessage({}, res as never);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^SendMessage validation failed: /),
    );
  });

  it('error log starts with "sendMessage failed:" + the error message', async () => {
    const res = makeRes();
    mockWaSendMessage.mockRejectedValue(new Error('wa-boom'));
    await ctrl.sendMessage(validBody, res as never);
    expect(errorSpy).toHaveBeenCalledWith('sendMessage failed: wa-boom');
  });

  it('non-Error rejection: log uses String(error) and span message is String(error)', async () => {
    const res = makeRes();
    mockWaSendMessage.mockRejectedValue(42);
    await ctrl.sendMessage(validBody, res as never);
    expect(errorSpy).toHaveBeenCalledWith('sendMessage failed: 42');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({ code: 2, message: '42' });
  });

  it.each([100, 200, 202, 302, 404, 500])(
    'echoes result.status %i back to res.status (no remapping)',
    async (status) => {
      const res = makeRes();
      mockWaSendMessage.mockResolvedValue({ status, body: { x: 1 } });
      await ctrl.sendMessage(validBody, res as never);
      expect(res.status).toHaveBeenCalledWith(status);
    },
  );
});

describe('sendNotification — log strings + body pass-through', () => {
  const validBody = {
    user_external_id: '919999990001',
    media: [{ type: 'text', body: 'hi' }],
  };

  it('validation rejection log starts with "SendNotification validation failed:"', async () => {
    const res = makeRes();
    await ctrl.sendNotification({}, res as never);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^SendNotification validation failed: /),
    );
  });

  it('error log starts with "sendNotification failed:" + msg', async () => {
    const res = makeRes();
    mockWaSendNotification.mockRejectedValue(new Error('nf-down'));
    await ctrl.sendNotification(validBody, res as never);
    expect(errorSpy).toHaveBeenCalledWith('sendNotification failed: nf-down');
  });

  it('echoes the entire result object as body (not just .body)', async () => {
    const res = makeRes();
    const out = { status: 201, delivered: true, error_code: undefined };
    mockWaSendNotification.mockResolvedValue(out);
    await ctrl.sendNotification(validBody, res as never);
    expect(res.json).toHaveBeenCalledWith(out);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('downloadMedia — log + span name + extractHttpStatus boundaries', () => {
  const validBody = {
    otel: { carrier },
    media_url: 'https://wa/m/1',
  };

  it('span name is exactly "pp-download-media"', async () => {
    const res = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('boom'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(mockStartSpan).toHaveBeenCalledWith(
      'pp-download-media',
      undefined,
      'parent-ctx',
    );
  });

  it('validation rejection log starts with "DownloadMedia validation failed:"', async () => {
    const res = makeRes();
    await ctrl.downloadMedia({}, res as never);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^DownloadMedia validation failed: /),
    );
  });

  it('extractHttpStatus: error message embedding 404 → res.status(404)', async () => {
    const res = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('Media URL returned 404'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Download failed' });
  });

  it('extractHttpStatus: 599 (upper bound) → 599', async () => {
    const res = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('upstream 599 bad'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(599);
  });

  it('extractHttpStatus: 400 (lower bound) → 400', async () => {
    const res = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('upstream 400'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('extractHttpStatus: out-of-range code (399 / 700) → 500 fallback', async () => {
    const res1 = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('weird 399 thing'));
    await ctrl.downloadMedia(validBody, res1 as never);
    expect(res1.status).toHaveBeenCalledWith(500);

    const res2 = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('marker 700'));
    await ctrl.downloadMedia(validBody, res2 as never);
    expect(res2.status).toHaveBeenCalledWith(500);
  });

  it('extractHttpStatus: error with no 3-digit code → 500', async () => {
    const res = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('no number here'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('extractHttpStatus: non-Error throw → 500', async () => {
    const res = makeRes();
    mockWaDownloadMedia.mockRejectedValue('plain');
    await ctrl.downloadMedia(validBody, res as never);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('headersSent → skip the status/json write', async () => {
    const res = makeRes();
    res.headersSent = true;
    mockWaDownloadMedia.mockRejectedValue(new Error('boom 500'));
    await ctrl.downloadMedia(validBody, res as never);
    // status/json never invoked because headers already sent.
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('warn log starts with "downloadMedia failed:" + msg', async () => {
    const res = makeRes();
    mockWaDownloadMedia.mockRejectedValue(new Error('m-down'));
    await ctrl.downloadMedia(validBody, res as never);
    expect(warnSpy).toHaveBeenCalledWith('downloadMedia failed: m-down');
  });
});

describe('uploadMedia — guard ladder + otel JSON parse branches', () => {
  function makeReq(opts: { rawBody?: Buffer }) {
    return { rawBody: opts.rawBody } as unknown as Parameters<
      typeof ctrl.uploadMedia
    >[0];
  }

  it('rawBody not a Buffer → 400 + warn "rawBody is not a Buffer"', async () => {
    const res = makeRes();
    await ctrl.uploadMedia(
      makeReq({ rawBody: undefined }),
      'image/png',
      'image',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Raw body is required' });
    expect(warnSpy).toHaveBeenCalledWith(
      'uploadMedia rejecting: rawBody is not a Buffer',
    );
  });

  it('missing contentType → 400 with "Content-Type header is required"', async () => {
    const res = makeRes();
    await ctrl.uploadMedia(
      makeReq({ rawBody: Buffer.from('x') }),
      undefined,
      'image',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Content-Type header is required',
    });
  });

  it.each(['audio', 'video', 'image', 'sticker'])(
    'mediaType=%s is accepted by the guard',
    async (mediaType) => {
      const res = makeRes();
      mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/1' });
      await ctrl.uploadMedia(
        makeReq({ rawBody: Buffer.from('x') }),
        'image/png',
        mediaType,
        undefined,
        res as never,
      );
      expect(res.status).toHaveBeenCalledWith(200);
    },
  );

  it('invalid mediaType → 400 with the specific error message string', async () => {
    const res = makeRes();
    await ctrl.uploadMedia(
      makeReq({ rawBody: Buffer.from('x') }),
      'image/png',
      'gif',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'X-Media-Type header must be one of: audio, video, image, sticker',
    });
  });

  it('missing mediaType → 400 with the same message', async () => {
    const res = makeRes();
    await ctrl.uploadMedia(
      makeReq({ rawBody: Buffer.from('x') }),
      'image/png',
      undefined,
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('otel JSON parse: valid Record<string,string> → forwarded as carrier', async () => {
    const res = makeRes();
    mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/1' });
    await ctrl.uploadMedia(
      makeReq({ rawBody: Buffer.from('x') }),
      'image/png',
      'image',
      JSON.stringify({ traceparent: 'tp-xyz' }),
      res as never,
    );
    expect(mockPropExtract).toHaveBeenCalledWith('active-ctx', {
      traceparent: 'tp-xyz',
    });
  });

  it.each([
    ['null', JSON.stringify(null)],
    ['array', JSON.stringify(['a', 'b'])],
    ['record-with-non-string-value', JSON.stringify({ traceparent: 42 })],
    ['malformed-json', '{not-json'],
  ])(
    'otel JSON parse: %s → carrier defaults to empty object',
    async (_label, otelParam) => {
      const res = makeRes();
      mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/1' });
      await ctrl.uploadMedia(
        makeReq({ rawBody: Buffer.from('x') }),
        'image/png',
        'image',
        otelParam,
        res as never,
      );
      expect(mockPropExtract).toHaveBeenCalledWith('active-ctx', {});
    },
  );

  it('malformed otel JSON → warn "Failed to parse otel query parameter"', async () => {
    const res = makeRes();
    mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/1' });
    await ctrl.uploadMedia(
      makeReq({ rawBody: Buffer.from('x') }),
      'image/png',
      'image',
      '{not-json',
      res as never,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to parse otel query parameter',
    );
  });

  it('span name is exactly "pp-upload-media"', async () => {
    const res = makeRes();
    mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/1' });
    await ctrl.uploadMedia(
      makeReq({ rawBody: Buffer.from('x') }),
      'image/png',
      'image',
      undefined,
      res as never,
    );
    expect(mockStartSpan).toHaveBeenCalledWith(
      'pp-upload-media',
      undefined,
      'parent-ctx',
    );
  });

  it('happy path returns {wa_media_url} + status 200', async () => {
    const res = makeRes();
    mockWaUploadMedia.mockResolvedValue({ wa_media_url: 'wa://m/42' });
    await ctrl.uploadMedia(
      makeReq({ rawBody: Buffer.from('x') }),
      'image/png',
      'image',
      undefined,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ wa_media_url: 'wa://m/42' });
  });

  it('error log starts with "uploadMedia failed:" + msg + sets span ERROR', async () => {
    const res = makeRes();
    mockWaUploadMedia.mockRejectedValue(new Error('upload-down'));
    await ctrl.uploadMedia(
      makeReq({ rawBody: Buffer.from('x') }),
      'image/png',
      'image',
      undefined,
      res as never,
    );
    expect(errorSpy).toHaveBeenCalledWith('uploadMedia failed: upload-down');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'upload-down',
    });
  });
});
