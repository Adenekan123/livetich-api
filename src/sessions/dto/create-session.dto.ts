import { IsDateString, IsOptional, IsString } from 'class-validator';

export class CreateSessionDto {
  @IsString()
  courseId!: string;

  @IsOptional()
  @IsString()
  sectionId?: string;

  @IsDateString()
  scheduledAt!: string;
}
