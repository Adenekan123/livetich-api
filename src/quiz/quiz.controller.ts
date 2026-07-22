import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
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

  /** Declared before :id so "quizzes?sessionId=…" isn't matched as an id. */
  @Get()
  @Roles(Role.INSTRUCTOR)
  list(@CurrentUser() user: JwtPayload, @Query('sessionId') sessionId: string) {
    if (!sessionId) throw new BadRequestException('sessionId is required');
    return this.quiz.listForSession(user.sub, sessionId);
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
