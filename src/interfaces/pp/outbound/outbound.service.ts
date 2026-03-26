import { Logger } from '@nestjs/common';
import type { OtelCarrierDto } from '../../../otel/otel.dto.js';
import type { MessageDto } from '../../whatsapp/inbound/process/message/message.dto.js';

const logger = new Logger('PpOutboundService');

export async function sendMessage(opts: {
  otel: OtelCarrierDto;
  message: MessageDto;
  consecutive?: boolean;
}): Promise<number> {
  const baseUrl = process.env.PP_INTERNAL_BASE_URL;
  if (!baseUrl) {
    logger.error('PP_INTERNAL_BASE_URL is not configured.');
    return 500;
  }

  const url = `${baseUrl}/wabot/inbound`;
  const payload = {
    otel: opts.otel,
    message: opts.message,
    consecutive: opts.consecutive,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const status = response.status;

    if (status >= 200 && status < 300) {
      logger.log(`PP accepted message ${opts.message.id}`);
    } else if (status >= 400 && status < 500) {
      logger.error(
        `PP returned ${String(status)} for message ${opts.message.id}`,
      );
    } else {
      logger.error(
        `PP returned ${String(status)} for message ${opts.message.id}`,
      );
    }

    return status;
  } catch (error: unknown) {
    const detail =
      error instanceof Error ? error.message : String(error);
    logger.error(`PP request failed for message ${opts.message.id}: ${detail}`);
    return 500;
  }
}
