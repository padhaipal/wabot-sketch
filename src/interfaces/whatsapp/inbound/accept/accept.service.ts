import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

@Injectable()
export class AcceptService {
  private readonly logger = new Logger(AcceptService.name);

  isValidSignature(
    signatureHeader: string | undefined,
    rawBody: Buffer,
  ): boolean {
    if (typeof signatureHeader !== 'string' || !Buffer.isBuffer(rawBody)) {
      this.logger.warn(
        'isValidSignature(): invalid parameter data type.',
      );
      return false;
    }

    const appSecret = process.env.META_APP_SECRET;
    if (!appSecret) {
      this.logger.warn('META_APP_SECRET is not configured.');
      return false;
    }

    return this.validateSignature(signatureHeader, rawBody, appSecret);
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
