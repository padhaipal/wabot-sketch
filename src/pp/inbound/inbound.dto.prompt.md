// wabot-sketch/src/pp/inbound/inbound.dto.prompt.md

import { IsString, IsBoolean, IsOptional, IsArray, IsIn, ValidateNested, IsDefined, ValidateIf, ArrayMinSize } from 'class-validator';
import { Type } from 'class-transformer';
import { OtelCarrierDto } from '../../otel/otel.dto';

// --- SendMessage DTO ---

export class OutboundMediaItemDto {
  @IsIn(['audio', 'video', 'image', 'text'])
  type!: 'audio' | 'video' | 'image' | 'text';

  @ValidateIf(o => o.type !== 'text')
  @IsString()
  url?: string;

  @ValidateIf(o => o.type === 'text')
  @IsString()
  body?: string;
}

export class SendMessageDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @IsString()
  user_external_id!: string;

  @IsString()
  wamid!: string;

  @IsOptional()
  @IsBoolean()
  consecutive?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OutboundMediaItemDto)
  media!: OutboundMediaItemDto[];
}

// --- DownloadMedia DTO ---

export class DownloadMediaDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @IsString()
  media_url!: string;
}

// --- UploadMedia ---
// Unlike SendMessage/DownloadMedia, UploadMedia uses a raw binary body rather than JSON.
// Metadata is carried in headers and query params instead of the request body.
// Validation is done manually in the controller (no class-validator DTO for the body).

export class UploadMediaResponseDto {
  wa_media_url!: string;                   // WhatsApp media ID — use in OutboundMediaItemDto.url to reference the preloaded media
}
