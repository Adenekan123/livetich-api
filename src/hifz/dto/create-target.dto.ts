import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/** Instructor sets a memorization goal for one student. Range is re-validated
 *  against the real surah ayah count in the service. */
export class CreateHifzTargetDto {
  @IsString()
  studentId!: string;

  @IsInt()
  @Min(1)
  surahNumber!: number;

  @IsInt()
  @Min(1)
  ayahStart!: number;

  @IsInt()
  @Min(1)
  ayahEnd!: number;

  /** ISO date string; optional soft deadline shown to the student. */
  @IsOptional()
  @IsString()
  dueAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
