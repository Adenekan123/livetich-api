import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { AssessmentService } from './assessment.service';
import { DocumentsService } from './documents.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { BatchQuestionsDto } from './dto/batch-questions.dto';
import { BatchTasksDto } from './dto/batch-tasks.dto';
import { DraftDto } from './dto/draft.dto';

@Controller()
export class AssessmentController {
  constructor(
    private readonly assessment: AssessmentService,
    private readonly documents: DocumentsService,
  ) {}

  // ---------- Authoring: question bank (manager) ----------

  @Get('courses/:courseId/assessment/questions')
  listQuestions(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.assessment.listQuestions(user, courseId);
  }

  @Post('courses/:courseId/assessment/questions')
  createQuestion(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: CreateQuestionDto,
  ) {
    return this.assessment.createQuestion(user, courseId, dto);
  }

  /** Save a reviewed batch (used to accept AI-drafted questions). */
  @Post('courses/:courseId/assessment/questions/batch')
  createQuestionsBatch(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: BatchQuestionsDto,
  ) {
    return this.assessment.createQuestionsBatch(
      user,
      courseId,
      dto.sectionId,
      dto.questions,
    );
  }

  @Patch('courses/:courseId/assessment/questions/:questionId')
  updateQuestion(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('questionId') questionId: string,
    @Body() dto: UpdateQuestionDto,
  ) {
    return this.assessment.updateQuestion(user, courseId, questionId, dto);
  }

  @Delete('courses/:courseId/assessment/questions/:questionId')
  deleteQuestion(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('questionId') questionId: string,
  ) {
    return this.assessment.deleteQuestion(user, courseId, questionId);
  }

  // ---------- Authoring: remediation task bank (manager) ----------

  @Get('courses/:courseId/assessment/tasks')
  listTasks(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.assessment.listTasks(user, courseId);
  }

  @Post('courses/:courseId/assessment/tasks')
  createTask(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.assessment.createTask(user, courseId, dto);
  }

  /** Save a reviewed batch (used to accept AI-drafted remediation tasks). */
  @Post('courses/:courseId/assessment/tasks/batch')
  createTasksBatch(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: BatchTasksDto,
  ) {
    return this.assessment.createTasksBatch(
      user,
      courseId,
      dto.sectionId,
      dto.tasks,
    );
  }

  // ---------- AI drafting: documents + draft (manager) ----------

  @Post('courses/:courseId/assessment/documents')
  // Cap at the multer layer so an oversized upload is aborted mid-stream
  // rather than buffered whole into memory.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }))
  uploadDocument(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.documents.upload(user, courseId, file);
  }

  @Get('courses/:courseId/assessment/documents')
  listDocuments(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.documents.list(user, courseId);
  }

  @Delete('courses/:courseId/assessment/documents/:documentId')
  deleteDocument(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.documents.remove(user, courseId, documentId);
  }

  /** Draft questions + tasks for a section from an uploaded document (review before saving). */
  @Post('courses/:courseId/assessment/draft')
  @HttpCode(200)
  draft(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: DraftDto,
  ) {
    return this.documents.draft(user, courseId, dto);
  }

  @Patch('courses/:courseId/assessment/tasks/:taskId')
  updateTask(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('taskId') taskId: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.assessment.updateTask(user, courseId, taskId, dto);
  }

  @Delete('courses/:courseId/assessment/tasks/:taskId')
  deleteTask(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Param('taskId') taskId: string,
  ) {
    return this.assessment.deleteTask(user, courseId, taskId);
  }

  // ---------- Student: take assessments + remediation ----------

  @Get('courses/:courseId/assessment/mine')
  listMine(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.assessment.listMine(user, courseId);
  }

  @Get('courses/:courseId/remediation/mine')
  listMyRemediation(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.assessment.listMyRemediation(user, courseId);
  }

  @Get('assessments/:assessmentId')
  getForStudent(
    @CurrentUser() user: JwtPayload,
    @Param('assessmentId') assessmentId: string,
  ) {
    return this.assessment.getForStudent(user, assessmentId);
  }

  @Post('assessments/:assessmentId/submit')
  @HttpCode(200)
  submit(
    @CurrentUser() user: JwtPayload,
    @Param('assessmentId') assessmentId: string,
    @Body() dto: SubmitAttemptDto,
  ) {
    return this.assessment.submit(user, assessmentId, dto);
  }

  @Post('remediation/:remediationId/done')
  @HttpCode(200)
  markRemediationDone(
    @CurrentUser() user: JwtPayload,
    @Param('remediationId') remediationId: string,
  ) {
    return this.assessment.markRemediationDone(user, remediationId);
  }

  // ---------- Manager: results ----------

  @Get('assessments/:assessmentId/results')
  results(
    @CurrentUser() user: JwtPayload,
    @Param('assessmentId') assessmentId: string,
  ) {
    return this.assessment.results(user, assessmentId);
  }
}
