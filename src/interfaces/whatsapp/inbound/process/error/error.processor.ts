import { Logger } from '@nestjs/common';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job, Processor } from 'bullmq';
import { validateJobData } from '../../../../../validation/validate-job.js';
import { ErrorJobDto } from './error.dto.js';

const logger = new Logger('ErrorProcessor');
const tracer = trace.getTracer('error-processor');

export const processError: Processor = async (job: Job): Promise<void> => {
  const parentCtx = propagation.extract(
    context.active(),
    (job.data as { otel?: { carrier?: Record<string, string> } })?.otel
      ?.carrier ?? {},
  );
  const span = tracer.startSpan('process-error', {}, parentCtx);

  try {
    const result = validateJobData(ErrorJobDto, job.data);
    if (!result.success) {
      logger.error(
        `Invalid error job data [job=${job.id}]: ${result.errors.join('; ')}`,
      );
      throw new Error('Invalid error job data');
    }

    const { error } = result.dto;

    span.setAttribute('wa_error.code', error.code);
    span.setAttribute('wa_error.title', error.title);

    logger.warn(`WhatsApp error received`, {
      errorCode: error.code,
      errorTitle: error.title,
      errorMessage: error.message,
      errorDetails: error.error_data.details,
      errorHref: error.href,
    });
  } catch (caughtError: unknown) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message:
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError),
    });
    span.recordException(
      caughtError instanceof Error
        ? caughtError
        : new Error(String(caughtError)),
    );
    throw caughtError;
  } finally {
    span.end();
  }
};
