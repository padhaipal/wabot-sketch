import { Logger } from '@nestjs/common';
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { Job, Processor } from 'bullmq';
import type { OtelCarrier } from '../../../../../otel/otel.dto.js';
import { validateJobData } from '../../../../../validation/validate-job.js';
import { StatusJobDto } from './status.dto.js';

const logger = new Logger('StatusProcessor');
const tracer = trace.getTracer('status-processor');

export const processStatus: Processor = async (job: Job): Promise<void> => {
  const parentCtx = propagation.extract(
    context.active(),
    (job.data as { otel?: { carrier?: OtelCarrier } })?.otel?.carrier ?? {},
  );
  const span = tracer.startSpan('process-status', {}, parentCtx);

  try {
    const result = validateJobData(StatusJobDto, job.data);
    if (!result.success) {
      logger.error(
        `Invalid status job data [job=${job.id}]: ${result.errors.join('; ')}`,
      );
      throw new Error('Invalid status job data');
    }

    const { status } = result.dto;

    span.setAttribute('status.id', status.id);
    span.setAttribute('status.status', status.status);
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
