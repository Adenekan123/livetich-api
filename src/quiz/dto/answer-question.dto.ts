import { IsInt, Min } from 'class-validator';

export class AnswerQuestionDto {
  @IsInt()
  @Min(0)
  answerIndex!: number;
}
