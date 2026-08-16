import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Query for pulling draft questions from ALOC (JAMB/WAEC/NECO/Post-UTME). */
export class ImportQuestionsDto {
  @IsString()
  @MaxLength(40)
  subject!: string;

  /** ALOC exam type: jamb | wassce | neco | post-utme. */
  @IsString()
  @MaxLength(20)
  examType!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1970)
  @Max(2100)
  year?: number;

  /** How many questions to keep from the batch (one ALOC request = 1 credit). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(40)
  limit?: number;
}
