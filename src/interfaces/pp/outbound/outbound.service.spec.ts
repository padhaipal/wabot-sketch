// sendMessage POSTs to PP's internal /wabot/inbound endpoint. We cover every
// branch: missing env (base URL, API key), 2xx success log, 4xx error log,
// 5xx error log, and fetch-reject (Error vs non-Error) returning 500.

import { Logger } from '@nestjs/common';
import { sendMessage } from './outbound.service';

const message = { id: 'wamid-1' } as unknown as Parameters<
  typeof sendMessage
>[0]['message'];
const otel = { traceparent: 'tp' } as unknown as Parameters<
  typeof sendMessage
>[0]['otel'];

describe('pp/outbound.sendMessage', () => {
  const ORIG_BASE = process.env.PP_INTERNAL_BASE_URL;
  const ORIG_KEY = process.env.PP_INTERNAL_API_KEY;
  let errorSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const globalFetch = global.fetch;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    process.env.PP_INTERNAL_BASE_URL = 'https://pp.test';
    process.env.PP_INTERNAL_API_KEY = 'wabot-badge';
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    global.fetch = globalFetch;
  });

  afterAll(() => {
    if (ORIG_BASE === undefined) delete process.env.PP_INTERNAL_BASE_URL;
    else process.env.PP_INTERNAL_BASE_URL = ORIG_BASE;
    if (ORIG_KEY === undefined) delete process.env.PP_INTERNAL_API_KEY;
    else process.env.PP_INTERNAL_API_KEY = ORIG_KEY;
  });

  function makeResponse(status: number): Response {
    return { status } as unknown as Response;
  }

  it('returns 500 + logs error when PP_INTERNAL_BASE_URL is missing', async () => {
    delete process.env.PP_INTERNAL_BASE_URL;
    const status = await sendMessage({ otel, message });
    expect(status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      'PP_INTERNAL_BASE_URL is not configured.',
    );
  });

  it('returns 500 + logs error (and never calls pp) when PP_INTERNAL_API_KEY is missing', async () => {
    delete process.env.PP_INTERNAL_API_KEY;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const status = await sendMessage({ otel, message });
    expect(status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      'PP_INTERNAL_API_KEY is not configured.',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs <baseUrl>/wabot/inbound with JSON Content-Type, the x-api-key badge + payload', async () => {
    const fetchSpy = jest.fn().mockResolvedValue(makeResponse(202));
    global.fetch = fetchSpy as never;
    await sendMessage({ otel, message, consecutive: true });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://pp.test/wabot/inbound',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'wabot-badge',
        },
        body: JSON.stringify({ otel, message, consecutive: true }),
      }),
    );
  });

  it('on 2xx (200, 202, 299): logs accept + returns the status', async () => {
    for (const status of [200, 202, 299]) {
      global.fetch = jest.fn().mockResolvedValue(makeResponse(status)) as never;
      const out = await sendMessage({ otel, message });
      expect(out).toBe(status);
    }
    expect(logSpy).toHaveBeenCalledWith('PP accepted message wamid-1');
  });

  it('on 4xx: logs error + returns the status', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse(404)) as never;
    expect(await sendMessage({ otel, message })).toBe(404);
    expect(errorSpy).toHaveBeenCalledWith(
      'PP returned 404 for message wamid-1',
    );
  });

  it('on 5xx (or unclassified ≥500): logs error + returns the status', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse(503)) as never;
    expect(await sendMessage({ otel, message })).toBe(503);
    expect(errorSpy).toHaveBeenCalledWith(
      'PP returned 503 for message wamid-1',
    );
  });

  it('on status 399 (boundary, neither 2xx nor 4xx) falls into the else branch', async () => {
    global.fetch = jest.fn().mockResolvedValue(makeResponse(399)) as never;
    expect(await sendMessage({ otel, message })).toBe(399);
    expect(errorSpy).toHaveBeenCalledWith(
      'PP returned 399 for message wamid-1',
    );
  });

  it('returns 500 + logs Error.message when fetch rejects with an Error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('econn')) as never;
    expect(await sendMessage({ otel, message })).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      'PP request failed for message wamid-1: econn',
    );
  });

  it('returns 500 + String()-s non-Error rejections', async () => {
    global.fetch = jest.fn().mockRejectedValue('plain-string') as never;
    expect(await sendMessage({ otel, message })).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      'PP request failed for message wamid-1: plain-string',
    );
  });
});
