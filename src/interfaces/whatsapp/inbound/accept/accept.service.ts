import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OtelCarrier } from '../../../../otel/otel.dto.js';
import { createQueue, QUEUE_NAMES } from '../../../redis/queues.js';

@Injectable()
export class AcceptService {
  private readonly logger = new Logger(AcceptService.name);
  private readonly ingestQueue: Queue;

  constructor() {
    this.ingestQueue = createQueue(QUEUE_NAMES.INGEST);
  }

  isValidSignature(
    signatureHeader: string | undefined,
    rawBody: Buffer,
  ): boolean {
    if (typeof signatureHeader !== 'string' || !Buffer.isBuffer(rawBody)) {
      this.logger.warn('isValidSignature(): invalid parameter data type.');
      return false;
    }

    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
      this.logger.warn('META_APP_SECRET is not configured.');
      return false;
    }

    return this.validateSignature(signatureHeader, rawBody, appSecret);
  }

  async receiveWebhook(
    body: unknown,
    otelCarrier: OtelCarrier,
  ): Promise<number> {
    const deadline = Date.now() + 10_000;
    let delay = 500;

    for (;;) {
      try {
        await this.ingestQueue.add('webhook', {
          otel: { carrier: otelCarrier },
          body,
        });
        this.logger.log('Job enqueued on ingest queue');
        return 200;
      } catch (error: unknown) {
        const remaining = deadline - Date.now();
        if (remaining <= delay) {
          this.logger.error(
            `Failed to enqueue ingest job after retries: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return 500;
        }
        this.logger.warn(`Enqueue attempt failed, retrying in ${delay}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 5_000);
      }
    }
  }

  private validateSignature(
    signatureHeader: string,
    rawBody: Buffer,
    appSecret: string,
  ): boolean {
    const prefix = 'sha256=';
    if (!signatureHeader.startsWith(prefix)) {
      this.logger.warn('X-Hub-Signature-256 missing sha256= prefix.');
      return false;
    }

    const receivedHex = signatureHeader.slice(prefix.length).trim();
    if (!/^[0-9a-f]{64}$/i.test(receivedHex)) {
      this.logger.warn('X-Hub-Signature-256 digest is malformed.');
      return false;
    }

    const expectedHex = createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');

    const expected = Buffer.from(expectedHex, 'hex');
    const received = Buffer.from(receivedHex, 'hex');

    if (expected.length !== received.length) {
      this.logger.warn('X-Hub-Signature-256 validation failed.');
      return false;
    }

    if (!timingSafeEqual(expected, received)) {
      this.logger.warn('X-Hub-Signature-256 validation failed.');
      return false;
    }

    return true;
  }
}
