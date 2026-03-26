import './otel/otel';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { OtelLogger } from './otel/otel-logger.js';
import {
  closeAll,
  createWorker,
  QUEUE_NAMES,
} from './interfaces/redis/queues.js';
import { parseParse } from './interfaces/whatsapp/inbound/parse/parse.processor.js';
import {
  processMessage,
  processMessageTimeout,
} from './interfaces/whatsapp/inbound/process/message/message.processor.js';
import { processStatus } from './interfaces/whatsapp/inbound/process/status/status.processor.js';
import { processError } from './interfaces/whatsapp/inbound/process/error/error.processor.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: new OtelLogger(),
  });

  createWorker(QUEUE_NAMES.INGEST, parseParse);
  createWorker(QUEUE_NAMES.PROCESS_MESSAGE, processMessage);
  createWorker(QUEUE_NAMES.PROCESS_MESSAGE_TIMEOUT, processMessageTimeout);
  createWorker(QUEUE_NAMES.PROCESS_STATUS, processStatus);
  createWorker(QUEUE_NAMES.PROCESS_ERRORS, processError);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`Received ${signal}, shutting down gracefully…`);
    await closeAll();
    await app.close();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(process.env.PORT ?? 3000);
}

void bootstrap().catch((error: unknown) => {
  const details =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // eslint-disable-next-line no-console
  console.error(`Application failed to start: ${details}`);
  process.exitCode = 1;
});
