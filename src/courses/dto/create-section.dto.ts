import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class CreateSectionDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  /** Optional summary of what the section covers. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  /** Position in the course; appended to the end when omitted. */
  @IsOptional()
  @IsInt()
  @Min(1)
  order?: number;
}
