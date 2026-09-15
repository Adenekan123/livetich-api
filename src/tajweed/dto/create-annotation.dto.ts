import {
  TajweedAnnotationMode,
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
import { ANNOTATION_ID, HEX_COLOR } from '../tajweed-input';

/**
 * A saved Tajweed annotation: prepared lesson material, or a correction for one
 * student. The shape is checked here; whether the reference exists in the
 * Qur'an, and whether the student, lesson and session belong to the course, is
 * checked in the service against the real data.
 */
export class CreateTajweedAnnotationDto {
  /** Chosen by the client, so a resend after a dropped connection is safe. */
  @IsString()
  @Matches(ANNOTATION_ID)
  id!: string;

  @IsEnum(TajweedAnnotationMode)
  mode!: TajweedAnnotationMode;

  @IsOptional()
  @IsString()
  sectionId?: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  /** STUDENT_CORRECTION only. */
  @IsOptional()
  @IsString()
  studentId?: string;

  @IsOptional()
  @IsString()
  hifzEntryId?: string;

  @IsInt()
  @Min(1)
  @Max(114)
  surahNumber!: number;

  @IsInt()
  @Min(1)
  ayahNumber!: number;

  @IsEnum(TajweedSelection)
  selection!: TajweedSelection;

  @IsOptional()
  @IsInt()
  @Min(0)
  wordStart?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  wordEnd?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  letterStart?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  letterEnd?: number;

  @IsOptional()
  @IsIn(TAJWEED_RULE_KEYS)
  rule?: TajweedRule;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  customLabel?: string;

  @IsOptional()
  @IsEnum(TajweedAnnotationStyle)
  style?: TajweedAnnotationStyle;

  @IsOptional()
  @Matches(HEX_COLOR)
  color?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /** STUDENT_CORRECTION only: what the teacher heard. */
  @IsOptional()
  @IsEnum(TajweedOutcome)
  outcome?: TajweedOutcome;
}
