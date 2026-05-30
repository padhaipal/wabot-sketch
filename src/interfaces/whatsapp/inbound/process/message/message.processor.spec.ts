// processMessage and processMessageTimeout cover the WhatsApp ingestion path.
// We mock every collaborator (Redis, BullMQ queues, OTel, outbound services,
// metrics) and exercise each guard / retry / fallback / span branch.

import 'reflect-metadata';

// --- OTel mocks ---------------------------------------------------------
const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockSpanEnd = jest.fn();
const fakeSpan = {
  setAttribute: mockSpanSetAttribute,
  setStatus: mockSpanSetStatus,
  recordException: mockSpanRecordException,
  end: mockSpanEnd,
};
const mockStartSpan = jest.fn().mockReturnValue(fakeSpan);
const mockGetTracer = jest.fn().mockReturnValue({ startSpan: mockStartSpan });

const mockPropExtract = jest.fn().mockReturnValue('parent-ctx');
const mockPropInject = jest.fn();
const mockPropGetBaggage = jest.fn().mockReturnValue(undefined);
const mockPropCreateBaggage = jest.fn();
const mockPropSetBaggage = jest.fn().mockReturnValue('ctx-with-baggage');

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
    inject: (...a: unknown[]) => mockPropInject(...a),
    getBaggage: (...a: unknown[]) => mockPropGetBaggage(...a),
    createBaggage: (...a: unknown[]) => mockPropCreateBaggage(...a),
    setBaggage: (...a: unknown[]) => mockPropSetBaggage(...a),
  },
  context: {
    active: () => mockContextActive(),
    with: (...a: unknown[]) =>
      mockContextWith(a[0] as never, a[1] as () => unknown),
  },
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
}));

// --- Outbound + helper mocks --------------------------------------------
const mockConnSet = jest.fn();
const mockConnEval = jest.fn();
const mockTimeoutAdd = jest.fn();
jest.mock('../../../../redis/queues', () => ({
  connection: { set: mockConnSet, eval: mockConnEval },
  createQueue: jest.fn().mockReturnValue({ add: mockTimeoutAdd }),
  QUEUE_NAMES: { PROCESS_MESSAGE_TIMEOUT: 'process-message-timeout' },
}));

const mockWaSendMessage = jest.fn();
const mockWaSendReadAndTyping = jest.fn().mockResolvedValue(undefined);
jest.mock('../../../outbound/outbound.service', () => ({
  sendMessage: (...a: unknown[]) => mockWaSendMessage(...a),
  sendReadAndTypingIndicator: (...a: unknown[]) =>
    mockWaSendReadAndTyping(...a),
}));

const mockPpSendMessage = jest.fn();
jest.mock('../../../../pp/outbound/outbound.service', () => ({
  sendMessage: (...a: unknown[]) => mockPpSendMessage(...a),
}));

const mockMetricsRecord = jest.fn();
jest.mock('../../../../../otel/metrics', () => ({
  messageE2eDuration: { record: mockMetricsRecord },
}));

jest.mock('../../../../../otel/pii', () => ({
  toLogId: (s: string) => `u_${s.slice(0, 4)}`,
}));

// --- Real imports under test --------------------------------------------
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { processMessage, processMessageTimeout } from './message.processor';

function makeJob(data: unknown, id = 'msg-job-1'): Job {
  return { id, data } as unknown as Job;
}

const validMessage = {
  from: '919999990001',
  id: 'wamid.1',
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hi' },
};

const validJobData = {
  otel: { carrier: { traceparent: 'tp' } },
  message: validMessage,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPropExtract.mockReturnValue('parent-ctx');
  mockPropGetBaggage.mockReturnValue({
    setEntry: jest.fn().mockReturnThis(),
  });
  mockPropCreateBaggage.mockReturnValue({
    setEntry: jest.fn().mockReturnThis(),
  });
  mockTraceSetSpan.mockReturnValue('ctx-with-span');
  mockPropSetBaggage.mockReturnValue('ctx-with-baggage');
  mockStartSpan.mockReturnValue(fakeSpan);
  mockContextWith.mockImplementation(async (_ctx, fn) =>
    (fn as () => unknown)(),
  );
  process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/fallback.mp3';
});

afterEach(() => {
  delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
  jest.useRealTimers();
});

describe('processMessage — happy path', () => {
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockConnSet.mockResolvedValue('OK'); // dedupe new
    mockConnEval.mockResolvedValue(0); // consecutive: false
    mockTimeoutAdd.mockResolvedValue({ id: 'timeout-1' });
    mockPpSendMessage.mockResolvedValue(200);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('end-to-end with PP 2xx: dedupes, enqueues timeout, sends read receipt, calls PP, records success metric', async () => {
    await processMessage(makeJob(validJobData));
    expect(mockStartSpan).toHaveBeenCalledWith(
      'process-message',
      {},
      'parent-ctx',
    );
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('wamid', 'wamid.1');
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('message.type', 'text');
    expect(mockConnSet).toHaveBeenCalled(); // dedupe
    expect(mockWaSendReadAndTyping).toHaveBeenCalledWith('wamid.1');
    expect(mockTimeoutAdd).toHaveBeenCalled();
    expect(mockConnEval).toHaveBeenCalled(); // consecutive
    expect(mockPpSendMessage).toHaveBeenCalledWith({
      otel: { carrier: expect.any(Object) },
      message: expect.objectContaining({ id: 'wamid.1' }),
      consecutive: false,
    });
    expect(mockMetricsRecord).toHaveBeenCalledWith(expect.any(Number), {
      outcome: 'success',
    });
    expect(logSpy).toHaveBeenCalledWith(
      'PP accepted message wamid=wamid.1, status=200',
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('consecutive=true when CONSECUTIVE_CHECK_LUA returns 1', async () => {
    mockConnEval.mockResolvedValue(1);
    await processMessage(makeJob(validJobData));
    expect(mockPpSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ consecutive: true }),
    );
  });

  it('uses getBaggage when one already exists, otherwise creates a fresh one', async () => {
    // (a) existing baggage path is the default mock above.
    await processMessage(makeJob(validJobData));
    expect(mockPropGetBaggage).toHaveBeenCalled();

    // (b) no existing baggage → falls back to createBaggage
    mockPropGetBaggage.mockReturnValueOnce(undefined);
    jest.clearAllMocks();
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({ id: 'timeout-1' });
    mockPpSendMessage.mockResolvedValue(200);
    mockPropCreateBaggage.mockReturnValue({
      setEntry: jest.fn().mockReturnThis(),
    });
    await processMessage(makeJob(validJobData));
    expect(mockPropCreateBaggage).toHaveBeenCalled();
  });
});

describe('processMessage — early exits and fallback paths', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('invalid DTO → logs constraints, span ERROR + recordException, rethrows', async () => {
    await expect(
      processMessage(makeJob({ otel: validJobData.otel, message: { id: 1 } })),
    ).rejects.toThrow('Invalid message job data');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Invalid message job data \[job=msg-job-1\]:/),
    );
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'Invalid message job data',
    });
    expect(mockSpanRecordException).toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('duplicate message (dedupe returns non-OK) → early return after log; no PP call', async () => {
    mockConnSet.mockResolvedValue(null);
    await processMessage(makeJob(validJobData));
    expect(logSpy).toHaveBeenCalledWith(
      'Duplicate message ignored: wamid=wamid.1',
    );
    expect(mockPpSendMessage).not.toHaveBeenCalled();
    expect(mockMetricsRecord).not.toHaveBeenCalled();
  });

  // For the retry-deadline tests we pin Date.now() so the deadline is
  // breached on the first failed attempt — that drives the give-up branch
  // without having to walk wall-clock retries.
  function pinClockBreaching(): jest.SpyInstance {
    let calls = 0;
    return jest.spyOn(Date, 'now').mockImplementation(() => {
      // First call sets the deadline. From then on, fast-forward past it so
      // remaining <= delay on the first catch iteration.
      calls += 1;
      return calls === 1 ? 1_000_000 : 1_000_000 + 11_000;
    });
  }

  it('dedupe Redis unavailable: triggers fallback + records fallback metric + rethrows', async () => {
    mockConnSet.mockRejectedValue(new Error('redis-down'));
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    const clockSpy = pinClockBreaching();
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow(
      'Redis dedupe unavailable',
    );
    clockSpy.mockRestore();
    expect(mockWaSendMessage).toHaveBeenCalled();
    expect(mockMetricsRecord).toHaveBeenCalledWith(expect.any(Number), {
      outcome: 'fallback',
    });
  });

  it('redisWithRetry warns + retries on a transient dedupe error, then succeeds', async () => {
    jest.useFakeTimers();
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    mockConnSet
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('OK');
    mockTimeoutAdd.mockResolvedValue({});
    mockConnEval.mockResolvedValue(0);
    mockPpSendMessage.mockResolvedValue(200);

    const p = processMessage(makeJob(validJobData));
    // First attempt rejects → loop computes remaining (still > 500) → warns
    // and schedules 500ms wait → advance time to let the timer fire.
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(500);
    await p;
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Redis dedupe failed, retrying in 500ms/),
    );
    expect(mockConnSet).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('PP non-2xx → logs, fallback, fallback metric, rethrows `PP returned N`', async () => {
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({});
    mockPpSendMessage.mockResolvedValue(500);
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });

    await expect(processMessage(makeJob(validJobData))).rejects.toThrow(
      'PP returned 500',
    );
    expect(errorSpy).toHaveBeenCalledWith('PP returned 500 for wamid=wamid.1');
    expect(mockMetricsRecord).toHaveBeenCalledWith(expect.any(Number), {
      outcome: 'fallback',
    });
  });

  it('read/typing-indicator rejection is logged but does NOT abort processing', async () => {
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({});
    mockPpSendMessage.mockResolvedValue(202);
    mockWaSendReadAndTyping.mockRejectedValue(new Error('typing-down'));

    await processMessage(makeJob(validJobData));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Read\/typing indicator failed.*typing-down/),
    );
    expect(mockMetricsRecord).toHaveBeenCalledWith(expect.any(Number), {
      outcome: 'success',
    });
  });
});

describe('sendFallback edge cases (exercised through processMessage PP-failure path)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({});
    mockPpSendMessage.mockResolvedValue(500); // forces fallback
  });
  afterEach(() => jest.restoreAllMocks());

  it('fallback aborts when FALL_BACK_MESSAGE_PUBLIC_URL is unset; metric still records', async () => {
    delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    expect(mockWaSendMessage).not.toHaveBeenCalled();
    expect(mockMetricsRecord).toHaveBeenCalledWith(expect.any(Number), {
      outcome: 'fallback',
    });
  });

  it('fallback infers media_type=audio from .mp3 URL', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/intro.mp3?cache=1';
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    const call = mockWaSendMessage.mock.calls[0][0] as {
      media: { type: string; url: string }[];
    };
    expect(call.media).toEqual([
      { type: 'audio', url: 'https://cdn/intro.mp3?cache=1' },
    ]);
  });

  it.each<[string]>([
    ['https://cdn/intro.ogg'],
    ['https://cdn/intro.opus'],
    ['https://cdn/intro.aac'],
    ['https://cdn/intro.m4a'],
  ])('inferMediaType: %s → audio', async (url) => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = url;
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    const call = mockWaSendMessage.mock.calls[0][0] as {
      media: { type: string }[];
    };
    expect(call.media[0].type).toBe('audio');
  });

  it('inferMediaType defaults to video for non-audio extensions', async () => {
    process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/intro.mp4';
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    const call = mockWaSendMessage.mock.calls[0][0] as {
      media: { type: string }[];
    };
    expect(call.media[0].type).toBe('video');
  });

  it('fallback delivered=true → success log', async () => {
    const logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Fallback delivered for user u_/),
    );
  });

  it('fallback delivered=false → warn log with reason', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    mockWaSendMessage.mockResolvedValue({
      body: { delivered: false, reason: 'no-window' },
    });
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Fallback NOT delivered.*reason=no-window/),
    );
  });

  it('fallback delivered=false with no reason → "reason=unknown"', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    mockWaSendMessage.mockResolvedValue({ body: { delivered: false } });
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Fallback NOT delivered.*reason=unknown/),
    );
  });

  it('fallback sendMessage rejecting is logged but swallowed', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    mockWaSendMessage.mockRejectedValue(new Error('wa-down'));
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Fallback message failed for user u_.*wa-down/),
    );
  });
});

describe('processMessageTimeout', () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('missing userId/wamid → logs, span ERROR, rethrows', async () => {
    await expect(
      processMessageTimeout(
        makeJob({ otel: { carrier: {} }, userId: 'u', wamid: undefined }),
      ),
    ).rejects.toThrow('Invalid timeout job data');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Invalid timeout job data \[job=msg-job-1\]: missing userId or wamid/,
      ),
    );
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'Invalid timeout job data',
    });
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('delivered=true → success log', async () => {
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await processMessageTimeout(
      makeJob({
        otel: { carrier: { traceparent: 'tp' } },
        userId: '919999990001',
        wamid: 'wamid.1',
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^Timeout fallback delivered for user u_/),
    );
  });

  it('delivered=false → warn log with reason', async () => {
    mockWaSendMessage.mockResolvedValue({
      body: { delivered: false, reason: 'no-window' },
    });
    await processMessageTimeout(
      makeJob({
        otel: { carrier: {} },
        userId: '919999990001',
        wamid: 'wamid.1',
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Timeout fallback NOT delivered.*reason=no-window/),
    );
  });

  it('delivered=false with no reason → "reason=unknown"', async () => {
    mockWaSendMessage.mockResolvedValue({ body: { delivered: false } });
    await processMessageTimeout(
      makeJob({
        otel: { carrier: {} },
        userId: '919999990001',
        wamid: 'wamid.1',
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Timeout fallback NOT delivered.*reason=unknown/),
    );
  });

  it('sendMessage throws an Error → span ERROR + rethrows', async () => {
    mockWaSendMessage.mockRejectedValue(new Error('wa-down'));
    await expect(
      processMessageTimeout(
        makeJob({
          otel: { carrier: {} },
          userId: '919999990001',
          wamid: 'wamid.1',
        }),
      ),
    ).rejects.toThrow('wa-down');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'wa-down',
    });
    const recArg = mockSpanRecordException.mock.calls[0][0];
    expect(recArg).toBeInstanceOf(Error);
  });

  it('sendMessage throws a non-Error → String()-d + wrapped', async () => {
    mockWaSendMessage.mockRejectedValue('plain-string');
    await expect(
      processMessageTimeout(
        makeJob({
          otel: { carrier: {} },
          userId: '919999990001',
          wamid: 'wamid.1',
        }),
      ),
    ).rejects.toBe('plain-string');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'plain-string',
    });
  });

  it('carrier missing → falls back to {}', async () => {
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await processMessageTimeout(
      makeJob({ userId: '919999990001', wamid: 'wamid.1' }),
    );
    expect(mockPropExtract).toHaveBeenCalledWith('active-ctx', {});
  });
});
