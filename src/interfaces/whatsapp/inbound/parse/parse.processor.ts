import { Logger } from '@nestjs/common';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job, Processor, Queue } from 'bullmq';
import type { OtelCarrier } from '../../../../otel/otel.dto.js';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  createQueue,
  QUEUE_NAMES,
} from '../../../redis/queues.js';
import { validateJobData } from '../../../../validation/validate-job.js';
import { MessageJobDto } from '../process/message/message.dto.js';
import { StatusJobDto } from '../process/status/status.dto.js';
import { ErrorJobDto } from '../process/error/error.dto.js';
import { ParseWebhookJobDto } from './parse.dto.js';

const logger = new Logger('ParseProcessor');
const tracer = trace.getTracer('parse-processor');

const messageQueue: Queue = createQueue(QUEUE_NAMES.PROCESS_MESSAGE);
const statusQueue: Queue = createQueue(QUEUE_NAMES.PROCESS_STATUS);
const errorQueue: Queue = createQueue(QUEUE_NAMES.PROCESS_ERRORS);

const businessAccountId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;

function validateDto<T extends object>(
  cls: new () => T,
  data: unknown,
): T | null {
  const instance = plainToInstance(cls, data as Record<string, unknown>);
  const errors = validateSync(instance);
  return errors.length === 0 ? instance : null;
}

interface ParsedJobs {
  messages: { name: string; data: unknown }[];
  statuses: { name: string; data: unknown }[];
  errors: { name: string; data: unknown }[];
}

function extractJobs(opts: {
  dto: ParseWebhookJobDto;
  carrier: OtelCarrier;
}): ParsedJobs {
  const result: ParsedJobs = { messages: [], statuses: [], errors: [] };

  if (!businessAccountId) {
    logger.warn(
      'WHATSAPP_BUSINESS_ACCOUNT_ID is not set; all webhook entries will be skipped',
    );
    return result;
  }

  for (const entry of opts.dto.body.entry) {
    if (entry.id !== businessAccountId) {
      continue;
    }

    for (const change of entry.changes) {
      const value = change.value;

      if ('messages' in value && Array.isArray(value.messages)) {
        for (const msg of value.messages as unknown[]) {
          const valid = validateDto(MessageJobDto, {
            otel: { carrier: opts.carrier },
            message: msg,
          });
          if (valid) {
            result.messages.push({ name: 'message', data: valid });
          } else {
            logger.warn(
              `Message dropped: failed MessageJobDto validation [keys=${Object.keys(msg as Record<string, unknown>).join(',')}]`,
            );
          }
        }
      }

      if ('statuses' in value && Array.isArray(value.statuses)) {
        for (const st of value.statuses as unknown[]) {
          const valid = validateDto(StatusJobDto, {
            otel: { carrier: opts.carrier },
            status: st,
          });
          if (valid) {
            result.statuses.push({ name: 'status', data: valid });
          }
        }
      }

      if ('errors' in value && Array.isArray(value.errors)) {
        for (const err of value.errors as unknown[]) {
          const valid = validateDto(ErrorJobDto, {
            otel: { carrier: opts.carrier },
            error: err,
          });
          if (valid) {
            result.errors.push({ name: 'error', data: valid });
          }
        }
      }
    }
  }

  return result;
}

const MAX_BACKOFF_DELAY_MS = 30_000;

async function bulkAddWithRetry(opts: {
  queue: Queue;
  jobs: { name: string; data: unknown }[];
  maxRetryMs: number;
  label: string;
}): Promise<void> {
  if (opts.jobs.length === 0) {
    return;
  }

  const deadline = Date.now() + opts.maxRetryMs;
  let delay = 500;

  for (;;) {
    try {
      await opts.queue.addBulk(opts.jobs);
      return;
    } catch (error: unknown) {
      const remaining = deadline - Date.now();
      if (remaining <= delay) {
        const detail =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to enqueue ${opts.label} jobs after retries: ${detail}`,
        );
        throw new Error(`Failed to enqueue ${opts.label} jobs`);
      }

      logger.warn(
        `${opts.label} bulk add failed, retrying in ${String(delay)}ms`,
      );
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, MAX_BACKOFF_DELAY_MS);
    }
  }
}

export const parseParse: Processor = async (job: Job): Promise<void> => {
  const parentCtx = propagation.extract(
    context.active(),
    (job.data as { otel?: { carrier?: OtelCarrier } })?.otel
      ?.carrier ?? {},
  );
  const span = tracer.startSpan('process-parse', {}, parentCtx);
  const ctx = trace.setSpan(parentCtx, span);

  try {
    const result = validateJobData(ParseWebhookJobDto, job.data);
    if (!result.success) {
      logger.error(
        `Invalid parse job data [job=${job.id}]: ${result.errors.join('; ')}`,
      );
      throw new Error('Invalid parse job data');
    }

    const carrier: OtelCarrier = {};
    propagation.inject(ctx, carrier);

    const jobs = extractJobs({ dto: result.dto, carrier });

    span.setAttribute('parse.message_count', jobs.messages.length);
    span.setAttribute('parse.status_count', jobs.statuses.length);
    span.setAttribute('parse.error_count', jobs.errors.length);

    await bulkAddWithRetry({
      queue: messageQueue,
      jobs: jobs.messages,
      maxRetryMs: 10_000,
      label: 'process-message',
    });

    await bulkAddWithRetry({
      queue: statusQueue,
      jobs: jobs.statuses,
      maxRetryMs: 86_400_000,
      label: 'process-status',
    });

    await bulkAddWithRetry({
      queue: errorQueue,
      jobs: jobs.errors,
      maxRetryMs: 86_400_000,
      label: 'process-errors',
    });

    logger.log(
      `Parsed webhook: ${String(jobs.messages.length)} messages, ` +
        `${String(jobs.statuses.length)} statuses, ` +
        `${String(jobs.errors.length)} errors`,
    );
  } catch (error: unknown) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.recordException(
      error instanceof Error ? error : new Error(String(error)),
    );
    throw error;
  } finally {
    span.end();
  }
};
