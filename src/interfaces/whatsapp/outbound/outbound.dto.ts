import {
  IsString,
  IsIn,
  IsOptional,
  IsBoolean,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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

// interactive/flow action parameters (Cloud API "Sending a Flow"). The flow
// asset is published once; flow_action_payload carries the entry screen and
// its dynamic data.
export class WaFlowActionPayloadDto {
  @IsString()
  screen!: string;

  data?: Record<string, unknown>;
}

export class WaFlowParametersDto {
  @IsIn(['3'])
  flow_message_version!: '3';

  @IsString()
  flow_id!: string;

  @IsString()
  flow_cta!: string;

  @IsIn(['navigate'])
  flow_action!: 'navigate';

  @ValidateNested()
  @Type(() => WaFlowActionPayloadDto)
  flow_action_payload!: WaFlowActionPayloadDto;
}

export class WaInteractiveActionDto {
  @IsIn(['flow'])
  name!: 'flow';

  @ValidateNested()
  @Type(() => WaFlowParametersDto)
  parameters!: WaFlowParametersDto;
}

export class WaInteractiveDto {
  @IsIn(['flow'])
  type!: 'flow';

  @ValidateNested()
  @Type(() => WaTextBodyDto)
  body!: WaTextBodyDto;

  @ValidateNested()
  @Type(() => WaInteractiveActionDto)
  action!: WaInteractiveActionDto;
}

export class WaSendMessageRequestDto {
  @IsString()
  messaging_product!: 'whatsapp';

  @IsString()
  recipient_type!: 'individual';

  @IsString()
  to!: string;

  // 'interactive' is the wire type for flow items (the one place item type ≠
  // WA type). 'sticker' was previously missing from this descriptive DTO —
  // the runtime builder always supported it.
  @IsIn(['text', 'audio', 'video', 'image', 'sticker', 'interactive'])
  type!: 'text' | 'audio' | 'video' | 'image' | 'sticker' | 'interactive';

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

  @IsOptional()
  @ValidateNested()
  @Type(() => WaMediaObjectDto)
  sticker?: WaMediaObjectDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => WaInteractiveDto)
  interactive?: WaInteractiveDto;
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

export class SendMessageDeliveredDto {
  @IsBoolean()
  delivered!: true;
}

export class SendMessageNotDeliveredDto {
  @IsBoolean()
  delivered!: false;

  @IsString()
  reason!: 'inflight-expired' | 'whatsapp-error' | 'oversize-text-blocked';
}

export type SendMessageResultDto =
  | SendMessageDeliveredDto
  | SendMessageNotDeliveredDto;

export class WaUploadMediaResponseDto {
  @IsString()
  id!: string;
}

export class UploadMediaResultDto {
  @IsString()
  wa_media_url!: string;
}
