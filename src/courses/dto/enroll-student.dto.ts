import { IsString } from 'class-validator';

/** Admin enrolls a specific student into a program. */
export class EnrollStudentDto {
  @IsString()
  studentId!: string;
}
