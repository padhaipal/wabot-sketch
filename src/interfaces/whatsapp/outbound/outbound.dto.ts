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

export class SendMessageDeliveredDto {
  @IsBoolean()
  delivered!: true;
}

export class SendMessageNotDeliveredDto {
  @IsBoolean()
  delivered!: false;

  @IsString()
  reason!: 'inflight-expired' | 'whatsapp-error';
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
