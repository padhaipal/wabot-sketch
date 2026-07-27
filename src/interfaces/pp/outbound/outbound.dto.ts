import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { OtelCarrierDto } from '../../../otel/otel.dto.js';

@ValidatorConstraint({ name: 'typeMatchesPayload', async: false })
class TypeMatchesPayloadConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const dto = args.object as PpMessageDto;

    const typeToField: Record<string, unknown> = {
      audio: dto.audio,
      text: dto.text,
      video: dto.video,
      system: dto.system,
      interactive: dto.interactive,
    };

    const presentFields = Object.entries(typeToField).filter(
      ([, value]) => value !== undefined,
    );

    return presentFields.length === 1 && presentFields[0][0] === dto.type;
  }

  defaultMessage(args: ValidationArguments): string {
    const dto = args.object as PpMessageDto;
    return `type "${dto.type}" must match the populated field. Exactly one of audio, text, video, system or interactive must be present and it must match type.`;
  }
}

export class PpAudioDto {
  @IsString()
  url!: string;
}

export class PpVideoDto {
  @IsString()
  url!: string;
}

export class PpTextDto {
  @IsString()
  body!: string;
}

export class PpSystemDto {
  @IsString()
  body!: string;
}

// WhatsApp Flow completion (user tapped submit on a flow message). name is
// always "flow", body always "Sent"; response_json is the stringified JSON
// of the flow's Complete action payload — untrusted user input, passed
// through to pp-sketch verbatim.
export class PpNfmReplyDto {
  @IsString()
  name!: string;

  @IsString()
  body!: string;

  @IsString()
  response_json!: string;
}

export class PpInteractiveDto {
  @IsString()
  type!: string; // 'nfm_reply' is the only variant forwarded

  @IsOptional()
  @ValidateNested()
  @Type(() => PpNfmReplyDto)
  nfm_reply?: PpNfmReplyDto;
}

export class PpMessageDto {
  @IsString()
  from!: string;

  @IsString()
  id!: string;

  @IsString()
  timestamp!: string;

  @IsString()
  type!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PpAudioDto)
  audio?: PpAudioDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PpTextDto)
  text?: PpTextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PpVideoDto)
  video?: PpVideoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PpSystemDto)
  system?: PpSystemDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PpInteractiveDto)
  interactive?: PpInteractiveDto;

  @Validate(TypeMatchesPayloadConstraint)
  private readonly typeMatchesPayload!: true;
}

export class PpMessageJobDto {
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @ValidateNested()
  @Type(() => PpMessageDto)
  message!: PpMessageDto;

  @IsOptional()
  @IsBoolean()
  consecutive?: boolean;
}
