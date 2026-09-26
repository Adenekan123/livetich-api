import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class ShareRecordingDto {
  /** Days the link stays valid. Omit for a link that does not expire. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;
}
