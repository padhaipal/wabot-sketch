import { Logger } from '@nestjs/common';
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { Job, Processor } from 'bullmq';
import type { OtelCarrier } from '../../../../../otel/otel.dto.js';
import { connection } from '../../../../redis/queues.js';
import {
  buildUserE2eAttributes,
  userE2eDuration,
} from '../../../../../otel/metrics.js';
import {
  USER_E2E_LATE_THRESHOLD_MS,
  userE2eKey,
  type UserE2eMapping,
} from '../../../../../otel/user-e2e.js';
import { validateJobData } from '../../../../../validation/validate-job.js';
import { StatusDto, StatusJobDto } from './status.dto.js';

const logger = new Logger('StatusProcessor');
const tracer = trace.getTracer('status-processor');

// Records the user_e2e SLO histogram: Meta-clock delta between the original
// user message (mapping written by outbound sendMessage under the reply's
// wamid) and this delivered/read status. GETDEL guarantees at-most-once even
// when Meta re-sends statuses. `read` is accepted as an upper bound for the
// rare case where the delivered status never arrives — GETDEL means whichever
// status lands first wins. Never throws: a metric miss must not fail (and
// re-run) status processing.
async function recordUserE2e(status: StatusDto): Promise<void> {
  try {
    const raw = await connection.getdel(userE2eKey(status.id));
    if (!raw) return;
    const mapping = JSON.parse(raw) as UserE2eMapping;
    if (typeof mapping.ts !== 'number') return;
    const deliveredMs = parseInt(status.timestamp, 10) * 1000;
    if (Number.isNaN(deliveredMs)) return;
    // Meta stamps both ends, but at 1 s resolution the delta can round to
    // -999..0 ms — clamp instead of dropping the sample.
    const deltaMs = Math.max(0, deliveredMs - mapping.ts);
    userE2eDuration.record(
      deltaMs,
      buildUserE2eAttributes(
        deltaMs <= USER_E2E_LATE_THRESHOLD_MS ? 'delivered' : 'late',
        mapping.lt ?? 'false',
        mapping.tp,
        mapping.rk,
      ),
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`user_e2e record failed for wamid=${status.id}: ${detail}`);
  }
}

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

    const errSummary =
      status.errors && status.errors.length > 0
        ? ` errors=${status.errors
            .map(
              (e) =>
                `${e.code ?? '?'}:${e.title ?? '?'}${
                  e.message ? `:${e.message}` : ''
                }`,
            )
            .join('|')}`
        : '';
    logger.log(
      `Status: ${status.status} wamid=${status.id} recipient=${status.recipient_id}${errSummary}`,
    );

    if (status.status === 'delivered' || status.status === 'read') {
      await recordUserE2e(status);
    }
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
