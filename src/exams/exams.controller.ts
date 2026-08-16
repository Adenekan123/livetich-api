import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { PLUGIN_TEST_PREP } from '../plugins/catalog';
import { RequirePlugin, RequirePluginGuard } from '../plugins/require-plugin.guard';
import { AlocService } from './aloc.service';
import { CreateExamDto } from './dto/create-exam.dto';
import { ImportQuestionsDto } from './dto/import-questions.dto';
import { SubmitExamDto } from './dto/submit-exam.dto';
import { UpdateExamDto } from './dto/update-exam.dto';
import { ExamsService } from './exams.service';

/** Test Prep add-on: timed mock exams. Every route is gated on the pack, so an
 *  org without `test-prep` gets 403 on all of them. */
@Controller()
@UseGuards(RequirePluginGuard)
@RequirePlugin(PLUGIN_TEST_PREP)
export class ExamsController {
  constructor(
    private readonly exams: ExamsService,
    private readonly aloc: AlocService,
  ) {}

  // ---------- Manager: author + review ----------

  /** Pull draft past-questions from ALOC for the instructor to review, edit,
   *  then save via POST /courses/:id/exams. One request costs one ALOC credit. */
  @Get('exams/import/aloc')
  @Roles(Role.INSTRUCTOR, Role.ORG_ADMIN)
  importFromAloc(@Query() query: ImportQuestionsDto) {
    return this.aloc.fetchDraft({
      subject: query.subject,
      examType: query.examType,
      year: query.year,
      limit: query.limit ?? 20,
    });
  }

  @Post('courses/:courseId/exams')
  create(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: CreateExamDto,
  ) {
    return this.exams.createExam(user, courseId, dto);
  }

  @Get('courses/:courseId/exams')
  list(@CurrentUser() user: JwtPayload, @Param('courseId') courseId: string) {
    return this.exams.listExams(user, courseId);
  }

  @Get('exams/:examId/results')
  results(@CurrentUser() user: JwtPayload, @Param('examId') examId: string) {
    return this.exams.results(user, examId);
  }

  // ---------- Student: sit exams ----------

  @Get('courses/:courseId/exams/available')
  available(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.exams.listAvailable(user, courseId);
  }

  @Get('exams/:examId/review')
  review(@CurrentUser() user: JwtPayload, @Param('examId') examId: string) {
    return this.exams.getReview(user, examId);
  }

  @Post('exams/:examId/attempts')
  @HttpCode(200)
  start(@CurrentUser() user: JwtPayload, @Param('examId') examId: string) {
    return this.exams.startAttempt(user, examId);
  }

  @Post('attempts/:attemptId/submit')
  @HttpCode(200)
  submit(
    @CurrentUser() user: JwtPayload,
    @Param('attemptId') attemptId: string,
    @Body() dto: SubmitExamDto,
  ) {
    return this.exams.submit(user, attemptId, dto);
  }

  // ---------- Manager: edit + delete ----------
  // Declared after the literal `.../exams/available` route so it wins the match.

  @Get('courses/:courseId/exams/:examId')
  getExam(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('examId') examId: string,
  ) {
    return this.exams.getExam(user, courseId, examId);
  }

  @Patch('courses/:courseId/exams/:examId')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('examId') examId: string,
    @Body() dto: UpdateExamDto,
  ) {
    return this.exams.updateExam(user, courseId, examId, dto);
  }

  @Delete('courses/:courseId/exams/:examId')
  remove(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('examId') examId: string,
  ) {
    return this.exams.deleteExam(user, courseId, examId);
  }
}
