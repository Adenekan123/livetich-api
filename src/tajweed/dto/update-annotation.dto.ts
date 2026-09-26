import { TajweedAnnotationStyle, TajweedOutcome } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_PARTS } from '../../quran/quran-words';
import { TAJWEED_RULE_KEYS, type TajweedRule } from '../../shared';
import { HEX_COLOR } from '../tajweed-input';
import { TajweedPartDto } from './part.dto';

/**
 * An edit. Absent fields are left as they are; null clears an optional field.
 * Mode, student and lesson are fixed once saved — a correction does not become
 * lesson material by being edited.
 */
export class UpdateTajweedAnnotationDto {
  /** The version this edit was made against. A stale one is refused (409). */
  @IsInt()
  @Min(1)
  version!: number;

  /** The live session to tell about the change, when edited during class. */
  @IsOptional()
  @IsString()
  sessionId?: string;

  /** Where the mark points now. Sent whole: the parts given replace the ones
   *  stored, so dropping a letter is the same shape of request as adding one. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_PARTS)
  @ValidateNested({ each: true })
  @Type(() => TajweedPartDto)
  parts?: TajweedPartDto[];

  @IsOptional()
  @IsBoolean()
  kept?: boolean;

  @IsOptional()
  @IsIn(TAJWEED_RULE_KEYS)
  rule?: TajweedRule | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  customLabel?: string | null;

  @IsOptional()
  @IsEnum(TajweedAnnotationStyle)
  style?: TajweedAnnotationStyle;

  @IsOptional()
  @Matches(HEX_COLOR)
  color?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;

  @IsOptional()
  @IsEnum(TajweedOutcome)
  outcome?: TajweedOutcome | null;
}
