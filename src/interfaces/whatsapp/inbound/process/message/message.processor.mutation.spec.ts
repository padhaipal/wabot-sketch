// Targeted Stryker mutation-killers for message.processor.ts.
// Pinpoints log-string content, baggage entry shapes, timestamp arithmetic,
// ppStatus boundary checks, and the enqueueTimeout retry-deadline branch.

import 'reflect-metadata';

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
const mockPropExtract = jest.fn().mockReturnValue('parent-ctx');
const mockPropInject = jest.fn();
const mockSetEntry = jest.fn();
const fakeBaggage = { setEntry: mockSetEntry };
mockSetEntry.mockReturnValue(fakeBaggage); // chainable
const mockPropGetBaggage = jest.fn().mockReturnValue(fakeBaggage);
const mockPropCreateBaggage = jest.fn().mockReturnValue(fakeBaggage);
const mockPropSetBaggage = jest.fn().mockReturnValue('ctx-with-baggage');
const mockTraceSetSpan = jest.fn().mockReturnValue('ctx-with-span');
const mockContextWith = jest.fn(async (_ctx: unknown, fn: () => unknown) =>
  fn(),
);

jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: () => ({ startSpan: mockStartSpan }),
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
    active: () => 'active-ctx',
    with: (...a: unknown[]) =>
      mockContextWith(a[0] as never, a[1] as () => unknown),
  },
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
}));

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

import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  processMessage,
  processMessageTimeout,
} from './message.processor';

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

let logSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockSetEntry.mockReturnValue(fakeBaggage);
  mockPropGetBaggage.mockReturnValue(fakeBaggage);
  mockPropCreateBaggage.mockReturnValue(fakeBaggage);
  logSpy = jest
    .spyOn(Logger.prototype, 'log')
    .mockImplementation(() => undefined);
  warnSpy = jest
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  errorSpy = jest
    .spyOn(Logger.prototype, 'error')
    .mockImplementation(() => undefined);
  process.env.FALL_BACK_MESSAGE_PUBLIC_URL = 'https://cdn/x.mp3';
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
});

describe('baggage entries — exact key/value strings', () => {
  beforeEach(() => {
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({});
    mockPpSendMessage.mockResolvedValue(200);
  });

  it('sets wabot.msg.ts_ms = timestamp * 1000 (string) and wabot.msg.wamid = wamid', async () => {
    await processMessage(makeJob(validJobData));
    expect(mockSetEntry).toHaveBeenCalledWith('wabot.msg.ts_ms', {
      value: '1700000000000',
    });
    expect(mockSetEntry).toHaveBeenCalledWith('wabot.msg.wamid', {
      value: 'wamid.1',
    });
  });
});

describe('enqueueTimeout — delay arithmetic', () => {
  beforeEach(() => {
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({});
    mockPpSendMessage.mockResolvedValue(200);
  });

  it('passes { delay: max(0, ts*1000 + 20_000 - Date.now()) } to queue.add', async () => {
    // Pin Date.now so we can compute the exact expected delay.
    const fakeNow = 1_700_000_005_000; // 5s after message timestamp
    jest.spyOn(Date, 'now').mockReturnValue(fakeNow);
    await processMessage(makeJob(validJobData));
    // timestampMs = 1_700_000_000_000; deadline = ts + 20_000 = 1_700_000_020_000;
    // remaining = 1_700_000_020_000 - fakeNow = 15_000.
    expect(mockTimeoutAdd).toHaveBeenCalledWith(
      'timeout',
      expect.objectContaining({
        userId: '919999990001',
        wamid: 'wamid.1',
        otel: { carrier: expect.any(Object) },
      }),
      { delay: 15_000 },
    );
  });

  it('clamps delay to 0 when the 20s deadline has already passed', async () => {
    // Way past the message timestamp + 20s.
    jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    await processMessage(makeJob(validJobData));
    expect(mockTimeoutAdd).toHaveBeenCalledWith(
      'timeout',
      expect.any(Object),
      { delay: 0 },
    );
  });
});

describe('enqueueTimeout — retry deadline branch', () => {
  beforeEach(() => {
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
  });

  it('gives up after the 10s deadline elapses → logs "Failed to enqueue timeout job after retries" + throws', async () => {
    mockTimeoutAdd.mockRejectedValue(new Error('queue-down'));
    // Monotonically-increasing clock by 20s per call: dedupe-deadline,
    // enqueueTimeout-delay, enqueueTimeout-deadline, then the catch's
    // remaining calc all see a clock past the 10s retry budget so the
    // first failed add() trips the give-up branch (no setTimeout hang).
    let counter = 0;
    jest
      .spyOn(Date, 'now')
      .mockImplementation(() => 1_000_000 + counter++ * 20_000);
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Failed to enqueue timeout job after retries: queue-down$/,
      ),
    );
  });
});

describe('ppStatus 2xx boundary', () => {
  beforeEach(() => {
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({});
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
  });

  it.each([200, 201, 202, 299])(
    'ppStatus=%i → success path: success metric + accept log',
    async (status) => {
      mockPpSendMessage.mockResolvedValue(status);
      await processMessage(makeJob(validJobData));
      expect(mockMetricsRecord).toHaveBeenCalledWith(expect.any(Number), {
        outcome: 'success',
      });
      expect(logSpy).toHaveBeenCalledWith(
        `PP accepted message wamid=wamid.1, status=${String(status)}`,
      );
    },
  );

  it.each([199, 300, 301, 400, 500])(
    'ppStatus=%i → fallback path: error log + fallback metric + throw',
    async (status) => {
      mockPpSendMessage.mockResolvedValue(status);
      await expect(processMessage(makeJob(validJobData))).rejects.toThrow(
        `PP returned ${String(status)}`,
      );
      expect(mockMetricsRecord).toHaveBeenCalledWith(expect.any(Number), {
        outcome: 'fallback',
      });
    },
  );
});

describe('consecutive-check retry label + reused redisWithRetry', () => {
  beforeEach(() => {
    mockConnSet.mockResolvedValue('OK');
    mockTimeoutAdd.mockResolvedValue({});
    mockPpSendMessage.mockResolvedValue(200);
  });

  it('eval rejection final log uses the "consecutive-check" label (matches the literal)', async () => {
    mockConnEval.mockRejectedValue(new Error('eval-down'));
    // Monotonically-increasing clock so the give-up branch fires on first
    // attempt (no setTimeout hang).
    let counter = 0;
    jest
      .spyOn(Date, 'now')
      .mockImplementation(() => 1_000_000 + counter++ * 20_000);
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow(
      'Redis consecutive-check unavailable',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Redis consecutive-check failed after retries: eval-down$/,
      ),
    );
  });
});

describe('processMessage — fallback log subject is wamid not userId', () => {
  beforeEach(() => {
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({});
    mockPpSendMessage.mockResolvedValue(500);
  });

  it('fallback-NOT-delivered log includes the literal "wamid=" + actual wamid', async () => {
    mockWaSendMessage.mockResolvedValue({
      body: { delivered: false, reason: 'whatsapp-error' },
    });
    await expect(processMessage(makeJob(validJobData))).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /Fallback NOT delivered for user u_9199, wamid=wamid\.1, reason=whatsapp-error/,
      ),
    );
  });
});

describe('processMessageTimeout — exact log strings', () => {
  it('delivered: log uses "Timeout fallback delivered for user" exactly', async () => {
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await processMessageTimeout(
      makeJob({
        otel: { carrier: { traceparent: 'tp' } },
        userId: '919999990001',
        wamid: 'wamid.42',
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Timeout fallback delivered for user u_9199',
    );
  });

  it('not-delivered with reason: "Timeout fallback NOT delivered for user u_…, wamid=wamid.42, reason=…"', async () => {
    mockWaSendMessage.mockResolvedValue({
      body: { delivered: false, reason: 'inflight-expired' },
    });
    await processMessageTimeout(
      makeJob({
        otel: { carrier: { traceparent: 'tp' } },
        userId: '919999990001',
        wamid: 'wamid.42',
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'Timeout fallback NOT delivered for user u_9199, wamid=wamid.42, reason=inflight-expired',
    );
  });

  it('sendMessage rejecting with non-Error → recordException receives a wrapped Error(String(value))', async () => {
    mockWaSendMessage.mockRejectedValue('plain-string');
    await expect(
      processMessageTimeout(
        makeJob({
          otel: { carrier: { traceparent: 'tp' } },
          userId: '919999990001',
          wamid: 'wamid.42',
        }),
      ),
    ).rejects.toBe('plain-string');
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'plain-string',
    });
    const recArg = mockSpanRecordException.mock.calls[0][0] as Error;
    expect(recArg).toBeInstanceOf(Error);
    expect(recArg.message).toBe('plain-string');
  });

  it('buildFallbackMedia returns [] when FALL_BACK env is unset → sendMessage called with media=[]', async () => {
    delete process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
    mockWaSendMessage.mockResolvedValue({
      body: { delivered: false, reason: 'inflight-expired' },
    });
    await processMessageTimeout(
      makeJob({
        otel: { carrier: { traceparent: 'tp' } },
        userId: '919999990001',
        wamid: 'wamid.42',
      }),
    );
    expect(mockWaSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ media: [] }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      'FALL_BACK_MESSAGE_PUBLIC_URL is not configured.',
    );
  });
});

describe('span.setAttribute keys are exactly "wamid" and "message.type"', () => {
  beforeEach(() => {
    mockConnSet.mockResolvedValue('OK');
    mockConnEval.mockResolvedValue(0);
    mockTimeoutAdd.mockResolvedValue({});
    mockPpSendMessage.mockResolvedValue(200);
  });

  it('wamid attr key matches', async () => {
    await processMessage(makeJob(validJobData));
    const keys = mockSpanSetAttribute.mock.calls.map((c) => c[0]);
    expect(keys).toContain('wamid');
    expect(keys).toContain('message.type');
  });

  it('start-span name is exactly "process-message"', async () => {
    await processMessage(makeJob(validJobData));
    expect(mockStartSpan).toHaveBeenCalledWith(
      'process-message',
      {},
      'parent-ctx',
    );
  });

  it('processMessageTimeout span name is exactly "process-message-timeout"', async () => {
    mockWaSendMessage.mockResolvedValue({ body: { delivered: true } });
    await processMessageTimeout(
      makeJob({
        otel: { carrier: { traceparent: 'tp' } },
        userId: '919999990001',
        wamid: 'wamid.1',
      }),
    );
    expect(mockStartSpan).toHaveBeenCalledWith(
      'process-message-timeout',
      {},
      'parent-ctx',
    );
  });
});
