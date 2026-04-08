import { Logger } from '@nestjs/common';
import { connection } from '../../redis/queues.js';
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

export async function sendReadAndTypingIndicator(
  wamid: string,
): Promise<void> {
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

const INFLIGHT_DEL_LUA = `
local del1 = redis.call('DEL', KEYS[1])
local del2 = redis.call('DEL', KEYS[2])
if del1 == 1 and del2 == 1 then
  return 1
else
  return 0
end
`;

function buildWaPayload(opts: {
  user_id: string;
  item: OutboundMediaItemDto;
}): Record<string, unknown> {
  // Auto-promote image/webp to sticker (WhatsApp does not accept webp as image).
  const effectiveType =
    opts.item.type === 'image' && opts.item.mime_type === 'image/webp'
      ? 'sticker'
      : opts.item.type;

  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: opts.user_id,
    type: effectiveType,
  };

  if (effectiveType === 'text') {
    return { ...base, text: { body: opts.item.body } };
  }

  const mediaObject = opts.item.url?.startsWith('http')
    ? { link: opts.item.url }
    : { id: opts.item.url };

  return { ...base, [effectiveType]: mediaObject };
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
        `WhatsApp 5XX persisted after retries for user ${opts.user_id}`,
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

export async function sendMessage(opts: {
  user_id: string;
  wamid: string;
  consecutive: boolean | undefined;
  media: OutboundMediaItemDto[];
}): Promise<{ status: number; body: SendMessageResultDto }> {
  if (!opts.consecutive) {
    const inflightKey =
      `{wabot:${env}}:inflight:user-id:${opts.user_id}:wamid:${opts.wamid}`;
    const consecutiveKey =
      `{wabot:${env}}:consecutive-check:user-id:${opts.user_id}`;

    const result = await connection.eval(
      INFLIGHT_DEL_LUA,
      2,
      inflightKey,
      consecutiveKey,
    );

    if (result === 0) {
      logger.log(
        `Inflight window expired for user ${opts.user_id}, wamid ${opts.wamid}`,
      );
      return {
        status: 200,
        body: { delivered: false, reason: 'inflight-expired' },
      };
    }
  }

  for (const item of opts.media) {
    const response = await sendSingleItem({
      user_id: opts.user_id,
      item,
    });

    if (response.status >= 400 && response.status < 500) {
      logger.error(
        `WhatsApp returned ${String(response.status)} for user ${opts.user_id}`,
      );
      return { status: response.status, body: { delivered: false, reason: 'whatsapp-error' as const } };
    }

    if (response.status >= 500) {
      logger.error(
        `WhatsApp returned ${String(response.status)} for user ${opts.user_id}`,
      );
      return { status: response.status, body: { delivered: false, reason: 'whatsapp-error' as const } };
    }

    logger.log(`Sent ${item.type} to user ${opts.user_id}`);
  }

  logger.log(`All media delivered to user ${opts.user_id}`);
  return { status: 200, body: { delivered: true } };
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

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
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
