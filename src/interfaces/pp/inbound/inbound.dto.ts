import {
  IsString,
  IsBoolean,
  IsOptional,
  IsArray,
  IsIn,
  ValidateNested,
  IsDefined,
  ValidateIf,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OtelCarrierDto } from '../../../otel/otel.dto.js';

export class OutboundMediaItemDto {
  @IsIn(['audio', 'video', 'image', 'text'])
  type!: 'audio' | 'video' | 'image' | 'text';

  @ValidateIf((o: OutboundMediaItemDto) => o.type !== 'text')
  @IsString()
  url?: string;

  @ValidateIf((o: OutboundMediaItemDto) => o.type === 'text')
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

export class DownloadMediaDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @IsString()
  media_url!: string;
}

export class UploadMediaResponseDto {
  wa_media_url!: string;
}
