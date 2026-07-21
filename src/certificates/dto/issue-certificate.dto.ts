import { IsNotEmpty, IsString } from 'class-validator';

export class IssueCertificateDto {
  @IsString()
  @IsNotEmpty()
  courseId!: string;

  @IsString()
  @IsNotEmpty()
  studentId!: string;
}
