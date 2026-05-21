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
