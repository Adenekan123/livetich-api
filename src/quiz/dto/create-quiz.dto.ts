import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { QuizType } from '@prisma/client';

export class CreateQuizQuestionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  body!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(6)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  options!: string[];

  /** Index into options; range-checked against options.length in the service. */
  @IsInt()
  @Min(0)
  correctIndex!: number;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(600)
  timeLimitSec?: number;

  /** Points the first correct answerer earns (buzzer); instructor-set. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  points?: number;
}

export class CreateQuizDto {
  /** Attach to a section (end-of-section quiz) and/or a live session. */
  @IsOptional()
  @IsString()
  sectionId?: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  /** Attach directly to a course (reusable buzzer bank, no session needed). */
  @IsOptional()
  @IsString()
  courseId?: string;

  @IsEnum(QuizType)
  type!: QuizType;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateQuizQuestionDto)
  questions!: CreateQuizQuestionDto[];
}
