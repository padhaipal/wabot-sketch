// processStatus mirrors processError's lifecycle (carrier extract → span →
// validate → log → span end). We focus on the bits unique to status:
//   - status.id + status.status span attributes
//   - the conditional errors=<summary> suffix on the log line, including the
//     ?-placeholder when code/title are missing and the optional :message tail

import 'reflect-metadata';

const mockSpanSetAttribute = jest.fn();
const mockSpanSetStatus = jest.fn();
const mockSpanRecordException = jest.fn();
const mockSpanEnd = jest.fn();
const mockStartSpan = jest.fn().mockReturnValue({
  setAttribute: mockSpanSetAttribute,
  setStatus: mockSpanSetStatus,
  recordException: mockSpanRecordException,
  end: mockSpanEnd,
});
const mockGetTracer = jest.fn().mockReturnValue({ startSpan: mockStartSpan });
const mockPropagationExtract = jest.fn().mockReturnValue('extracted-ctx');
const mockContextActive = jest.fn().mockReturnValue('active-ctx');

jest.mock('@opentelemetry/api', () => ({
  trace: { getTracer: (...args: unknown[]) => mockGetTracer(...args) },
  propagation: {
    extract: (...args: unknown[]) => mockPropagationExtract(...args),
  },
  context: { active: () => mockContextActive() },
  SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 },
}));

const mockGetdel = jest.fn();
jest.mock('../../../../redis/queues', () => ({
  connection: { getdel: (...a: unknown[]) => mockGetdel(...a) },
}));

const mockUserE2eRecord = jest.fn();
jest.mock('../../../../../otel/metrics', () => ({
  userE2eDuration: { record: (...a: unknown[]) => mockUserE2eRecord(...a) },
  buildUserE2eAttributes: (
    outcome: string,
    loadTest: string,
    testPhase?: string,
  ) => ({
    outcome,
    load_test: loadTest,
    ...(testPhase ? { test_phase: testPhase } : {}),
  }),
}));

import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { processStatus } from './status.processor';

function makeJob(data: unknown, id = 'status-job-1'): Job {
  return { id, data } as unknown as Job;
}

const baseStatus = {
  id: 'wamid.1',
  status: 'delivered',
  timestamp: '1700000000',
  recipient_id: '919999990001',
};

const validData = {
  otel: { carrier: { traceparent: 'tp' } },
  status: baseStatus,
};

describe('processStatus', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGetdel.mockReset();
    mockGetdel.mockResolvedValue(null);
    mockUserE2eRecord.mockClear();
    mockSpanSetAttribute.mockClear();
    mockSpanSetStatus.mockClear();
    mockSpanRecordException.mockClear();
    mockSpanEnd.mockClear();
    mockStartSpan.mockClear();
    mockPropagationExtract.mockClear();
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('opens "process-status" span with the extracted carrier ctx', async () => {
    await processStatus(makeJob(validData));
    expect(mockPropagationExtract).toHaveBeenCalledWith('active-ctx', {
      traceparent: 'tp',
    });
    expect(mockStartSpan).toHaveBeenCalledWith(
      'process-status',
      {},
      'extracted-ctx',
    );
  });

  it('carrier extraction falls back to {} when otel.carrier is missing', async () => {
    await processStatus(makeJob({ status: baseStatus }));
    expect(mockPropagationExtract).toHaveBeenCalledWith('active-ctx', {});
  });

  it('sets status.id + status.status span attrs and logs without errors when status.errors is absent', async () => {
    await processStatus(makeJob(validData));
    expect(mockSpanSetAttribute).toHaveBeenCalledWith('status.id', 'wamid.1');
    expect(mockSpanSetAttribute).toHaveBeenCalledWith(
      'status.status',
      'delivered',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Status: delivered wamid=wamid.1 recipient=919999990001',
    );
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('appends `errors=<summary>` with code:title:message when present', async () => {
    await processStatus(
      makeJob({
        ...validData,
        status: {
          ...baseStatus,
          errors: [{ code: 131_026, title: 'Undeliverable', message: 'oops' }],
        },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Status: delivered wamid=wamid.1 recipient=919999990001 errors=131026:Undeliverable:oops',
    );
  });

  it('substitutes "?" for missing code / title and drops the :message segment when message is absent', async () => {
    await processStatus(
      makeJob({
        ...validData,
        status: {
          ...baseStatus,
          errors: [{}],
        },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Status: delivered wamid=wamid.1 recipient=919999990001 errors=?:?',
    );
  });

  it('joins multiple errors with "|"', async () => {
    await processStatus(
      makeJob({
        ...validData,
        status: {
          ...baseStatus,
          errors: [
            { code: 1, title: 'A' },
            { code: 2, title: 'B', message: 'b-msg' },
          ],
        },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Status: delivered wamid=wamid.1 recipient=919999990001 errors=1:A|2:B:b-msg',
    );
  });

  it('empty errors array → no errors= suffix', async () => {
    await processStatus(
      makeJob({ ...validData, status: { ...baseStatus, errors: [] } }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Status: delivered wamid=wamid.1 recipient=919999990001',
    );
  });

  it('invalid data: logs each constraint, sets span ERROR + recordException, rethrows', async () => {
    await expect(
      processStatus(makeJob({ otel: validData.otel, status: { id: 123 } })),
    ).rejects.toThrow('Invalid status job data');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Invalid status job data \[job=status-job-1\]: status\./,
      ),
    );
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'Invalid status job data',
    });
    expect(mockSpanRecordException).toHaveBeenCalled();
    expect(mockSpanEnd).toHaveBeenCalledTimes(1);
  });

  it('non-Error throw is wrapped into an Error for recordException + String()-d for span message', async () => {
    mockSpanSetAttribute.mockImplementationOnce(() => {
      throw 'just-a-string';
    });
    await expect(processStatus(makeJob(validData))).rejects.toBe(
      'just-a-string',
    );
    expect(mockSpanSetStatus).toHaveBeenCalledWith({
      code: 2,
      message: 'just-a-string',
    });
    const recArg = mockSpanRecordException.mock.calls[0][0];
    expect(recArg).toBeInstanceOf(Error);
    expect((recArg as Error).message).toBe('just-a-string');
  });
});

// ─── user_e2e recording ──────────────────────────────────────────────────────
// The SLO histogram: Meta-clock delta between the original user message
// (mapping stored by outbound sendMessage under the reply wamid) and this
// delivered/read status. See otel/user-e2e.ts for key/threshold constants.

describe('processStatus — user_e2e recording', () => {
  const KEY = '{wabot:development}:user-e2e:wamid:wamid.1';
  // baseStatus.timestamp = 1700000000 s → 1_700_000_000_000 ms
  const STATUS_MS = 1_700_000_000_000;

  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGetdel.mockReset();
    mockGetdel.mockResolvedValue(null);
    mockUserE2eRecord.mockClear();
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('records outcome=delivered with the Meta-clock delta when a mapping exists', async () => {
    mockGetdel.mockResolvedValue(
      JSON.stringify({ ts: STATUS_MS - 5_000, lt: 'false' }),
    );
    await processStatus(makeJob(validData));
    expect(mockGetdel).toHaveBeenCalledWith(KEY);
    expect(mockUserE2eRecord).toHaveBeenCalledWith(5_000, {
      outcome: 'delivered',
      load_test: 'false',
    });
  });

  it('records outcome=late when the delta exceeds 60s', async () => {
    mockGetdel.mockResolvedValue(
      JSON.stringify({ ts: STATUS_MS - 61_000, lt: 'false' }),
    );
    await processStatus(makeJob(validData));
    expect(mockUserE2eRecord).toHaveBeenCalledWith(61_000, {
      outcome: 'late',
      load_test: 'false',
    });
  });

  it('records exactly 60_000 as delivered (boundary is inclusive)', async () => {
    mockGetdel.mockResolvedValue(
      JSON.stringify({ ts: STATUS_MS - 60_000, lt: 'false' }),
    );
    await processStatus(makeJob(validData));
    expect(mockUserE2eRecord).toHaveBeenCalledWith(
      60_000,
      expect.objectContaining({ outcome: 'delivered' }),
    );
  });

  it('clamps second-rounding negatives to 0 instead of dropping the sample', async () => {
    mockGetdel.mockResolvedValue(
      JSON.stringify({ ts: STATUS_MS + 500, lt: 'false' }),
    );
    await processStatus(makeJob(validData));
    expect(mockUserE2eRecord).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ outcome: 'delivered' }),
    );
  });

  it('passes load_test + test_phase from the mapping payload into the attrs', async () => {
    mockGetdel.mockResolvedValue(
      JSON.stringify({ ts: STATUS_MS - 2_000, lt: 'true', tp: 'phase_2' }),
    );
    await processStatus(makeJob(validData));
    expect(mockUserE2eRecord).toHaveBeenCalledWith(2_000, {
      outcome: 'delivered',
      load_test: 'true',
      test_phase: 'phase_2',
    });
  });

  it('does not record when no mapping exists (GETDEL returns null)', async () => {
    await processStatus(makeJob(validData));
    expect(mockGetdel).toHaveBeenCalledWith(KEY);
    expect(mockUserE2eRecord).not.toHaveBeenCalled();
  });

  it('consumes the mapping on a read status too (upper-bound fallback)', async () => {
    mockGetdel.mockResolvedValue(
      JSON.stringify({ ts: STATUS_MS - 3_000, lt: 'false' }),
    );
    await processStatus(
      makeJob({
        ...validData,
        status: { ...baseStatus, status: 'read' },
      }),
    );
    expect(mockUserE2eRecord).toHaveBeenCalledWith(
      3_000,
      expect.objectContaining({ outcome: 'delivered' }),
    );
  });

  it('does not touch redis for non-terminal statuses (sent)', async () => {
    await processStatus(
      makeJob({
        ...validData,
        status: { ...baseStatus, status: 'sent' },
      }),
    );
    expect(mockGetdel).not.toHaveBeenCalled();
  });

  it('warns and completes (never throws) when GETDEL fails', async () => {
    mockGetdel.mockRejectedValue(new Error('redis down'));
    await expect(processStatus(makeJob(validData))).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'user_e2e record failed for wamid=wamid.1: redis down',
    );
    expect(mockUserE2eRecord).not.toHaveBeenCalled();
  });

  it('warns and skips on a malformed mapping payload', async () => {
    mockGetdel.mockResolvedValue('not-json');
    await expect(processStatus(makeJob(validData))).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    expect(mockUserE2eRecord).not.toHaveBeenCalled();
  });

  it('skips silently when the mapping has no numeric ts', async () => {
    mockGetdel.mockResolvedValue(JSON.stringify({ lt: 'false' }));
    await processStatus(makeJob(validData));
    expect(mockUserE2eRecord).not.toHaveBeenCalled();
  });
});
