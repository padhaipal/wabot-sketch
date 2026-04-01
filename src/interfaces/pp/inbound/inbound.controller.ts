import {
  Body,
  Controller,
  Headers,
  Logger,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { validateJobData } from '../../../validation/validate-job.js';
import type { OtelCarrier } from '../../../otel/otel.dto.js';
import * as waOutbound from '../../whatsapp/outbound/outbound.service.js';
import { DownloadMediaDto, SendMessageDto } from './inbound.dto.js';

const logger = new Logger('PpInboundController');

type RequestWithRawBody = Request & {
  rawBody?: Buffer;
};

function extractHttpStatus(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  const match = error.message.match(/(\d{3})/);
  if (!match) return 500;
  const code = parseInt(match[1], 10);
  return code >= 400 && code <= 599 ? code : 500;
}

@Controller()
export class PpInboundController {
  private readonly tracer = trace.getTracer('pp-inbound-controller');

  @Post('sendMessage')
  async sendMessage(
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const validation = validateJobData(SendMessageDto, body);
    if (!validation.success) {
      logger.warn(`SendMessage validation failed: ${validation.errors.join('; ')}`);
      response.status(400).json({ errors: validation.errors });
      return;
    }

    const dto = validation.dto;
    const carrier: OtelCarrier = dto.otel.carrier;
    const parentCtx = propagation.extract(context.active(), carrier);
    const span = this.tracer.startSpan('pp-send-message', undefined, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);

    try {
      const result = await context.with(ctx, () =>
        waOutbound.sendMessage({
          user_id: dto.user_external_id,
          wamid: dto.wamid,
          consecutive: dto.consecutive,
          media: dto.media,
        }),
      );

      response.status(result.status).json(result.body);
    } catch (error: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      logger.error(
        `sendMessage failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      response.status(500).json({ error: 'Internal server error' });
    } finally {
      span.end();
    }
  }

  @Post('downloadMedia')
  async downloadMedia(
    @Body() body: unknown,
    @Res() response: Response,
  ): Promise<void> {
    const validation = validateJobData(DownloadMediaDto, body);
    if (!validation.success) {
      logger.warn(`DownloadMedia validation failed: ${validation.errors.join('; ')}`);
      response.status(400).json({ errors: validation.errors });
      return;
    }

    const dto = validation.dto;
    const carrier: OtelCarrier = dto.otel.carrier;
    const parentCtx = propagation.extract(context.active(), carrier);
    const span = this.tracer.startSpan('pp-download-media', undefined, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);

    try {
      const { stream, content_type } = await context.with(ctx, () =>
        waOutbound.downloadMedia(dto.media_url),
      );

      response.setHeader('Content-Type', content_type);

      const readable =
        stream instanceof Readable
          ? stream
          : Readable.fromWeb(stream as unknown as import('node:stream/web').ReadableStream);

      await new Promise<void>((resolve, reject) => {
        readable.pipe(response);
        readable.on('error', reject);
        response.on('finish', resolve);
        response.on('error', reject);
      });
    } catch (error: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      logger.warn(
        `downloadMedia failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) {
        response.status(extractHttpStatus(error)).json({ error: 'Download failed' });
      }
    } finally {
      span.end();
    }
  }

  @Post('uploadMedia')
  async uploadMedia(
    @Req() request: RequestWithRawBody,
    @Headers('content-type') contentType: string | undefined,
    @Headers('x-media-type') mediaType: string | undefined,
    @Query('otel') otelParam: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    logger.log(
      `[v2] uploadMedia hit, content-type=${contentType}, x-media-type=${mediaType}, rawBody=${Buffer.isBuffer(request.rawBody) ? request.rawBody.length : 'missing'}, body=${Buffer.isBuffer(request.body) ? (request.body as Buffer).length : typeof request.body}`,
    );

    const rawBody = request.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      logger.warn('[v2] uploadMedia rejecting: rawBody is not a Buffer');
      response.status(400).json({ error: 'Raw body is required' });
      return;
    }

    if (!contentType) {
      response.status(400).json({ error: 'Content-Type header is required' });
      return;
    }

    const validMediaTypes = ['audio', 'video', 'image'] as const;
    if (!mediaType || !validMediaTypes.includes(mediaType as typeof validMediaTypes[number])) {
      response.status(400).json({ error: 'X-Media-Type header must be one of: audio, video, image' });
      return;
    }

    let carrier: OtelCarrier = {};
    if (otelParam) {
      try {
        const parsed: unknown = JSON.parse(otelParam);
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          Object.values(parsed as Record<string, unknown>).every(
            (v) => typeof v === 'string',
          )
        ) {
          carrier = parsed as OtelCarrier;
        }
      } catch {
        logger.warn('Failed to parse otel query parameter');
      }
    }

    const parentCtx = propagation.extract(context.active(), carrier);
    const span = this.tracer.startSpan('pp-upload-media', undefined, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);

    try {
      const result = await context.with(ctx, () =>
        waOutbound.uploadMedia({
          data: rawBody,
          content_type: contentType,
          media_type: mediaType,
        }),
      );

      response.status(200).json({ wa_media_url: result.wa_media_url });
    } catch (error: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(
        error instanceof Error ? error : new Error(String(error)),
      );
      logger.error(
        `uploadMedia failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) {
        response.status(extractHttpStatus(error)).json({ error: 'Upload failed' });
      }
    } finally {
      span.end();
    }
  }
}
