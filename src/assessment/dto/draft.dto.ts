import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class DraftDto {
  @IsString()
  documentId!: string;

  @IsString()
  sectionId!: string;

  /** How many questions to draft (1–15). Defaults to 5. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(15)
  count?: number;
}
