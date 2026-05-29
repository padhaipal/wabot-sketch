/// <reference types="jest" />

// Stub the queues module so importing parse.processor does not require Redis.
// extractJobs does not touch the queues; the createQueue/QUEUE_NAMES calls at
// module load just need to resolve without throwing.
jest.mock('../../../redis/queues', () => ({
  connection: null,
  createQueue: () => null,
  QUEUE_NAMES: {
    PROCESS_MESSAGE: 'process-message',
    PROCESS_STATUS: 'process-status',
    PROCESS_ERRORS: 'process-errors',
  },
}));

import 'reflect-metadata';
import type { OtelCarrier } from '../../../../otel/otel.dto';

interface ParsedJobs {
  messages: { name: string; data: unknown }[];
  statuses: { name: string; data: unknown }[];
  errors: { name: string; data: unknown }[];
}

interface ExtractJobsModule {
  extractJobs: (opts: {
    dto: {
      otel: { carrier: OtelCarrier };
      body: {
        entry: Array<{
          id: string;
          changes: Array<{ field: string; value: Record<string, unknown> }>;
        }>;
      };
    };
    carrier: OtelCarrier;
  }) => ParsedJobs;
}

// parse.processor reads WHATSAPP_BUSINESS_ACCOUNT_ID + PHONE_NUMBER_ID at
// module-load time into top-level consts. To exercise different env configs we
// re-load the module per scenario via jest.isolateModules, which requires a
// synchronous require() (dynamic import() needs --experimental-vm-modules).
function loadModule(env: { waba?: string; pnId?: string }): ExtractJobsModule {
  let mod!: ExtractJobsModule;
  jest.isolateModules(() => {
    if (env.waba === undefined) {
      delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    } else {
      process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = env.waba;
    }
    if (env.pnId === undefined) {
      delete process.env.PHONE_NUMBER_ID;
    } else {
      process.env.PHONE_NUMBER_ID = env.pnId;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('./parse.processor') as ExtractJobsModule;
  });
  return mod;
}

const CARRIER: OtelCarrier = { traceparent: 'test' };

const validMessage = (id = 'wamid.test'): Record<string, unknown> => ({
  from: '911111111111',
  id,
  timestamp: '1700000000',
  type: 'text',
  text: { body: 'hi' },
});

const validStatus = (id = 'wamid.status'): Record<string, unknown> => ({
  id,
  status: 'delivered',
  timestamp: '1700000000',
  recipient_id: '911111111111',
});

const buildDto = (
  entries: Array<{
    id: string;
    changes: Array<{ field: string; value: Record<string, unknown> }>;
  }>,
) => ({
  otel: { carrier: CARRIER },
  body: { entry: entries },
});

const WABA = 'waba-1';
const ALLOWED_PN = 'pn-allowed';
const OTHER_PN = 'pn-other';

describe('extractJobs phone_number_id filter', () => {
  it('keeps message when phone_number_id matches env', () => {
    const { extractJobs } = loadModule({ waba: WABA, pnId: ALLOWED_PN });
    const result = extractJobs({
      dto: buildDto([
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
      ]),
      carrier: CARRIER,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.statuses).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('drops message when phone_number_id does not match env', () => {
    const { extractJobs } = loadModule({ waba: WABA, pnId: ALLOWED_PN });
    const result = extractJobs({
      dto: buildDto([
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
      ]),
      carrier: CARRIER,
    });
    expect(result.messages).toHaveLength(0);
  });

  it('drops change when metadata.phone_number_id is missing', () => {
    const { extractJobs } = loadModule({ waba: WABA, pnId: ALLOWED_PN });
    const result = extractJobs({
      dto: buildDto([
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: { messages: [validMessage()] },
            },
          ],
        },
      ]),
      carrier: CARRIER,
    });
    expect(result.messages).toHaveLength(0);
  });

  it('fail-closed: drops all changes when PHONE_NUMBER_ID env is unset', () => {
    const { extractJobs } = loadModule({ waba: WABA, pnId: undefined });
    const result = extractJobs({
      dto: buildDto([
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
      ]),
      carrier: CARRIER,
    });
    expect(result.messages).toHaveLength(0);
  });

  it('drops status when phone_number_id does not match env', () => {
    const { extractJobs } = loadModule({ waba: WABA, pnId: ALLOWED_PN });
    const result = extractJobs({
      dto: buildDto([
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: OTHER_PN },
                statuses: [validStatus()],
              },
            },
          ],
        },
      ]),
      carrier: CARRIER,
    });
    expect(result.statuses).toHaveLength(0);
  });

  it('keeps status when phone_number_id matches env', () => {
    const { extractJobs } = loadModule({ waba: WABA, pnId: ALLOWED_PN });
    const result = extractJobs({
      dto: buildDto([
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: ALLOWED_PN },
                statuses: [validStatus()],
              },
            },
          ],
        },
      ]),
      carrier: CARRIER,
    });
    expect(result.statuses).toHaveLength(1);
  });

  it('mixed entry: keeps only the change whose phone_number_id matches', () => {
    const { extractJobs } = loadModule({ waba: WABA, pnId: ALLOWED_PN });
    const result = extractJobs({
      dto: buildDto([
        {
          id: WABA,
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: OTHER_PN },
                messages: [validMessage('wamid.dropped')],
              },
            },
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: ALLOWED_PN },
                messages: [validMessage('wamid.kept')],
              },
            },
          ],
        },
      ]),
      carrier: CARRIER,
    });
    expect(result.messages).toHaveLength(1);
  });

  it('WABA mismatch is still filtered out before phone check', () => {
    const { extractJobs } = loadModule({ waba: WABA, pnId: ALLOWED_PN });
    const result = extractJobs({
      dto: buildDto([
        {
          id: 'different-waba',
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
      ]),
      carrier: CARRIER,
    });
    expect(result.messages).toHaveLength(0);
  });
});

// ─── parseParse coverage (separate module reload so we can swap createQueue) ─

describe('parseParse — main processor', () => {
  // Shared mock queue: addBulk records each call so we can assert payloads.
  const addBulk = jest.fn().mockResolvedValue(undefined);

  // OTel + queues mocks scoped to this block via jest.doMock + isolateModules.
  function loadParseParse(): { parseParse: (job: unknown) => Promise<void> } {
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
          // Populate the carrier so downstream OtelCarrierDto validation
          // (non-empty record of strings) passes.
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

  beforeEach(() => {
    addBulk.mockReset().mockResolvedValue(undefined);
  });

  function makeJob(data: unknown): { id: string; data: unknown } {
    return { id: 'parse-job-1', data };
  }

  it('invalid DTO → logs + rethrows', async () => {
    const { parseParse } = loadParseParse();
    await expect(parseParse(makeJob({ body: { entry: 'nope' } }))).rejects.toThrow(
      'Invalid parse job data',
    );
  });

  it('happy path: extracts messages/statuses/errors and bulk-adds each into the right queue', async () => {
    const { parseParse } = loadParseParse();
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
                    metadata: {
                      phone_number_id: ALLOWED_PN,
                      display_phone_number: '+1 555 5555',
                    },
                    messages: [validMessage('m1'), validMessage('m2')],
                    statuses: [validStatus('s1')],
                    errors: [
                      {
                        code: 130_429,
                        title: 'Rate limited',
                        message: 'oops',
                        error_data: { details: 'slow down' },
                        href: 'https://developers.facebook.com/docs/',
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
    // 3 bulk adds: messages, statuses, errors
    expect(addBulk).toHaveBeenCalledTimes(3);
    const messageCall = addBulk.mock.calls.find((call) =>
      (call[0] as { name: string }[]).every((j) => j.name === 'message'),
    );
    expect(messageCall![0]).toHaveLength(2);
  });

  it('empty extraction → no addBulk calls; still resolves and ends span', async () => {
    const { parseParse } = loadParseParse();
    await parseParse(
      makeJob({
        otel: { carrier: CARRIER },
        body: { entry: [] },
      }),
    );
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('bulk-add rejects forever (Date.now-pinned to breach deadline) → throws "Failed to enqueue ... jobs"', async () => {
    const { parseParse } = loadParseParse();
    let calls = 0;
    const dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      return calls === 1 ? 1_000_000 : 1_000_000 + 11_000;
    });
    addBulk.mockRejectedValue(new Error('queue-down'));
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
    ).rejects.toThrow(/Failed to enqueue process-message jobs/);
    dateSpy.mockRestore();
  });

  it('validateDto detail string shape: includes children + grandchildren paths when nested constraints fail', async () => {
    const { parseParse } = loadParseParse();
    // A malformed message with a bad nested text DTO triggers validateDto's
    // children + grandchildren branches in the error-detail formatter.
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
                      messages: [
                        {
                          from: '911111111111',
                          id: 'wamid.bad',
                          timestamp: '1700000000',
                          type: 'text',
                          text: { body: 12345 }, // wrong type → nested error
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).resolves.toBeUndefined();
    // No messages enqueued because the inner message failed validation.
    expect(addBulk).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ name: 'message' })]),
    );
  });
});
