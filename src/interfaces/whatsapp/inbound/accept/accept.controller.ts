import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Request, Response } from 'express';
import { AcceptService } from './accept.service';

type RequestWithRawBody = Request & {
  rawBody?: Buffer;
};

@Controller('webhook')
export class AcceptController {
  private readonly tracer = trace.getTracer('accept-controller');

  constructor(private readonly acceptService: AcceptService) {}

  @Get()
  verifyWebhook(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') verifyToken: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() response: Response,
  ): void {
    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (
      mode === 'subscribe' &&
      typeof verifyToken === 'string' &&
      typeof expectedToken === 'string' &&
      verifyToken === expectedToken &&
      typeof challenge === 'string'
    ) {
      response.status(200).type('text/plain').send(challenge);
      return;
    }

    response.status(403).send();
  }

  @Post()
  async receiveWebhook(
    @Body() body: unknown,
    @Req() request: RequestWithRawBody,
    @Headers('x-hub-signature-256') signatureHeader: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      response.status(401).send();
      return;
    }

    if (!this.acceptService.isValidSignature(signatureHeader, rawBody)) {
      response.status(401).send();
      return;
    }

    const span = this.tracer.startSpan('enqueue-ingest');
    try {
      const ctx = trace.setSpan(context.active(), span);
      const carrier: Record<string, string> = {};
      propagation.inject(ctx, carrier);

      const status = await this.acceptService.receiveWebhook(body, carrier);
      response.status(status).send();
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
  }
}
