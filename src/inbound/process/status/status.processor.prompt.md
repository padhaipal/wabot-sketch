import { Type } from 'class-transformer';
import {
  IsArray,
  IsString,
  ValidateNested,
} from 'class-validator';

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

export class StatusArrayDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StatusDto)
  statuses!: StatusDto[];
}
