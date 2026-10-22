import { IsOptional, IsString, Matches } from 'class-validator';

/** Refs the exact update plan the student applied. */
export class CourseUpdateAckDto {
  @IsOptional()
  @IsString()
  @Matches(/^[0-9a-f]{40}$/i)
  expectedBaseSha?: string;

  @IsString()
  @Matches(/^[0-9a-f]{40}$/i)
  courseSha!: string;

  @IsString()
  @Matches(/^[0-9a-f]{40}$/i)
  studentCommitSha!: string;
}
