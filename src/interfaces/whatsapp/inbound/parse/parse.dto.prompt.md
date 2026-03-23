// src/interfaces/whatsapp/inbound/parse/parse.dto.ts

import { Type } from 'class-transformer';
import {
  IsArray,
  IsObject,
  IsString,
  ValidateNested,
} from 'class-validator';
import { OtelCarrierDto } from '../../../../otel/otel.dto';

export class ParseWebhookChangeDto {
  @IsString()
  field!: string;

  @IsObject()
  value!: Record<string, unknown>;
}

export class ParseWebhookEntryDto {
  @IsString()
  id!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParseWebhookChangeDto)
  changes!: ParseWebhookChangeDto[];
}

export class ParseWebhookBodyDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ParseWebhookEntryDto)
  entry!: ParseWebhookEntryDto[];
}

export class ParseWebhookJobDto {
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @ValidateNested()
  @Type(() => ParseWebhookBodyDto)
  body!: ParseWebhookBodyDto;
}
