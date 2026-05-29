// AcceptService: signature validation (HMAC-SHA256 with timing-safe compare)
// + ingest-queue enqueue with backoff retry. We mock the queues module so the
// constructor doesn't hit Redis, then capture the returned queue's add().

const mockQueueAdd = jest.fn();
jest.mock('../../../redis/queues', () => ({
  createQueue: jest.fn().mockReturnValue({ add: mockQueueAdd }),
  QUEUE_NAMES: { INGEST: 'ingest' },
}));

import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { AcceptService } from './accept.service';

const APP_SECRET = 'test-app-secret';

function sign(body: Buffer): string {
  return (
    'sha256=' +
    createHmac('sha256', APP_SECRET).update(body).digest('hex')
  );
}

describe('AcceptService.isValidSignature', () => {
  let svc: AcceptService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.META_APP_SECRET = APP_SECRET;
    svc = new AcceptService();
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.META_APP_SECRET;
  });

  it('valid header + body → true', () => {
    const body = Buffer.from('{"x":1}');
    expect(svc.isValidSignature(sign(body), body)).toBe(true);
  });

  it('returns false + warns when signatureHeader is undefined', () => {
    expect(svc.isValidSignature(undefined, Buffer.from('p'))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'isValidSignature(): invalid parameter data type.',
    );
  });

  it('returns false + warns when rawBody is not a Buffer', () => {
    // TypeScript can't catch this at runtime; the guard does.
    expect(
      svc.isValidSignature('sha256=00', 'not-a-buffer' as unknown as Buffer),
    ).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'isValidSignature(): invalid parameter data type.',
    );
  });

  it('returns false + warns when META_APP_SECRET is unset', () => {
    delete process.env.META_APP_SECRET;
    expect(svc.isValidSignature('sha256=00', Buffer.from('p'))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith('META_APP_SECRET is not configured.');
  });

  it('rejects when the signature is missing the "sha256=" prefix', () => {
    expect(svc.isValidSignature('hmac=deadbeef', Buffer.from('p'))).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'X-Hub-Signature-256 missing sha256= prefix.',
    );
  });

  it('rejects when the digest is not exactly 64 hex chars', () => {
    expect(svc.isValidSignature('sha256=tooshort', Buffer.from('p'))).toBe(
      false,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'X-Hub-Signature-256 digest is malformed.',
    );
  });

  it('rejects same-length-but-wrong digest with the timing-safe branch', () => {
    const body = Buffer.from('hello');
    const correct = sign(body);
    // Flip the last character to keep length the same but break the digest.
    const wrong = correct.slice(0, -1) + (correct.endsWith('0') ? '1' : '0');
    expect(svc.isValidSignature(wrong, body)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      'X-Hub-Signature-256 validation failed.',
    );
  });
});

describe('AcceptService.receiveWebhook', () => {
  let svc: AcceptService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.META_APP_SECRET = APP_SECRET;
    svc = new AcceptService();
    mockQueueAdd.mockReset();
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('happy path: enqueues on "webhook" with {otel.carrier, body} and returns 200', async () => {
    mockQueueAdd.mockResolvedValue({ id: 'job-1' });
    const out = await svc.receiveWebhook(
      { entries: [] },
      { traceparent: 'tp' },
    );
    expect(out).toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledWith('webhook', {
      otel: { carrier: { traceparent: 'tp' } },
      body: { entries: [] },
    });
    expect(logSpy).toHaveBeenCalledWith('Job enqueued on ingest queue');
  });

  it('retries with exponential backoff (capped at 5s) when add() fails, then succeeds', async () => {
    mockQueueAdd
      .mockRejectedValueOnce(new Error('boom-1'))
      .mockRejectedValueOnce(new Error('boom-2'))
      .mockResolvedValueOnce({ id: 'job' });
    const p = svc.receiveWebhook({}, {});
    // After first failure: warn + wait 500ms
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(
      'Enqueue attempt failed, retrying in 500ms',
    );
    await jest.advanceTimersByTimeAsync(500);
    // After second failure: warn + wait 1000ms (capped doubling)
    expect(warnSpy).toHaveBeenCalledWith(
      'Enqueue attempt failed, retrying in 1000ms',
    );
    await jest.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(200);
    expect(mockQueueAdd).toHaveBeenCalledTimes(3);
  });

  it('gives up + returns 500 after the 10s deadline elapses, logging the last error', async () => {
    mockQueueAdd.mockRejectedValue(new Error('persistent'));
    // Pin the clock so we can step "remaining" predictably.
    const start = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(start);
    const p = svc.receiveWebhook({}, {});
    // Walk the retry loop forward until remaining <= delay → gives up.
    // 500, 1000, 2000, 4000 = 7500ms total wait, next delay would be 5000
    // (capped). Push Date.now forward each iteration to simulate elapsed time.
    let now = start;
    for (let i = 0; i < 6; i++) {
      now += 2_500;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      await jest.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
    }
    await expect(p).resolves.toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Failed to enqueue ingest job after retries: persistent$/,
      ),
    );
  });

  it('non-Error rejection is String()-d in the final error log', async () => {
    mockQueueAdd.mockRejectedValue('plain-string-error');
    const start = 1_000_000;
    let now = start;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const p = svc.receiveWebhook({}, {});
    for (let i = 0; i < 6; i++) {
      now += 2_500;
      await jest.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();
    }
    await expect(p).resolves.toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to enqueue ingest job after retries: plain-string-error',
    );
  });
});
