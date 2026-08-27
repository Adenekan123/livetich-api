import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateFeedbackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(8000)
  body!: string;

  /** Inline code-comment anchor (optional): file path + 1-based line number. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  filePath?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  line?: number;

  /** Hide from the student (private instructor note) by sending false. */
  @IsOptional()
  @IsBoolean()
  visibleToStudent?: boolean;
}
