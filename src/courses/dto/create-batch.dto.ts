import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Create a batch (a scheduled instance) of an existing program. Identity
 * (title, description, category, level) is inherited from the program; a batch
 * carries only its own schedule + an optional short label ("Batch A", "Morning
 * cohort") and its own handling instructor. Every schedule field is optional so
 * a batch can inherit the program's cadence and just shift the time.
 */
export class CreateBatchDto {
  /** Short label distinguishing this batch, e.g. "Batch A" or "Evening". */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  /** Handling instructor; defaults to the program's instructor when omitted. */
  @IsOptional()
  @IsString()
  instructorId?: string;

  /** ISO date/datetime; the batch's first day (may differ from the program). */
  @IsOptional()
  @IsISO8601()
  startDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(52)
  durationWeeks?: number;

  /** Weekly meeting days, 0=Sun … 6=Sat. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  meetingDays?: number[];

  /** Local start time, 24h "HH:mm". */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'meetingTime must be "HH:mm" (24h)',
  })
  meetingTime?: string;

  /** IANA zone (e.g. "Africa/Lagos") — batches often differ by timezone. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
