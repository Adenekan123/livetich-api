import {
  TajweedAnnotationMode,
  TajweedAnnotationStyle,
  TajweedOutcome,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MAX_PARTS } from '../../quran/quran-words';
import { TAJWEED_RULE_KEYS, type TajweedRule } from '../../shared';
import { ANNOTATION_ID, HEX_COLOR } from '../tajweed-input';
import { TajweedPartDto } from './part.dto';

/**
 * A saved Tajweed annotation: prepared lesson material, or a correction for one
 * student. The shape is checked here; whether the parts exist in the Qur'an, and
 * whether the student, lesson and session belong to the course, is checked in
 * the service against the real data.
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

  /**
   * What the mark holds. Parts may sit in different ayahs — a rule can hold the
   * last letter of one and the first of the next — and nothing between two
   * parts is implied.
   */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_PARTS)
  @ValidateNested({ each: true })
  @Type(() => TajweedPartDto)
  parts!: TajweedPartDto[];

  /** Keep it for next time: any class in this course that opens these ayahs
   *  shows it. Lesson material only. */
  @IsOptional()
  @IsBoolean()
  kept?: boolean;

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
