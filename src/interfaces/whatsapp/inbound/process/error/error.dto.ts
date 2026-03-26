import { Type } from 'class-transformer';
import { IsInt, IsString, ValidateNested } from 'class-validator';
import { OtelCarrierDto } from '../../../../../otel/otel.dto.js';

export class ErrorDataDto {
  @IsString()
  details!: string;
}

export class ErrorDto {
  @IsInt()
  code!: number;

  @IsString()
  title!: string;

  @IsString()
  message!: string;

  @ValidateNested()
  @Type(() => ErrorDataDto)
  error_data!: ErrorDataDto;

  @IsString()
  href!: string;
}

export class ErrorJobDto {
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @ValidateNested()
  @Type(() => ErrorDto)
  error!: ErrorDto;
}
