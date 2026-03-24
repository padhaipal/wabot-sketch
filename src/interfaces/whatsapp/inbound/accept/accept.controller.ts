import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AcceptService } from './accept.service';

type RequestWithRawBody = Request & {
  rawBody?: Buffer;
};

type SpanHandle = {
  end: () => void;
  recordException: (error: unknown) => void;
};

@Controller('webhook')
export class AcceptController {
  private readonly logger = new Logger(AcceptController.name);

  constructor(private readonly acceptService: AcceptService) {}

  @Post()
  @HttpCode(202)
  async receiveWebhook(
    @Body() body: unknown,
    @Req() request: RequestWithRawBody,
    @Headers('x-hub-signature-256') signatureHeader: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const span = this.startSpan('whatsapp.accept.receiveWebhook');

    try {
      const rawBody = request.rawBody;
      if (!Buffer.isBuffer(rawBody)) {
        this.logger.error(
          'Missing raw request body; bootstrap Nest with rawBody: true for signature verification.',
        );
        response.status(500).send();
        return;
      }

      const status = await this.acceptService.receiveWebhook({
        body,
        rawBody,
        signatureHeader,
        otelCarrier: this.extractOtelCarrier(request.headers),
      });

      response.status(status).send();
    } catch (error: unknown) {
      span.recordException(error);
      const details =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      this.logger.error(`Unhandled accept controller failure: ${details}`);
      response.status(500).send();
    } finally {
      span.end();
    }
  }

  private extractOtelCarrier(
    headers: Request['headers'],
  ): Record<string, string> {
    const carrier: Record<string, string> = {};
    const keys = ['traceparent', 'tracestate', 'baggage'];

    for (const key of keys) {
      const value = headers[key];
      if (typeof value === 'string') {
        carrier[key] = value;
      }
    }

    return carrier;
  }

  private startSpan(name: string): SpanHandle {
    const startedAt = Date.now();
    this.logger.debug(`Span started: ${name}`);

    return {
      end: (): void => {
        this.logger.debug(`Span ended: ${name} (${Date.now() - startedAt}ms)`);
      },
      recordException: (error: unknown): void => {
        const details =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        this.logger.warn(`Span exception in ${name}: ${details}`);
      },
    };
  }
}
