import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import type { JobsOptions, Processor, WorkerOptions } from 'bullmq';
import Redis from 'ioredis';

export const QUEUE_NAMES = {
  INGEST: 'ingest',
  PROCESS_MESSAGE: 'process-message',
  PROCESS_STATUS: 'process-status',
  PROCESS_ERRORS: 'process-errors',
  PROCESS_MESSAGE_TIMEOUT: 'process-message-timeout',
} as const;

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error('REDIS_URL environment variable is required.');
}

const env = process.env.ENV ?? 'development';
const prefix = `{wabot:${env}}`;
const logger = new Logger('BullMQ');

export const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

const queues: Queue[] = [];
const workers: Worker[] = [];

export function createQueue(
  name: string,
  defaultJobOptions?: JobsOptions,
): Queue {
  const queue = new Queue(name, {
    connection,
    prefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
      ...defaultJobOptions,
    },
  });
  queues.push(queue);
  return queue;
}

export function createWorker(
  name: string,
  processor: Processor,
  opts?: Omit<WorkerOptions, 'connection' | 'prefix'>,
): Worker {
  const worker = new Worker(name, processor, {
    connection,
    prefix,
    ...opts,
  });

  worker.on('error', (err) => {
    logger.error(`Worker [${name}] error: ${err.message}`);
  });

  worker.on('failed', (job, err) => {
    logger.error(
      `Job ${String(job?.id)} failed on [${name}]: ${err.message}`,
    );
  });

  workers.push(worker);
  return worker;
}

export async function closeAll(): Promise<void> {
  await Promise.all(workers.map((w) => w.close()));
  await Promise.all(queues.map((q) => q.close()));
  await connection.quit();
}
