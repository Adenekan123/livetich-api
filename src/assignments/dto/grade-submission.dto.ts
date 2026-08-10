import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class GradeSubmissionDto {
  @IsInt()
  @Min(0)
  grade!: number;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  feedback?: string;
}
