import {
  TajweedAnnotationStyle,
  TajweedOutcome,
  TajweedSelection,
} from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TAJWEED_RULE_KEYS, type TajweedRule } from '../../shared';
import { HEX_COLOR } from '../tajweed-input';

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

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(114)
  surahNumber?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  ayahNumber?: number;

  @IsOptional()
  @IsEnum(TajweedSelection)
  selection?: TajweedSelection;

  @IsOptional()
  @IsInt()
  @Min(0)
  wordStart?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  wordEnd?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  letterStart?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  letterEnd?: number | null;

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
