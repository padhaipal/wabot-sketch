import './otel/otel';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
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
  // Loki diagnostic probe: emit one log directly via the global OTel logs API
  // BEFORE NestJS is involved. If this line shows up in Loki under
  // service_name="wabot-sketch", the OTLP log pipeline is healthy and any
  // missing-log problem is in the NestJS-Logger ↔ OtelLogger plumbing.
  // If it does NOT appear, the OTLP export itself is broken (likely a
  // Railway env var like OTEL_LOGS_EXPORTER=otlp, or Alloy is dropping logs).
  logs.getLogger('wabot-startup-probe').emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: `wabot-sketch startup probe ts=${new Date().toISOString()}`,
    attributes: { 'probe.kind': 'startup', 'probe.version': '1' },
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: new OtelLogger(),
  });

  app.useStaticAssets(join(__dirname, '..', 'public'));
  app.useBodyParser('raw', {
    type: ['audio/*', 'video/*', 'image/*'],
    limit: '16mb',
  });

  createWorker(QUEUE_NAMES.INGEST, parseParse);
  createWorker(QUEUE_NAMES.PROCESS_MESSAGE, processMessage);
  createWorker(QUEUE_NAMES.PROCESS_MESSAGE_TIMEOUT, processMessageTimeout);
  createWorker(QUEUE_NAMES.PROCESS_STATUS, processStatus);
  createWorker(QUEUE_NAMES.PROCESS_ERRORS, processError);

  const shutdown = async (signal: string): Promise<void> => {
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

  console.error(`Application failed to start: ${details}`);
  process.exitCode = 1;
});
