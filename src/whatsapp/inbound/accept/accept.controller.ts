import {
  Body,
  Controller,
  Get,
  Headers,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AcceptService } from './accept.service';

type RequestWithRawBody = Request & {
  rawBody?: Buffer;
};

type WebhookValue = {
  messages?: unknown[];
  statuses?: unknown[];
  errors?: unknown[];
};

@Controller('webhook')
export class AcceptController {
  private readonly logger = new Logger(AcceptController.name);

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
  receiveWebhook(
    @Body() body: unknown,
    @Req() request: RequestWithRawBody,
    @Headers('x-hub-signature-256') signatureHeader: string | undefined,
    @Res() response: Response,
  ): void {
    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      response.status(401).send();
      return;
    }

    if (!this.acceptService.isValidSignature(signatureHeader, rawBody)) {
      response.status(401).send();
      return;
    }

    this.logger.log(`Webhook body: ${this.safeJson(body)}`);

    const { messages, statuses, errors } = this.extractEvents(body);
    for (const message of messages) {
      this.logger.log(`Message: ${this.safeJson(message)}`);
    }
    for (const status of statuses) {
      this.logger.log(`Status: ${this.safeJson(status)}`);
    }
    for (const error of errors) {
      this.logger.warn(`Error: ${this.safeJson(error)}`);
    }

    response.status(200).send();
  }

  private extractEvents(body: unknown): {
    messages: unknown[];
    statuses: unknown[];
    errors: unknown[];
  } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { messages: [], statuses: [], errors: [] };
    }

    const entries = (body as { entry?: unknown }).entry;
    if (!Array.isArray(entries)) {
      return { messages: [], statuses: [], errors: [] };
    }

    const values: WebhookValue[] = [];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const changes = (entry as { changes?: unknown }).changes;
      if (!Array.isArray(changes)) {
        continue;
      }
      for (const change of changes) {
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
          continue;
        }
        const value = (change as { value?: unknown }).value;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          values.push(value as WebhookValue);
        }
      }
    }

    return {
      messages: values.flatMap((v) =>
        Array.isArray(v.messages) ? v.messages : [],
      ),
      statuses: values.flatMap((v) =>
        Array.isArray(v.statuses) ? v.statuses : [],
      ),
      errors: values.flatMap((v) =>
        Array.isArray(v.errors) ? v.errors : [],
      ),
    };
  }

  private safeJson(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
}
