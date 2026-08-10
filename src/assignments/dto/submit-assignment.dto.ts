import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitAssignmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  fileUrl?: string;
}
