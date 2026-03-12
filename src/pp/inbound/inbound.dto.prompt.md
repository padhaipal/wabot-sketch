// wabot-sketch/src/pp/inbound/inbound.dto.prompt.md

import { IsString, ValidateNested, IsDefined } from 'class-validator';
import { Type } from 'class-transformer';
import { OtelCarrierDto } from '../../otel/otel.dto';

export class DownloadMediaDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @IsString()
  media_url!: string;
}
