import { Logger } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';
import { connection } from '../../redis/queues.js';
import { messageE2eDuration } from '../../../otel/metrics.js';
import { toLogId } from '../../../otel/pii.js';
import type { OutboundMediaItemDto } from '../../pp/inbound/inbound.dto.js';
import type { SendMessageResultDto } from './outbound.dto.js';

const logger = new Logger('WhatsAppOutboundService');

const env = process.env.ENV ?? 'development';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }
  return value;
}

function graphUrl(): string {
  return `https://graph.facebook.com/v21.0/${getRequiredEnv('PHONE_NUMBER_ID')}/messages`;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${getRequiredEnv('WHATSAPP_ACCESS_TOKEN')}`,
    'Content-Type': 'application/json',
  };
}

export async function sendReadAndTypingIndicator(wamid: string): Promise<void> {
  const body = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: wamid,
    typing_indicator: { type: 'text' },
  };

  const response = await fetch(graphUrl(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(
      `WhatsApp read/typing API returned ${String(response.status)}`,
    );
  }
}

function sanitizeForLog(raw: string): string {
  return raw
    .replace(/\+?\d{8,15}/g, '[REDACTED_PHONE]')
    .replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      '[REDACTED_EMAIL]',
    );
}

async function safeReadErrorBody(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return '<body read failed>';
  }
  try {
    const parsed = JSON.parse(text) as {
      error?: {
        code?: number;
        type?: string;
        error_subcode?: number;
        fbtrace_id?: string;
        message?: string;
      };
    };
    const e = parsed.error ?? {};
    return JSON.stringify({
      code: e.code,
      type: e.type,
      error_subcode: e.error_subcode,
      fbtrace_id: e.fbtrace_id,
      message: e.message ? sanitizeForLog(e.message) : undefined,
    });
  } catch {
    return sanitizeForLog(text.slice(0, 500));
  }
}

// Atomically check both keys exist, then DEL only the inflight key.
// Returns the original PTTL (ms) of the inflight key on claim, 0 otherwise.
// Caller uses the PTTL to recreate the inflight key if the WhatsApp send
// fails, so a retry/timeout/fallback can claim again. The consec key is
// left intact and is only DEL'd by sendMessage on a successful send.
export const CLAIM_LUA = `
local e1 = redis.call('EXISTS', KEYS[1])
local e2 = redis.call('EXISTS', KEYS[2])
if e1 == 1 and e2 == 1 then
  local pttl = redis.call('PTTL', KEYS[1])
  redis.call('DEL', KEYS[1])
  if pttl < 0 then pttl = 25000 end
  return pttl
else
  return 0
end
`;

function buildWaPayload(opts: {
  user_id: string;
  item: OutboundMediaItemDto;
}): Record<string, unknown> {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.user_id,
    type: opts.item.type,
  };

  if (opts.item.type === 'text') {
    return { ...base, text: { body: opts.item.body } };
  }

  const mediaObject = opts.item.url?.startsWith('http')
    ? { link: opts.item.url }
    : { id: opts.item.url };

  return { ...base, [opts.item.type]: mediaObject };
}

async function sendSingleItem(opts: {
  user_id: string;
  item: OutboundMediaItemDto;
}): Promise<Response> {
  const deadline = Date.now() + 5_000;
  let delay = 500;

  for (;;) {
    const response = await fetch(graphUrl(), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(buildWaPayload(opts)),
    });

    if (response.status >= 200 && response.status < 300) {
      return response;
    }

    if (response.status >= 400 && response.status < 500) {
      return response;
    }

    const remaining = deadline - Date.now();
    if (remaining <= delay) {
      logger.error(
        `WhatsApp 5XX persisted after retries for user ${toLogId(opts.user_id)}`,
      );
      return response;
    }

    logger.warn(
      `WhatsApp returned ${String(response.status)}, retrying in ${String(delay)}ms`,
    );
    await new Promise<void>((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5_000);
  }
}

function inferFallbackMediaType(url: string): 'audio' | 'video' {
  const lower = url.toLowerCase();
  if (/\.(mp3|ogg|opus|aac|m4a)(\?|$)/.test(lower)) {
    return 'audio';
  }
  return 'video';
}

// Direct WhatsApp send for the fallback message — bypasses claim/inflight
// machinery so it works even when the inflight key cannot be recreated.
async function sendFallbackRaw(user_id: string): Promise<boolean> {
  const fallbackUrl = process.env.FALL_BACK_MESSAGE_PUBLIC_URL;
  if (!fallbackUrl) {
    logger.error(
      `FALL_BACK_MESSAGE_PUBLIC_URL not configured — cannot send fallback for user ${toLogId(user_id)}`,
    );
    return false;
  }
  try {
    const type = inferFallbackMediaType(fallbackUrl);
    const response = await fetch(graphUrl(), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: user_id,
        type,
        [type]: { link: fallbackUrl },
      }),
    });
    if (response.status >= 200 && response.status < 300) return true;
    const errBody = await safeReadErrorBody(response);
    logger.warn(
      `Fallback returned ${String(response.status)} for user ${toLogId(user_id)}: ${errBody}`,
    );
    return false;
  } catch (err) {
    logger.warn(
      `Fallback threw for user ${toLogId(user_id)}: ${(err as Error).message}`,
    );
    return false;
  }
}

async function sendFallbackWithRetry(user_id: string): Promise<void> {
  if (await sendFallbackRaw(user_id)) {
    logger.log(`Fallback delivered for user ${toLogId(user_id)}`);
    return;
  }
  // Spec: if first attempt fails, wait 1s and retry once.
  await new Promise<void>((r) => setTimeout(r, 1000));
  if (await sendFallbackRaw(user_id)) {
    logger.log(
      `Fallback delivered (2nd attempt) for user ${toLogId(user_id)}`,
    );
    return;
  }
  logger.error(
    `Fallback failed twice for user ${toLogId(user_id)} — giving up`,
  );
}

async function recreateInflightWithRetry(
  inflightKey: string,
  ttlMs: number,
  user_id: string,
): Promise<boolean> {
  try {
    await connection.set(inflightKey, '1', 'PX', ttlMs);
    return true;
  } catch (err) {
    logger.warn(
      `Inflight recreate failed (1st attempt) for user ${toLogId(user_id)}: ${(err as Error).message}`,
    );
  }
  try {
    await connection.set(inflightKey, '1', 'PX', ttlMs);
    return true;
  } catch (err) {
    logger.error(
      `Inflight recreate failed (2nd attempt) for user ${toLogId(user_id)}: ${(err as Error).message}`,
    );
    return false;
  }
}

async function deleteConsecutiveWithRetry(
  consecutiveKey: string,
  user_id: string,
): Promise<void> {
  try {
    await connection.del(consecutiveKey);
    return;
  } catch (err) {
    logger.warn(
      `Consec delete failed (1st attempt) for user ${toLogId(user_id)}: ${(err as Error).message}`,
    );
  }
  try {
    await connection.del(consecutiveKey);
  } catch (err) {
    logger.error(
      `Consec delete failed (2nd attempt) for user ${toLogId(user_id)} — giving up (TTL will expire): ${(err as Error).message}`,
    );
  }
}

export async function sendMessage(opts: {
  user_id: string;
  wamid: string;
  consecutive: boolean | undefined;
  media: OutboundMediaItemDto[];
}): Promise<{ status: number; body: SendMessageResultDto }> {
  // Read W3C Baggage from the active context. processMessage /
  // processMessageTimeout / pp/inbound/inbound.controller all wrap the call to
  // sendMessage in context.with(ctxWithBaggage, ...) so context.active() here
  // returns the enriched context — see otel/metrics.prompt.md for the full
  // propagation chain. If the baggage is missing, we warn and skip the metric
  // (self-monitoring signal: persistent WARN volume = propagation is broken).
  const baggage = propagation.getBaggage(context.active());
  const tsRaw = baggage?.getEntry('wabot.msg.ts_ms')?.value;
  const originalTsMs = tsRaw ? parseInt(tsRaw, 10) : undefined;
  if (originalTsMs === undefined || Number.isNaN(originalTsMs)) {
    logger.warn(
      `Missing wabot.msg.ts_ms baggage in sendMessage for user ${toLogId(opts.user_id)}, wamid=${opts.wamid} — delivery latency metric will not be recorded`,
    );
  }

  const recordDeliveryOutcome = (
    outcome: 'delivered' | 'inflight-expired' | 'whatsapp-error',
  ): void => {
    if (originalTsMs === undefined || Number.isNaN(originalTsMs)) return;
    messageE2eDuration.record(Date.now() - originalTsMs, { outcome });
  };

  let inflightKey: string | null = null;
  let consecutiveKey: string | null = null;
  let claimedTtlMs = 0;
  let claimAtMs = 0;

  if (!opts.consecutive) {
    inflightKey = `{wabot:${env}}:inflight:user-id:${opts.user_id}:wamid:${opts.wamid}`;
    consecutiveKey = `{wabot:${env}}:consecutive-check:user-id:${opts.user_id}`;

    const claim = (await connection.eval(
      CLAIM_LUA,
      2,
      inflightKey,
      consecutiveKey,
    )) as number;

    if (claim === 0) {
      // Either key absent: another invocation already claimed and sent
      // (benign race) OR the keys were never set / already expired.
      logger.warn(
        `Inflight window expired (no delivery) for user ${toLogId(opts.user_id)}, wamid ${opts.wamid}`,
      );
      recordDeliveryOutcome('inflight-expired');
      return {
        status: 200,
        body: { delivered: false, reason: 'inflight-expired' },
      };
    }

    claimedTtlMs = claim;
    claimAtMs = Date.now();
  }

  for (const item of opts.media) {
    const response = await sendSingleItem({
      user_id: opts.user_id,
      item,
    });

    if (response.status >= 400) {
      const errBody = await safeReadErrorBody(response);
      logger.error(
        `WhatsApp returned ${String(response.status)} for user ${toLogId(opts.user_id)}: ${errBody}`,
      );

      // Recover inflight so a retry / timeout job / fallback can claim again.
      // consecutiveKey was never deleted at claim — it's still present.
      if (inflightKey) {
        const remainingMs = claimedTtlMs - (Date.now() - claimAtMs);
        let recreated = false;
        if (remainingMs > 0) {
          recreated = await recreateInflightWithRetry(
            inflightKey,
            remainingMs,
            opts.user_id,
          );
        } else {
          logger.warn(
            `Inflight TTL exhausted by WA round-trip (elapsed=${String(
              Date.now() - claimAtMs,
            )}ms, original=${String(claimedTtlMs)}ms) for user ${toLogId(opts.user_id)}`,
          );
        }
        if (!recreated) {
          await sendFallbackWithRetry(opts.user_id);
        }
      }

      recordDeliveryOutcome('whatsapp-error');
      return {
        status: response.status,
        body: { delivered: false, reason: 'whatsapp-error' as const },
      };
    }
  }

  // All sends succeeded. Release the per-user consec lock.
  if (consecutiveKey) {
    await deleteConsecutiveWithRetry(consecutiveKey, opts.user_id);
  }

  recordDeliveryOutcome('delivered');
  return { status: 200, body: { delivered: true } };
}

export interface SendNotificationResult {
  status: number;
  delivered: boolean;
  error_code?: number;
}

export async function sendNotification(opts: {
  user_id: string;
  media: OutboundMediaItemDto[];
}): Promise<SendNotificationResult> {
  for (const item of opts.media) {
    const payload = buildWaPayload({ user_id: opts.user_id, item });
    const response = await fetch(graphUrl(), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      let body: { error?: { code?: number; message?: string } } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        // response body wasn't JSON
      }

      const errorCode = body.error?.code;

      if (errorCode === 130429) {
        logger.warn(
          `WhatsApp rate-limit (130429) for user ${toLogId(opts.user_id)}`,
        );
        return { status: 429, delivered: false, error_code: 130429 };
      }

      if (errorCode === 131047) {
        logger.error(
          `Message failed: outside 24-hour window (131047) for user ${toLogId(opts.user_id)}`,
        );
        return { status: 403, delivered: false, error_code: 131047 };
      }

      logger.error(
        `WhatsApp returned ${String(response.status)} for notification to user ${toLogId(opts.user_id)}: ${body.error?.message ?? 'unknown'}`,
      );
      return {
        status: response.status,
        delivered: false,
        error_code: errorCode,
      };
    }
  }

  return { status: 200, delivered: true };
}

export async function downloadMedia(
  mediaUrl: string,
): Promise<{ stream: NodeJS.ReadableStream; content_type: string }> {
  const response = await fetch(mediaUrl, {
    headers: {
      Authorization: `Bearer ${getRequiredEnv('WHATSAPP_ACCESS_TOKEN')}`,
    },
  });

  if (response.status === 404) {
    logger.warn(`Media URL returned 404 (likely expired): ${mediaUrl}`);
    throw new Error('Media URL returned 404');
  }

  if (!response.ok) {
    logger.warn(`Media URL returned ${String(response.status)}: ${mediaUrl}`);
    throw new Error(`Media download failed with ${String(response.status)}`);
  }

  const contentType =
    response.headers.get('content-type') ?? 'application/octet-stream';
  const body = response.body;
  if (!body) {
    throw new Error('Response body is null');
  }

  return {
    stream: body as unknown as NodeJS.ReadableStream,
    content_type: contentType,
  };
}

export async function uploadMedia(opts: {
  data: Buffer;
  content_type: string;
  media_type: string;
}): Promise<{ wa_media_url: string }> {
  const mimeExtensionMap: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
  };
  const fallbackByMediaType: Record<string, string> = {
    audio: 'mp3',
    video: 'mp4',
    image: 'jpg',
    sticker: 'webp',
  };
  const ext =
    mimeExtensionMap[opts.content_type] ??
    fallbackByMediaType[opts.media_type] ??
    'bin';
  const filename = `upload.${ext}`;

  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(opts.data)], { type: opts.content_type }),
    filename,
  );
  form.append('type', opts.content_type);
  form.append('messaging_product', 'whatsapp');

  const url = `https://graph.facebook.com/v21.0/${getRequiredEnv('PHONE_NUMBER_ID')}/media`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getRequiredEnv('WHATSAPP_ACCESS_TOKEN')}`,
    },
    body: form,
  });

  if (response.status >= 400 && response.status < 500) {
    const text = await response.text();
    logger.error(`Upload media 4XX: ${text}`);
    throw new Error(`Upload failed with ${String(response.status)}`);
  }

  if (response.status >= 500) {
    const text = await response.text();
    logger.warn(`Upload media 5XX: ${text}`);
    throw new Error(`Upload failed with ${String(response.status)}`);
  }

  const json = (await response.json()) as { id: string };
  return { wa_media_url: json.id };
}
