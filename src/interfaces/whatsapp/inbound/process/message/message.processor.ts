import { Logger } from '@nestjs/common';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Job, Processor, Queue } from 'bullmq';
import type { OtelCarrier } from '../../../../../otel/otel.dto.js';
import {
  connection,
  createQueue,
  QUEUE_NAMES,
} from '../../../../redis/queues.js';
import { validateJobData } from '../../../../../validation/validate-job.js';
import * as waOutbound from '../../../outbound/outbound.service.js';
import * as ppOutbound from '../../../../pp/outbound/outbound.service.js';
import { messageE2eDuration } from '../../../../../otel/metrics.js';
import { MessageJobDto } from './message.dto.js';

const logger = new Logger('MessageProcessor');
const tracer = trace.getTracer('message-processor');

const env = process.env.ENV ?? 'development';
const DEDUPE_TTL_SECONDS = 604_800; // 7 days

const timeoutQueue: Queue = createQueue(QUEUE_NAMES.PROCESS_MESSAGE_TIMEOUT);

const CONSECUTIVE_CHECK_LUA = `
local result = redis.call('SET', KEYS[1], '1', 'NX', 'EX', 25)
if result then
  redis.call('SET', KEYS[2], '1', 'EX', 25)
  return 0
else
  return 1
end
`;

async function redisWithRetry<T>(opts: {
  operation: () => Promise<T>;
  label: string;
}): Promise<T> {
  const deadline = Date.now() + 10_000;
  let delay = 500;

  for (;;) {
    try {
      return await opts.operation();
    } catch (error: unknown) {
      const remaining = deadline - Date.now();
      if (remaining <= delay) {
        const detail =
          error instanceof Error ? error.message : String(error);
        logger.error(`Redis ${opts.label} failed after retries: ${detail}`);
        throw error;
      }

      logger.warn(`Redis ${opts.label} failed, retrying in ${String(delay)}ms`);
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
}

function inferMediaType(url: string): 'audio' | 'video' {
  const lower = url.toLowerCase();
  if (/\.(mp3|ogg|opus|aac|m4a)(\?|$)/.test(lower)) {
    return 'audio';
  }
  return 'video';
}

function buildFallbackMedia(): { type: 'audio' | 'video'; url: string }[] {
  const url = process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
  if (!url) {
    logger.error('FALL_BACK_MESSAGE_PUBLIC_URL is not configured.');
    return [];
  }
  return [{ type: inferMediaType(url), url }];
}

async function sendFallback(opts: {
  userId: string;
  wamid: string;
}): Promise<void> {
  const media = buildFallbackMedia();
  if (media.length === 0) {
    logger.error(
      `Cannot send fallback for user ${opts.userId}: FALL_BACK_MESSAGE_PUBLIC_URL is not configured`,
    );
    return;
  }

  try {
    const result = await waOutbound.sendMessage({
      user_id: opts.userId,
      wamid: opts.wamid,
      consecutive: undefined,
      media,
    });
    logger.log(
      `Fallback message result for user ${opts.userId}: delivered=${String(result.body.delivered)}`,
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(
      `Fallback message failed for user ${opts.userId}: ${detail}`,
    );
  }
}

async function dedupeMessage(wamid: string): Promise<boolean> {
  const key = `{wabot:${env}}:dedupe:wamid:${wamid}`;
  const result = await redisWithRetry({
    operation: () => connection.set(key, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX'),
    label: 'dedupe',
  });
  return result === 'OK';
}

async function enqueueTimeout(opts: {
  userId: string;
  wamid: string;
  messageTimestamp: string;
  carrier: OtelCarrier;
}): Promise<void> {
  const timestampMs = parseInt(opts.messageTimestamp, 10) * 1000;
  const delay = Math.max(0, timestampMs + 20_000 - Date.now());

  const deadline = Date.now() + 10_000;
  let retryDelay = 500;

  for (;;) {
    try {
      await timeoutQueue.add(
        'timeout',
        {
          otel: { carrier: opts.carrier },
          userId: opts.userId,
          wamid: opts.wamid,
        },
        { delay },
      );
      return;
    } catch (error: unknown) {
      const remaining = deadline - Date.now();
      if (remaining <= retryDelay) {
        const detail =
          error instanceof Error ? error.message : String(error);
        logger.error(`Failed to enqueue timeout job after retries: ${detail}`);
        throw new Error('Failed to enqueue timeout job');
      }

      logger.warn(
        `Timeout enqueue failed, retrying in ${String(retryDelay)}ms`,
      );
      await new Promise<void>((r) => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 10_000);
    }
  }
}

async function checkConsecutive(opts: {
  userId: string;
  wamid: string;
}): Promise<boolean> {
  const consecutiveKey =
    `{wabot:${env}}:consecutive-check:user-id:${opts.userId}`;
  const inflightKey =
    `{wabot:${env}}:inflight:user-id:${opts.userId}:wamid:${opts.wamid}`;

  const result = await redisWithRetry({
    operation: () =>
      connection.eval(
        CONSECUTIVE_CHECK_LUA,
        2,
        consecutiveKey,
        inflightKey,
      ) as Promise<number>,
    label: 'consecutive-check',
  });

  return result === 1;
}

export const processMessage: Processor = async (job: Job): Promise<void> => {
  const parentCtx = propagation.extract(
    context.active(),
    (job.data as { otel?: { carrier?: OtelCarrier } })?.otel
      ?.carrier ?? {},
  );
  const span = tracer.startSpan('process-message', {}, parentCtx);
  const ctx = trace.setSpan(parentCtx, span);

  try {
    const result = validateJobData(MessageJobDto, job.data);
    if (!result.success) {
      logger.error(
        `Invalid message job data [job=${job.id}]: ${result.errors.join('; ')}`,
      );
      throw new Error('Invalid message job data');
    }

    const { message } = result.dto;
    const userId = message.from;
    const wamid = message.id;
    const messageTimestampMs = parseInt(message.timestamp, 10) * 1000;

    span.setAttribute('wamid', wamid);
    span.setAttribute('message.type', message.type);

    logger.log(
      `>>> MESSAGE REACHED PROCESSOR: wamid=${wamid} from=${userId} type=${message.type} body=${JSON.stringify(message.text?.body ?? message.audio?.mediaUrl ?? message.video?.mediaUrl ?? message.system?.body ?? '(no body)')}`,
    );

    let isNew: boolean;
    try {
      isNew = await dedupeMessage(wamid);
    } catch {
      await sendFallback({ userId, wamid });
      messageE2eDuration.record(Date.now() - messageTimestampMs, {
        outcome: 'fallback',
      });
      throw new Error('Redis dedupe unavailable');
    }

    if (!isNew) {
      logger.log(`Duplicate message ignored: wamid=${wamid}`);
      return;
    }

    const carrier: OtelCarrier = {};
    propagation.inject(ctx, carrier);

    const readReceiptPromise = waOutbound
      .sendReadAndTypingIndicator(wamid)
      .then(() => {
        logger.log(`Read receipt and typing indicator sent for wamid=${wamid}`);
      })
      .catch((error: unknown) => {
        const detail =
          error instanceof Error ? error.message : String(error);
        logger.warn(`Read/typing indicator failed for wamid=${wamid}: ${detail}`);
      });

    const timeoutPromise = enqueueTimeout({
      userId,
      wamid,
      messageTimestamp: message.timestamp,
      carrier,
    });

    const [, timeoutResult] = await Promise.allSettled([
      readReceiptPromise,
      timeoutPromise,
    ]);

    if (timeoutResult.status === 'rejected') {
      throw new Error('Failed to enqueue timeout job');
    }

    let isConsecutive: boolean;
    try {
      isConsecutive = await checkConsecutive({ userId, wamid });
    } catch {
      await sendFallback({ userId, wamid });
      messageE2eDuration.record(Date.now() - messageTimestampMs, {
        outcome: 'fallback',
      });
      throw new Error('Redis consecutive-check unavailable');
    }

    const ppStatus = await ppOutbound.sendMessage({
      otel: { carrier },
      message,
      consecutive: isConsecutive,
    });

    if (ppStatus >= 200 && ppStatus < 300) {
      logger.log(
        `PP accepted message wamid=${wamid}, status=${String(ppStatus)}`,
      );
      messageE2eDuration.record(Date.now() - messageTimestampMs, {
        outcome: 'success',
      });
      return;
    }

    logger.error(
      `PP returned ${String(ppStatus)} for wamid=${wamid}`,
    );
    await sendFallback({ userId, wamid });
    messageE2eDuration.record(Date.now() - messageTimestampMs, {
      outcome: 'fallback',
    });
    throw new Error(`PP returned ${String(ppStatus)}`);
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

export const processMessageTimeout: Processor = async (
  job: Job,
): Promise<void> => {
  const data = job.data as {
    otel?: { carrier?: OtelCarrier };
    userId?: string;
    wamid?: string;
  };

  const parentCtx = propagation.extract(
    context.active(),
    data.otel?.carrier ?? {},
  );
  const span = tracer.startSpan('process-message-timeout', {}, parentCtx);

  try {
    const userId = data.userId;
    const wamid = data.wamid;

    if (!userId || !wamid) {
      logger.error(
        `Invalid timeout job data [job=${job.id}]: missing userId or wamid`,
      );
      throw new Error('Invalid timeout job data');
    }

    const result = await waOutbound.sendMessage({
      user_id: userId,
      wamid,
      consecutive: undefined,
      media: buildFallbackMedia(),
    });

    logger.log(
      `Timeout fallback for user ${userId}: delivered=${String(result.body.delivered)}`,
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
