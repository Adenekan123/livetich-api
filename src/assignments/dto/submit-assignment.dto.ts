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

  /** Editor language id for a code submission (e.g. "python"); enables
   *  syntax-highlighted review. Optional — plain submissions omit it. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  language?: string;
}
