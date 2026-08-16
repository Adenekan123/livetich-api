import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/** A student's chosen option for one question. */
export class ExamAnswerDto {
  @IsString()
  questionId!: string;

  @IsInt()
  @Min(0)
  chosenIndex!: number;
}

export class SubmitExamDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExamAnswerDto)
  answers!: ExamAnswerDto[];
}
