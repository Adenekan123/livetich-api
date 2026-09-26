import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class GradeSubmissionDto {
  /**
   * The real ceiling is the assignment's own `maxPoints`, enforced in the
   * service because it varies per assignment. This is only the backstop for one
   * with no scale declared, and matches the 1000 that CreateAssignmentDto
   * allows `maxPoints` itself to be.
   */
  @IsInt()
  @Min(0)
  @Max(1000)
  grade!: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  feedback?: string;
}
