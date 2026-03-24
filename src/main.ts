import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

type WorkerFactory = (
  name: string,
  processor: (job: unknown) => Promise<unknown>,
) => unknown;

type QueueNames = {
  INGEST: string;
  PROCESS_MESSAGE: string;
  PROCESS_STATUS: string;
  PROCESS_ERRORS: string;
  PROCESS_MESSAGE_TIMEOUT: string;
};

const logger = new Logger('Bootstrap');

function asAsyncProcessor(
  processorModule: Record<string, unknown>,
  candidates: readonly string[],
): (job: unknown) => Promise<unknown> {
  for (const candidate of candidates) {
    const resolved = processorModule[candidate];
    if (typeof resolved === 'function') {
      return async (job: unknown): Promise<unknown> =>
        (
          resolved as (input: unknown) => unknown | Promise<unknown>
        )(job);
    }
  }

  throw new Error(
    `No processor function found. Tried: ${candidates.join(', ')}`,
  );
}

async function initializeOtelSdk(): Promise<void> {
  const modulePath = './otel/' + 'otel';
  const otelModule = (await import(modulePath)) as Record<string, unknown>;

  const initializerCandidates = [
    'initializeOtelSdk',
    'initializeOtel',
    'initOtel',
    'setupOtel',
    'startOtel',
    'start',
  ] as const;

  for (const candidate of initializerCandidates) {
    const initializer = otelModule[candidate];
    if (typeof initializer === 'function') {
      await (initializer as () => Promise<unknown> | unknown)();
      logger.log(`OTel initialized via ${candidate}().`);
      return;
    }
  }

  logger.warn(
    'No OTel initializer export found in src/otel/otel.ts; continuing startup.',
  );
}

async function startBullWorkers(): Promise<void> {
  const queuesModulePath = './interfaces/redis/' + 'queues';
  const queuesModule = (await import(queuesModulePath)) as Record<
    string,
    unknown
  >;
  const createWorker = queuesModule.createWorker as WorkerFactory | undefined;
  if (typeof createWorker !== 'function') {
    throw new Error(
      'createWorker() was not found in src/interfaces/redis/queues.ts',
    );
  }

  const queueNames =
    (queuesModule.QUEUE_NAMES as QueueNames | undefined) ??
    ({
      INGEST: 'ingest',
      PROCESS_MESSAGE: 'process-message',
      PROCESS_STATUS: 'process-status',
      PROCESS_ERRORS: 'process-errors',
      PROCESS_MESSAGE_TIMEOUT: 'process-message-timeout',
    } satisfies QueueNames);

  const parseModule = (await import(
    './interfaces/whatsapp/inbound/parse/' + 'parse.processor'
  )) as Record<string, unknown>;
  const messageModule = (await import(
    './interfaces/whatsapp/inbound/process/message/' + 'message.processor'
  )) as Record<string, unknown>;
  const statusModule = (await import(
    './interfaces/whatsapp/inbound/process/status/' + 'status.processor'
  )) as Record<string, unknown>;
  const errorModule = (await import(
    './interfaces/whatsapp/inbound/process/error/' + 'error.processor'
  )) as Record<string, unknown>;

  const parseProcessor = asAsyncProcessor(parseModule, [
    'processJob',
    'process',
    'default',
  ]);
  const messageProcessor = asAsyncProcessor(messageModule, [
    'processJob',
    'process',
    'default',
  ]);
  const statusProcessor = asAsyncProcessor(statusModule, [
    'processJob',
    'process',
    'default',
  ]);
  const errorProcessor = asAsyncProcessor(errorModule, [
    'processJob',
    'process',
    'default',
  ]);

  createWorker(queueNames.INGEST, parseProcessor);
  createWorker(queueNames.PROCESS_MESSAGE, messageProcessor);
  createWorker(queueNames.PROCESS_STATUS, statusProcessor);
  createWorker(queueNames.PROCESS_ERRORS, errorProcessor);
  createWorker(queueNames.PROCESS_MESSAGE_TIMEOUT, messageProcessor);

  logger.log('BullMQ workers started.');
}

async function bootstrap(): Promise<void> {
  await initializeOtelSdk();

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  await startBullWorkers();
  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap().catch((error: unknown) => {
  const details =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  logger.error(`Application failed to start: ${details}`);
  process.exitCode = 1;
});
