import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class AttemptAnswerDto {
  @IsString()
  questionId!: string;

  @IsInt()
  @Min(0)
  answerIndex!: number;
}

export class SubmitAttemptDto {
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AttemptAnswerDto)
  answers!: AttemptAnswerDto[];
}
