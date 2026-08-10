import { IsOptional, IsString } from 'class-validator';

/** Assign a course to an instructor; omit instructorId to clear the assignment. */
export class AssignInstructorDto {
  @IsOptional()
  @IsString()
  instructorId?: string;
}
