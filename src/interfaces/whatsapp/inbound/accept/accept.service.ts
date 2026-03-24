// wabot-sketch/src/interfaces/whatsapp/inbound/accept/accept.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

type ParseWebhookJobDto = {
  otel: {
    carrier: Record<string, string>;
  };
  body: {
    entry: unknown[];
  };
};

type QueueModule = {
  createQueue?: (
    name: string,
    defaultJobOptions?: Record<string, unknown>,
  ) => {
    add: (jobName: string, data: unknown) => Promise<unknown>;
  };
  QUEUE_NAMES?: {
    INGEST?: string;
  };
};

@Injectable()
export class AcceptService {
  private readonly logger = new Logger(AcceptService.name);
  private ingestQueuePromise:
    | Promise<{ add: (jobName: string, data: unknown) => Promise<unknown> }>
    | undefined;

  async receiveWebhook(input: {
    body: unknown;
    rawBody: Buffer;
    signatureHeader: string | undefined;
    otelCarrier: Record<string, string>;
  }): Promise<number> {
    if (!this.isValidInput(input)) {
      this.logger.warn('Invalid receiveWebhook() parameter data type.');
      return 400;
    }

    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
      this.logger.error('META_APP_SECRET is not set.');
      return 500;
    }

    const signatureIsValid = this.validateSignature({
      signatureHeader: input.signatureHeader,
      rawBody: input.rawBody,
      appSecret,
    });

    if (!signatureIsValid) {
      this.logger.warn('X-Hub-Signature-256 validation failed.');
      return 401;
    }

    const jobPayload: ParseWebhookJobDto = {
      otel: {
        carrier: input.otelCarrier,
      },
      body: input.body as ParseWebhookJobDto['body'],
    };

    try {
      const ingestQueue = await this.getIngestQueue();
      await this.retryWithBackoff(
        () => ingestQueue.add('webhook', jobPayload),
        10_000,
      );
      return 202;
    } catch (error: unknown) {
      const details =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(`Failed to enqueue webhook job on ingest queue: ${details}`);
      return 500;
    }
  }

  private isValidInput(input: {
    body: unknown;
    rawBody: Buffer;
    signatureHeader: string | undefined;
    otelCarrier: Record<string, string>;
  }): boolean {
    const bodyIsObject =
      input.body !== null &&
      typeof input.body === 'object' &&
      !Array.isArray(input.body);
    const rawBodyIsBuffer = Buffer.isBuffer(input.rawBody);
    const signatureTypeIsValid =
      input.signatureHeader === undefined ||
      typeof input.signatureHeader === 'string';
    const otelCarrierIsValid =
      input.otelCarrier !== null &&
      typeof input.otelCarrier === 'object' &&
      Object.values(input.otelCarrier).every(
        (value: unknown) => typeof value === 'string',
      );

    return (
      bodyIsObject &&
      rawBodyIsBuffer &&
      signatureTypeIsValid &&
      otelCarrierIsValid
    );
  }

  private validateSignature(input: {
    signatureHeader: string | undefined;
    rawBody: Buffer;
    appSecret: string;
  }): boolean {
    if (!input.signatureHeader) {
      return false;
    }

    const prefix = 'sha256=';
    if (!input.signatureHeader.startsWith(prefix)) {
      return false;
    }

    const incomingDigestHex = input.signatureHeader.slice(prefix.length).trim();
    if (!/^[0-9a-f]{64}$/i.test(incomingDigestHex)) {
      return false;
    }

    const expectedDigestHex = createHmac('sha256', input.appSecret)
      .update(input.rawBody)
      .digest('hex');

    const expected = Buffer.from(expectedDigestHex, 'hex');
    const incoming = Buffer.from(incomingDigestHex, 'hex');
    if (expected.length !== incoming.length) {
      return false;
    }

    return timingSafeEqual(expected, incoming);
  }

  private async getIngestQueue(): Promise<{
    add: (jobName: string, data: unknown) => Promise<unknown>;
  }> {
    if (!this.ingestQueuePromise) {
      this.ingestQueuePromise = this.createIngestQueue();
    }
    return this.ingestQueuePromise;
  }

  private async createIngestQueue(): Promise<{
    add: (jobName: string, data: unknown) => Promise<unknown>;
  }> {
    const modulePath = '../../../redis/' + 'queues';
    const queueModule = (await import(modulePath)) as QueueModule;

    if (typeof queueModule.createQueue !== 'function') {
      throw new Error('createQueue() is missing from src/interfaces/redis/queues.ts');
    }

    const ingestQueueName = queueModule.QUEUE_NAMES?.INGEST ?? 'ingest';
    return queueModule.createQueue(ingestQueueName);
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    maxTimeCapMs: number,
  ): Promise<T> {
    const startTimeMs = Date.now();
    let attempt = 0;
    let delayMs = 100;
    let lastError: unknown;

    while (Date.now() - startTimeMs < maxTimeCapMs) {
      try {
        return await operation();
      } catch (error: unknown) {
        attempt += 1;
        lastError = error;
        this.logger.warn(
          `Ingest enqueue failed (attempt ${attempt}), retrying in ${delayMs}ms.`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 2_000);
      }
    }

    throw lastError ?? new Error('Retry budget exhausted.');
  }
}
