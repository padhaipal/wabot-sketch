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
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OtelCarrierDto } from '../../../otel/otel.dto.js';

// One answer option injected into a WhatsApp Flow at send time. Meta caps
// RadioButtonsGroup option titles at 30 chars and descriptions at 300
// (enforced again in outbound.service.ts at send).
export class OutboundFlowOptionDto {
  @IsString()
  @MaxLength(100)
  id!: string;

  @IsString()
  @MaxLength(30)
  title!: string;

  @IsString()
  @MaxLength(300)
  description!: string;
}

export class OutboundFlowDataPayloadDto {
  // Rendered as TextBody in the flow (Meta cap 4096).
  @IsString()
  @MaxLength(4096)
  question_text!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => OutboundFlowOptionDto)
  options!: OutboundFlowOptionDto[];
}

// Payload for a `flow` media item — becomes an interactive/flow Cloud API
// message referencing the once-published flow asset (no data endpoint; all
// dynamic content travels in `data` via the navigate action). Mirror of
// pp-sketch's OutboundFlowData.
export class OutboundFlowDto {
  @IsString()
  flow_id!: string;

  // Flow message body text (Meta cap 1024 for interactive bodies).
  @IsString()
  @MaxLength(1024)
  body!: string;

  // CTA button label ("advised to be 30 characters or less" per Meta).
  @IsString()
  @MaxLength(30)
  cta!: string;

  @IsString()
  @MaxLength(100)
  screen!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => OutboundFlowDataPayloadDto)
  data!: OutboundFlowDataPayloadDto;
}

export class OutboundMediaItemDto {
  @IsIn(['audio', 'video', 'image', 'sticker', 'text', 'flow'])
  type!: 'audio' | 'video' | 'image' | 'sticker' | 'text' | 'flow';

  @ValidateIf(
    (o: OutboundMediaItemDto) => o.type !== 'text' && o.type !== 'flow',
  )
  @IsString()
  url?: string;

  @ValidateIf((o: OutboundMediaItemDto) => o.type === 'text')
  @IsString()
  body?: string;

  @ValidateIf((o: OutboundMediaItemDto) => o.type === 'flow')
  @IsDefined()
  @ValidateNested()
  @Type(() => OutboundFlowDto)
  flow?: OutboundFlowDto;

  // Optional MIME type hint (informational). Stickers are sent with type='sticker' explicitly.
  @IsOptional()
  @IsString()
  mime_type?: string;
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

export class SendNotificationDto {
  @IsString()
  user_external_id!: string;

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

  // Owner of the media when user-scoped (load-test users short-circuit the
  // real WhatsApp fetch); absent for user-less callers.
  @IsOptional()
  @IsString()
  user_external_id?: string;
}

export class UploadMediaResponseDto {
  wa_media_url!: string;
}
