import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const LEVELS = ['Beginner', 'Intermediate', 'Advanced'] as const;

export class CreateCourseDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  /** Optionally assign the handling instructor at creation time. */
  @IsOptional()
  @IsString()
  instructorId?: string;

  // ---- Cohort program (all optional so drafts can be created, then filled in) ----

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @IsOptional()
  @IsIn(LEVELS)
  level?: (typeof LEVELS)[number];

  /** ISO date/datetime; the cohort's first day. */
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

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}
