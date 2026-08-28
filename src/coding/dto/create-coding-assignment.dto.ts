import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CodingAssignmentKind } from '@prisma/client';

export class CreateCodingRequirementDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  text!: string;

  /** A missed mandatory requirement caps the result at Fail (spec §7). */
  @IsOptional()
  @IsBoolean()
  mandatory?: boolean;
}

export class CreateCodingRubricItemDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  criterion!: string;

  /** Weight as a percentage (0–100). Weights need not sum to exactly 100 —
   *  the score normalises against the total. */
  @IsInt()
  @Min(0)
  @Max(100)
  weight!: number;

  @IsOptional()
  @IsBoolean()
  mandatory?: boolean;

  /** Extra evaluation guidance handed to the AI reviewer for this criterion. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  aiInstructions?: string;
}

export class CreateCodingAssignmentDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  framework?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  difficulty?: string;

  /** Live task (runs in a session now) or assignment (homework for the next
   *  class). A LIVE kind with a sessionId launches immediately on create. */
  @IsOptional()
  @IsEnum(CodingAssignmentKind)
  kind?: CodingAssignmentKind;

  /** Tie the task to a live session so it can be launched as "Practice now". */
  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  /** Live practice window in seconds (null = untimed homework). */
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(6 * 60 * 60)
  timeLimitSec?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxAttempts?: number;

  @IsOptional()
  @IsBoolean()
  allowResubmit?: boolean;

  @IsOptional()
  @IsBoolean()
  keepHighest?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  passingScore?: number;

  @IsOptional()
  @IsBoolean()
  aiAutoReview?: boolean;

  @IsOptional()
  @IsBoolean()
  showAiToStudents?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateCodingRequirementDto)
  requirements!: CreateCodingRequirementDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateCodingRubricItemDto)
  rubric?: CreateCodingRubricItemDto[];
}
