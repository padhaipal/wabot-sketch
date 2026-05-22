import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { OtelCarrierDto } from '../../../../../otel/otel.dto.js';

export class StatusErrorDto {
  @IsOptional()
  code?: number;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  message?: string;
}

export class StatusDto {
  @IsString()
  id!: string;

  @IsString()
  status!: string;

  @IsString()
  timestamp!: string;

  @IsString()
  recipient_id!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StatusErrorDto)
  errors?: StatusErrorDto[];
}

export class StatusJobDto {
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @ValidateNested()
  @Type(() => StatusDto)
  status!: StatusDto;
}
