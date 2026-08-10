import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateAssignmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  instructions?: string;

  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxPoints?: number;

  @IsOptional()
  @IsString()
  sectionId?: string;

  /** Target a single group; omit for the whole class. */
  @IsOptional()
  @IsString()
  groupId?: string;
}
