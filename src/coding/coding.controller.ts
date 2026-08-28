import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { CodingService } from './coding.service';
import { CodingSubmissionsService } from './coding-submissions.service';
import { CodingAiReviewService } from './coding-ai-review.service';
import { CodingInstructorService } from './coding-instructor.service';
import { MAX_ARCHIVE_BYTES } from './coding-archive.util';
import { CreateCodingAssignmentDto } from './dto/create-coding-assignment.dto';
import { DecisionDto } from './dto/decision.dto';
import { CreateFeedbackDto } from './dto/feedback.dto';
import { LaunchAssignmentDto } from './dto/launch-assignment.dto';
import { UpdateCodingAssignmentDto } from './dto/update-coding-assignment.dto';

/** Multer memory-storage file (subset) — avoids a hard Express type dependency. */
interface UploadedBlob {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

/** Coding Instructor Plugin — assignment authoring, delivery & submissions. */
@Controller('coding')
export class CodingController {
  constructor(
    private readonly coding: CodingService,
    private readonly submissions: CodingSubmissionsService,
    private readonly aiReview: CodingAiReviewService,
    private readonly instructor: CodingInstructorService,
  ) {}

  // ---- Student ----

  /** The signed-in student's coding assignments (VS Code plugin list). */
  @Get('mine')
  mine(@CurrentUser() user: JwtPayload) {
    return this.coding.mine(user);
  }

  /** The manager's coding assignments across their courses (Teaching list). */
  @Get('teaching')
  teaching(@CurrentUser() user: JwtPayload) {
    return this.coding.teaching(user);
  }

  /** Courses + their live / next session, to drive the plugin's new-task form. */
  @Get('authoring-context')
  authoringContext(@CurrentUser() user: JwtPayload) {
    return this.coding.authoringContext(user);
  }

  // ---- Authoring (manager = assigned instructor or org admin) ----

  @Post('courses/:courseId/assignments')
  create(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: CreateCodingAssignmentDto,
  ) {
    return this.coding.create(user, courseId, dto);
  }

  @Get('courses/:courseId/assignments')
  list(@CurrentUser() user: JwtPayload, @Param('courseId') courseId: string) {
    return this.coding.listForCourse(user, courseId);
  }

  @Get('assignments/:id')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.coding.get(user, id);
  }

  @Patch('assignments/:id')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateCodingAssignmentDto,
  ) {
    return this.coding.update(user, id, dto);
  }

  /** Launch live ("Practice now"). */
  @Post('assignments/:id/launch')
  launch(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: LaunchAssignmentDto,
  ) {
    return this.coding.launch(user, id, dto.sessionId);
  }

  @Post('assignments/:id/close')
  close(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.coding.close(user, id);
  }

  // ---- Submissions ----

  /** Student uploads a project .zip as a new attempt. */
  @Post('assignments/:id/submit')
  @Roles(Role.STUDENT)
  // Cap at the multer layer so an oversized upload aborts mid-stream instead of
  // buffering whole into memory (the service re-checks size + validity too).
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_ARCHIVE_BYTES } }),
  )
  async submit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file: UploadedBlob,
  ) {
    const result = await this.submissions.submit(user, id, file);
    // Kick off the AI review in the background if the assignment opts in.
    void this.aiReview.maybeAutoReview(result.submission.id);
    return result;
  }

  /** Manager re-runs the AI review for a submission. */
  @Post('submissions/:id/review')
  review(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.aiReview.requestReview(user, id);
  }

  /** Full submission detail (owner or course manager). */
  @Get('submissions/:id')
  submission(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.submissions.getSubmission(user, id);
  }

  /** One file's text content from the submitted archive (review viewer). */
  @Get('submissions/:id/file')
  fileContent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('path') path: string,
  ) {
    return this.submissions.getFileContent(user, id, path);
  }

  /** Download the immutable submitted archive (owner or manager). */
  @Get('files/archive/:id')
  async archive(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const stream = await this.submissions.streamArchive(user, id);
    return new StreamableFile(stream, {
      type: 'application/zip',
      disposition: `attachment; filename="submission-${id}.zip"`,
    });
  }

  // ---- Instructor dashboard, feedback & decision ----

  /** Submissions dashboard for one assignment (stats + per-student latest). */
  @Get('assignments/:id/dashboard')
  dashboard(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.instructor.dashboard(user, id);
  }

  /** Add feedback to a submission (general or an inline file/line comment). */
  @Post('submissions/:id/feedback')
  feedback(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateFeedbackDto,
  ) {
    return this.instructor.addFeedback(user, id, dto);
  }

  /** The instructor's final ruling — pass, fail, or return for revision. */
  @Post('submissions/:id/decision')
  decide(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: DecisionDto,
  ) {
    return this.instructor.decide(user, id, dto);
  }
}
