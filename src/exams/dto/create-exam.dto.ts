import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';

/** One multiple-choice question authored into an exam. */
export class ExamQuestionDto {
  @IsString()
  @MaxLength(2000)
  body!: string;

  @IsArray()
  @ArrayMinSize(2)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  options!: string[];

  @IsInt()
  @Min(0)
  correctIndex!: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  topic?: string;
}

export class CreateExamDto {
  @IsString()
  @MaxLength(160)
  title!: string;

  /** Time limit in minutes (1–600). */
  @IsInt()
  @Min(1)
  @Max(600)
  durationMinutes!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ExamQuestionDto)
  questions!: ExamQuestionDto[];
}
