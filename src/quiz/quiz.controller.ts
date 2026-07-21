import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { AnswerQuestionDto } from './dto/answer-question.dto';
import { CreateQuizDto } from './dto/create-quiz.dto';
import { QuizService } from './quiz.service';

@Controller('quizzes')
export class QuizController {
  constructor(private readonly quiz: QuizService) {}

  @Post()
  @Roles(Role.INSTRUCTOR)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateQuizDto) {
    return this.quiz.create(user.sub, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.quiz.get(user, id);
  }

  @Get(':id/results')
  @Roles(Role.INSTRUCTOR)
  results(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.quiz.results(user.sub, id);
  }

  @Post('questions/:questionId/answer')
  @Roles(Role.STUDENT)
  answer(
    @CurrentUser() user: JwtPayload,
    @Param('questionId') questionId: string,
    @Body() dto: AnswerQuestionDto,
  ) {
    return this.quiz.answer(user, questionId, dto.answerIndex);
  }
}
