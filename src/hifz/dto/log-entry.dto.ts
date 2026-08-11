import { HifzKind } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Instructor logs a recitation for a student — new memorization or revision. */
export class LogHifzEntryDto {
  @IsString()
  studentId!: string;

  @IsInt()
  @Min(1)
  surahNumber!: number;

  @IsInt()
  @Min(1)
  ayahStart!: number;

  @IsInt()
  @Min(1)
  ayahEnd!: number;

  @IsEnum(HifzKind)
  kind!: HifzKind;

  /** 1 (needs work) .. 5 (mastered). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  tajweed?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /** Live session this recitation was logged in, when logged from the room. */
  @IsOptional()
  @IsString()
  sessionId?: string;
}
