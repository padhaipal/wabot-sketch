import { Type } from 'class-transformer';
import { IsString, ValidateNested } from 'class-validator';
import { OtelCarrierDto } from '../../../../otel/otel.dto';

export class StatusDto {
  @IsString()
  id!: string;

  @IsString()
  status!: string;

  @IsString()
  timestamp!: string;

  @IsString()
  recipient_id!: string;
}

export class StatusJobDto {
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @ValidateNested()
  @Type(() => StatusDto)
  status!: StatusDto;
}