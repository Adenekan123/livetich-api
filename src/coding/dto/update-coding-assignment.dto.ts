import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import {
  CreateCodingRequirementDto,
  CreateCodingRubricItemDto,
} from './create-coding-assignment.dto';

/**
 * Patch an existing coding assignment. Scalar fields are updated when present.
 * If `requirements` or `rubric` is supplied it fully replaces the existing set
 * (simplest predictable semantics for the authoring UI).
 */
export class UpdateCodingAssignmentDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

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

  @IsOptional()
  @IsISO8601()
  dueAt?: string;

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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreateCodingRequirementDto)
  requirements?: CreateCodingRequirementDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateCodingRubricItemDto)
  rubric?: CreateCodingRubricItemDto[];
}
