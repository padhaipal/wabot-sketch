// Targeted Stryker mutation-killers for parse.processor.ts.
// Pinpoints log-string content, queue-name strings, validateDto error-detail
// formatting (children & grandchildren branches), and the bulkAddWithRetry
// retry-deadline branch.

import 'reflect-metadata';
import type { OtelCarrier } from '../../../../otel/otel.dto';

const CARRIER: OtelCarrier = { traceparent: 'tp' };
const WABA = 'waba-1';
const ALLOWED_PN = 'pn-allowed';
const OTHER_PN = 'pn-other';

const addBulk = jest.fn();

// Singleton Logger mock shared across isolated-module loads so spies attached
// in the outer scope still receive calls from `new Logger(...)` inside the
// require()-d module.
const mockLogWarn = jest.fn();
const mockLogLog = jest.fn();
const mockLogError = jest.fn();
class FakeLogger {
  constructor(_ctx?: string) {}
  warn(msg: unknown) {
    mockLogWarn(msg);
  }
  log(msg: unknown) {
    mockLogLog(msg);
  }
  error(msg: unknown) {
    mockLogError(msg);
  }
}
jest.mock('@nestjs/common', () => ({ Logger: FakeLogger }));

function loadModule(): { parseParse: (job: unknown) => Promise<void> } {
  const tracerMock = {
    startSpan: jest.fn().mockReturnValue({
      setAttribute: jest.fn(),
      setStatus: jest.fn(),
      recordException: jest.fn(),
      end: jest.fn(),
    }),
  };
  let mod!: { parseParse: (job: unknown) => Promise<void> };
  jest.isolateModules(() => {
    jest.doMock('../../../redis/queues', () => ({
      connection: null,
      createQueue: jest.fn().mockReturnValue({ addBulk }),
      QUEUE_NAMES: {
        PROCESS_MESSAGE: 'process-message',
        PROCESS_STATUS: 'process-status',
        PROCESS_ERRORS: 'process-errors',
      },
    }));
    jest.doMock('@opentelemetry/api', () => ({
      trace: { getTracer: () => tracerMock, setSpan: () => 'ctx' },
      propagation: {
        extract: () => 'parent',
        inject: jest.fn((_ctx: unknown, carrier: Record<string, string>) => {
          carrier.traceparent = 'tp-injected';
        }),
      },
      context: { active: () => 'active' },
      SpanStatusCode: { ERROR: 2 },
    }));
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA;
    process.env.PHONE_NUMBER_ID = ALLOWED_PN;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('./parse.processor');
  });
  return mod;
}

function makeJob(data: unknown): { id: string; data: unknown } {
  return { id: 'parse-job-1', data };
}

const validMessage = (id = 'wamid.x') => ({
  from: '911111111111',
  id,
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hi' },
});

const validStatus = (id = 'wamid.s') => ({
  id,
  status: 'delivered',
  timestamp: '1700000000',
  recipient_id: '911111111111',
});

const validError = () => ({
  code: 130_429,
  title: 'Rate limited',
  message: 'oops',
  error_data: { details: 'slow down' },
  href: 'https://developers.facebook.com/docs/',
});

beforeEach(() => {
  addBulk.mockReset().mockResolvedValue(undefined);
  mockLogWarn.mockReset();
  mockLogLog.mockReset();
  mockLogError.mockReset();
});

afterEach(() => jest.restoreAllMocks());

const warnSpy = mockLogWarn;
const logSpy = mockLogLog;
const errorSpy = mockLogError;

describe('queue routing — exact job names', () => {
  it('messages enqueue with name="message"', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    messages: [validMessage('m1'), validMessage('m2')],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    const messageCall = addBulk.mock.calls[0]?.[0] as { name: string }[];
    expect(messageCall).toHaveLength(2);
    expect(messageCall.every((j) => j.name === 'message')).toBe(true);
  });

  it('statuses enqueue with name="status"', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    statuses: [validStatus('s1')],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(addBulk.mock.calls[0][0]).toEqual([
      expect.objectContaining({ name: 'status' }),
    ]);
  });

  it('errors enqueue with name="error"', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    errors: [validError()],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(addBulk.mock.calls[0][0]).toEqual([
      expect.objectContaining({ name: 'error' }),
    ]);
  });
});

describe('phone_number_id mismatch log shape', () => {
  it('mismatch → log includes the actual pnId and the allowed value', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: OTHER_PN },
                    messages: [validMessage()],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      `[HPTRACE] Change dropped: phone_number_id=${OTHER_PN} != allowed=${ALLOWED_PN}`,
    );
  });

  it('missing metadata → log says "phone_number_id=missing"', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: { messages: [validMessage()] },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('phone_number_id=missing'),
    );
  });
});

describe('parseParse summary log + queue counts', () => {
  it('happy: enqueues exactly 3 bulkAdds and logs "Parsed webhook: 2 messages, 1 statuses, 1 err"', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    messages: [validMessage('m1'), validMessage('m2')],
                    statuses: [validStatus('s1')],
                    errors: [validError()],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(addBulk).toHaveBeenCalledTimes(3);
    expect(logSpy).toHaveBeenCalledWith(
      'Parsed webhook: 2 messages, 1 statuses, 1 err',
    );
  });

  it('empty extraction logs "Parsed webhook: 0 messages, 0 statuses, 0 err"', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({ otel: { carrier: CARRIER }, body: { entry: [] } }),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Parsed webhook: 0 messages, 0 statuses, 0 err',
    );
  });
});

describe('validateDto error-detail formatting', () => {
  it('message rejection includes "[HPTRACE] Message dropped: failed MessageJobDto validation"', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    messages: [
                      {
                        from: 1, // wrong type triggers IsString constraint
                        id: 'wamid.x',
                        timestamp: '1700000000',
                        type: 'text',
                        text: { body: 'hi' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '[HPTRACE] Message dropped: failed MessageJobDto validation',
      ),
    );
    // The errorDetail string lists the failed property under "message:"
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('from:'));
  });

  it('status rejection log uses literal "[HPTRACE] Status dropped: errors="', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    statuses: [
                      { id: 'wamid.s' /* missing required fields */ },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[HPTRACE] Status dropped: errors='),
    );
  });

  it('error-entry rejection log uses literal "[HPTRACE] Error entry dropped: errors="', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    errors: [{ code: 'not-a-number' /* malformed */ }],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[HPTRACE] Error entry dropped: errors='),
    );
  });

  it('grandchild constraint path: deeply nested constraints surface "text:body:" in the errorDetail', async () => {
    const { parseParse } = loadModule();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    messages: [
                      {
                        from: '911111111111',
                        id: 'wamid.x',
                        timestamp: '1700000000',
                        type: 'text',
                        text: { body: 12345 }, // grandchild constraint
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('text:body:'),
    );
  });
});

describe('bulkAddWithRetry — retry-deadline branch (final error log)', () => {
  it('message-queue bulk-add rejects past deadline → logs "Failed to enqueue process-message jobs after retries:" + throws', async () => {
    const { parseParse } = loadModule();
    addBulk.mockRejectedValue(new Error('q-down'));
    // Monotonic clock so the deadline (10s) is breached on the first catch.
    let counter = 0;
    jest
      .spyOn(Date, 'now')
      .mockImplementation(() => 1_000_000 + counter++ * 20_000);
    await expect(
      parseParse(
        makeJob({
          otel: { carrier: CARRIER },
          body: {
            entry: [
              {
                id: WABA,
                changes: [
                  {
                    field: 'messages',
                    value: {
                      metadata: { phone_number_id: ALLOWED_PN },
                      messages: [validMessage('m1')],
                    },
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).rejects.toThrow(/^Failed to enqueue process-message jobs$/);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Failed to enqueue process-message jobs after retries: q-down$/,
      ),
    );
  });
});

describe('WHATSAPP_BUSINESS_ACCOUNT_ID unset', () => {
  it('warns then returns empty extraction (no addBulk calls)', async () => {
    let mod!: { parseParse: (job: unknown) => Promise<void> };
    jest.isolateModules(() => {
      jest.doMock('../../../redis/queues', () => ({
        connection: null,
        createQueue: jest.fn().mockReturnValue({ addBulk }),
        QUEUE_NAMES: {
          PROCESS_MESSAGE: 'process-message',
          PROCESS_STATUS: 'process-status',
          PROCESS_ERRORS: 'process-errors',
        },
      }));
      jest.doMock('@opentelemetry/api', () => ({
        trace: {
          getTracer: () => ({
            startSpan: jest.fn().mockReturnValue({
              setAttribute: jest.fn(),
              setStatus: jest.fn(),
              recordException: jest.fn(),
              end: jest.fn(),
            }),
          }),
          setSpan: () => 'ctx',
        },
        propagation: {
          extract: () => 'parent',
          inject: jest.fn((_c: unknown, c: Record<string, string>) => {
            c.traceparent = 'tp-injected';
          }),
        },
        context: { active: () => 'active' },
        SpanStatusCode: { ERROR: 2 },
      }));
      delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
      process.env.PHONE_NUMBER_ID = ALLOWED_PN;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('./parse.processor');
    });
    await mod.parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: {
          entry: [
            {
              id: WABA,
              changes: [
                {
                  field: 'messages',
                  value: {
                    metadata: { phone_number_id: ALLOWED_PN },
                    messages: [validMessage()],
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      'WHATSAPP_BUSINESS_ACCOUNT_ID is not set; all webhook entries will be skipped',
    );
    expect(addBulk).not.toHaveBeenCalled();
  });
});

describe('invalid DTO error log shape', () => {
  it('logs "Invalid parse job data [job=<id>]: <errors>" then throws "Invalid parse job data"', async () => {
    const { parseParse } = loadModule();
    await expect(
      parseParse(makeJob({ body: { entry: 'nope' } })),
    ).rejects.toThrow('Invalid parse job data');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Invalid parse job data \[job=parse-job-1\]:.*entry/,
      ),
    );
  });
});
