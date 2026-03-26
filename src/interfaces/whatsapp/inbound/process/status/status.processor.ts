import { Logger } from '@nestjs/common';
import { context, propagation, trace } from '@opentelemetry/api';
import type { Job, Processor } from 'bullmq';
import { validateJobData } from '../../../../../validation/validate-job.js';
import { StatusJobDto } from './status.dto.js';

const logger = new Logger('StatusProcessor');
const tracer = trace.getTracer('status-processor');

export const processStatus: Processor = async (job: Job): Promise<void> => {
  const parentCtx = propagation.extract(
    context.active(),
    (job.data as { otel?: { carrier?: Record<string, string> } })?.otel
      ?.carrier ?? {},
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

    logger.log(`WhatsApp status update received`, {
      statusId: status.id,
      status: status.status,
      timestamp: status.timestamp,
      recipientId: status.recipient_id,
    });
  } finally {
    span.end();
  }
};
