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
import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { OtelCarrier } from '../../../../otel/otel.dto.js';
import { BAGGAGE_TEST_PHASE } from '../../../../otel/baggage-keys.js';
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
    @Headers('x-test-phase') testPhaseHeader: string | undefined,
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
      let ctx = trace.setSpan(context.active(), span);
      // Inject the optional x-test-phase header (set by the artillery
      // scenario) into baggage so downstream metrics/spans/logs across both
      // services can label by which load-test phase produced the traffic.
      if (typeof testPhaseHeader === 'string' && testPhaseHeader.length > 0) {
        const baggage = (
          propagation.getBaggage(ctx) ?? propagation.createBaggage()
        ).setEntry(BAGGAGE_TEST_PHASE, { value: testPhaseHeader });
        ctx = propagation.setBaggage(ctx, baggage);
      }
      const carrier: OtelCarrier = {};
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
