import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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

  // Buzzer authoring is a course-management action, so an org admin (including
  // one teaching a session as instructor) may do it too — the service checks
  // course ownership via assertCanManageCourse.
  @Post()
  @Roles(Role.INSTRUCTOR, Role.ORG_ADMIN)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateQuizDto) {
    return this.quiz.create(user, dto);
  }

  /** Declared before :id so "quizzes?sessionId=…" isn't matched as an id. */
  @Get()
  @Roles(Role.INSTRUCTOR, Role.ORG_ADMIN)
  list(
    @CurrentUser() user: JwtPayload,
    @Query('sessionId') sessionId?: string,
    @Query('courseId') courseId?: string,
  ) {
    if (courseId) return this.quiz.listForCourse(user, courseId);
    if (sessionId) return this.quiz.listForSession(user, sessionId);
    throw new BadRequestException('sessionId or courseId is required');
  }

  @Delete('questions/:questionId')
  @Roles(Role.INSTRUCTOR, Role.ORG_ADMIN)
  deleteQuestion(
    @CurrentUser() user: JwtPayload,
    @Param('questionId') questionId: string,
  ) {
    return this.quiz.deleteQuestion(user, questionId);
  }

  @Get(':id')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.quiz.get(user, id);
  }

  @Get(':id/results')
  @Roles(Role.INSTRUCTOR, Role.ORG_ADMIN)
  results(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.quiz.results(user, id);
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
