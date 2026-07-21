import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateCourseDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;
}
