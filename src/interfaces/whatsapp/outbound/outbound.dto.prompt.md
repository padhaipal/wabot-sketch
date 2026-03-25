// wabot-sketch/src/interfaces/whatsapp/outbound/outbound.dto.prompt.md
// DTOs for the WhatsApp Cloud API payloads constructed and received by outbound.service.ts.
// These are internal to the wabot service — they model the shapes sent to / received from the WhatsApp Cloud API.

import { IsString, IsIn, IsOptional, IsBoolean, IsArray, ValidateNested, ValidateIf, IsDefined } from 'class-validator';
import { Type } from 'class-transformer';

// --- sendReadAndTypingIndicator --- //

export class TypingIndicatorDto {
  @IsIn(['text'])
  type!: 'text';
}

export class WaReadAndTypingRequestDto {
  @IsString()
  messaging_product!: 'whatsapp';

  @IsString()
  status!: 'read';

  @IsString()
  message_id!: string;

  @ValidateNested()
  @Type(() => TypingIndicatorDto)
  typing_indicator!: TypingIndicatorDto;
}

export class WaReadAndTypingResponseDto {
  @IsBoolean()
  success!: boolean;
}

// --- sendMessage --- //

export class WaTextBodyDto {
  @IsString()
  body!: string;
}

export class WaMediaObjectDto {
  @IsOptional()
  @IsString()
  link?: string;

  @IsOptional()
  @IsString()
  id?: string;
}

export class WaSendMessageRequestDto {
  @IsString()
  messaging_product!: 'whatsapp';

  @IsString()
  recipient_type!: 'individual';

  @IsString()
  to!: string;

  @IsIn(['text', 'audio', 'video', 'image'])
  type!: 'text' | 'audio' | 'video' | 'image';

  @IsOptional()
  @ValidateNested()
  @Type(() => WaTextBodyDto)
  text?: WaTextBodyDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WaMediaObjectDto)
  audio?: WaMediaObjectDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WaMediaObjectDto)
  video?: WaMediaObjectDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WaMediaObjectDto)
  image?: WaMediaObjectDto;
}

export class WaSendMessageContactDto {
  @IsString()
  input!: string;

  @IsString()
  wa_id!: string;
}

export class WaSendMessageMessageDto {
  @IsString()
  id!: string;

  @IsOptional()
  @IsIn(['accepted', 'held_for_quality_assessment', 'paused'])
  message_status?: 'accepted' | 'held_for_quality_assessment' | 'paused';
}

export class WaSendMessageResponseDto {
  @IsString()
  messaging_product!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WaSendMessageContactDto)
  contacts!: WaSendMessageContactDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WaSendMessageMessageDto)
  messages!: WaSendMessageMessageDto[];
}

// --- sendMessage return shapes (to caller) --- //

export class SendMessageDeliveredDto {
  @IsBoolean()
  delivered!: true;
}

export class SendMessageNotDeliveredDto {
  @IsBoolean()
  delivered!: false;

  @IsString()
  reason!: 'inflight-expired';
}

// --- uploadMedia --- //

export class WaUploadMediaResponseDto {
  @IsString()
  id!: string;
}

export class UploadMediaResultDto {
  @IsString()
  wa_media_url!: string;
}

// --- downloadMedia --- //
// downloadMedia does not use a JSON request body (it's a GET with Authorization header).
// Return shape is { stream: NodeJS.ReadableStream, content_type: string } — not modeled as a class-validator DTO since it contains a stream.
