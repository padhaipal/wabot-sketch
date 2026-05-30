// queues.ts opens a single Redis connection at import time and exposes
// per-queue / per-worker factories with BullMQ defaults. We mock ioredis +
// bullmq so the module can be required without a real Redis.

const mockRedisQuit = jest.fn().mockResolvedValue('OK');
const mockRedisCtor = jest.fn().mockImplementation(function (this: unknown) {
  Object.assign(this as object, { quit: mockRedisQuit });
});
jest.mock('ioredis', () => mockRedisCtor);

const mockQueueClose = jest.fn().mockResolvedValue(undefined);
const mockQueueCtor = jest.fn().mockImplementation(function (
  this: unknown,
  name: string,
  opts: unknown,
) {
  Object.assign(this as object, { name, opts, close: mockQueueClose });
});

const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn().mockResolvedValue(undefined);
const mockWorkerCtor = jest.fn().mockImplementation(function (
  this: unknown,
  name: string,
  processor: unknown,
  opts: unknown,
) {
  Object.assign(this as object, {
    name,
    processor,
    opts,
    on: mockWorkerOn,
    close: mockWorkerClose,
  });
});

jest.mock('bullmq', () => ({
  Queue: mockQueueCtor,
  Worker: mockWorkerCtor,
}));

const mockLoggerError = jest.fn();
const mockLoggerCtor = jest.fn().mockImplementation(function (this: unknown) {
  Object.assign(this as object, { error: mockLoggerError });
});
jest.mock('@nestjs/common', () => ({
  Logger: mockLoggerCtor,
}));

function importQueues(): typeof import('./queues') {
  let mod!: typeof import('./queues');
  jest.isolateModules(() => {
    mod = require('./queues');
  });
  return mod;
}

describe('queues module — import-time validation', () => {
  const ORIG_ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.REDIS_URL;
    delete process.env.ENV;
    mockRedisCtor.mockClear();
    mockQueueCtor.mockClear();
    mockWorkerCtor.mockClear();
    mockWorkerOn.mockClear();
  });
  afterAll(() => {
    process.env = ORIG_ENV;
  });

  it('throws when REDIS_URL is not set', () => {
    expect(() => importQueues()).toThrow(
      'REDIS_URL environment variable is required.',
    );
  });

  it('opens a single shared Redis connection with maxRetriesPerRequest=null', () => {
    process.env.REDIS_URL = 'redis://test/0';
    importQueues();
    expect(mockRedisCtor).toHaveBeenCalledTimes(1);
    expect(mockRedisCtor).toHaveBeenCalledWith('redis://test/0', {
      maxRetriesPerRequest: null,
    });
  });
});

describe('QUEUE_NAMES — exact map', () => {
  it('exposes the five queue names verbatim', () => {
    process.env.REDIS_URL = 'redis://test/0';
    const { QUEUE_NAMES } = importQueues();
    expect(QUEUE_NAMES).toEqual({
      INGEST: 'ingest',
      PROCESS_MESSAGE: 'process-message',
      PROCESS_STATUS: 'process-status',
      PROCESS_ERRORS: 'process-errors',
      PROCESS_MESSAGE_TIMEOUT: 'process-message-timeout',
    });
  });
});

describe('createQueue', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://test/0';
    delete process.env.ENV;
    mockQueueCtor.mockClear();
  });

  it('uses default prefix `{wabot:development}` when ENV is unset', () => {
    const { createQueue } = importQueues();
    createQueue('ingest');
    const opts = mockQueueCtor.mock.calls[0][1] as { prefix: string };
    expect(opts.prefix).toBe('{wabot:development}');
  });

  it('uses `{wabot:<ENV>}` prefix when ENV is set', () => {
    process.env.ENV = 'production';
    const { createQueue } = importQueues();
    createQueue('ingest');
    const opts = mockQueueCtor.mock.calls[0][1] as { prefix: string };
    expect(opts.prefix).toBe('{wabot:production}');
  });

  it('wires the shared connection + default jobOptions (attempts 3 + exponential 1s backoff)', () => {
    const { createQueue } = importQueues();
    createQueue('ingest');
    const opts = mockQueueCtor.mock.calls[0][1] as {
      connection: unknown;
      defaultJobOptions: {
        attempts: number;
        backoff: { type: string; delay: number };
      };
    };
    expect(opts.connection).toBeDefined();
    expect(opts.defaultJobOptions.attempts).toBe(3);
    expect(opts.defaultJobOptions.backoff).toEqual({
      type: 'exponential',
      delay: 1_000,
    });
  });

  it('caller-supplied defaultJobOptions override the defaults via shallow spread', () => {
    const { createQueue } = importQueues();
    createQueue('ingest', { attempts: 7 });
    const opts = mockQueueCtor.mock.calls[0][1] as {
      defaultJobOptions: { attempts: number; backoff: unknown };
    };
    expect(opts.defaultJobOptions.attempts).toBe(7);
    // backoff still comes from the defaults (override didn't touch it)
    expect(opts.defaultJobOptions.backoff).toEqual({
      type: 'exponential',
      delay: 1_000,
    });
  });
});

describe('createWorker', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://test/0';
    mockWorkerCtor.mockClear();
    mockWorkerOn.mockClear();
  });

  it('constructs Worker with name + processor + connection + prefix + extra opts', () => {
    const { createWorker } = importQueues();
    const processor = jest.fn();
    createWorker('process-message', processor, { concurrency: 4 });
    expect(mockWorkerCtor).toHaveBeenCalledTimes(1);
    const [name, proc, opts] = mockWorkerCtor.mock.calls[0];
    expect(name).toBe('process-message');
    expect(proc).toBe(processor);
    expect((opts as { concurrency: number }).concurrency).toBe(4);
    expect((opts as { connection: unknown }).connection).toBeDefined();
    expect((opts as { prefix: string }).prefix).toMatch(/^\{wabot:/);
  });

  it('registers `error` and `failed` event handlers that log the worker name + job id', () => {
    mockLoggerError.mockClear();
    const { createWorker } = importQueues();
    createWorker('process-message', jest.fn());
    const errorHandler = mockWorkerOn.mock.calls.find((c) => c[0] === 'error');
    const failedHandler = mockWorkerOn.mock.calls.find(
      (c) => c[0] === 'failed',
    );
    expect(errorHandler).toBeDefined();
    expect(failedHandler).toBeDefined();
    (errorHandler![1] as (e: Error) => void)(new Error('eboom'));
    (failedHandler![1] as (j: unknown, e: Error) => void)(
      { id: 'j-1' },
      new Error('fboom'),
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Worker [process-message] error: eboom',
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Job j-1 failed on [process-message]: fboom',
    );
  });

  it('failed-handler stringifies a missing job.id as "undefined"', () => {
    mockLoggerError.mockClear();
    const { createWorker } = importQueues();
    createWorker('process-status', jest.fn());
    const failedHandler = mockWorkerOn.mock.calls.find(
      (c) => c[0] === 'failed',
    );
    (failedHandler![1] as (j: unknown, e: Error) => void)(
      undefined,
      new Error('x'),
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      'Job undefined failed on [process-status]: x',
    );
  });
});

describe('closeAll', () => {
  beforeEach(() => {
    process.env.REDIS_URL = 'redis://test/0';
    mockRedisQuit.mockClear();
    mockQueueClose.mockClear();
    mockWorkerClose.mockClear();
  });

  it('closes every registered worker + queue + the redis connection', async () => {
    const mod = importQueues();
    mod.createWorker('process-message', jest.fn());
    mod.createWorker('process-status', jest.fn());
    mod.createQueue('ingest');
    mod.createQueue('process-errors');
    await mod.closeAll();
    expect(mockWorkerClose).toHaveBeenCalledTimes(2);
    expect(mockQueueClose).toHaveBeenCalledTimes(2);
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
  });
});
