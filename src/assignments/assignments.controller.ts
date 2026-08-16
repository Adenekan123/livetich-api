import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { AssignmentsService } from './assignments.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { GradeSubmissionDto } from './dto/grade-submission.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';

/** Multer file shape (subset) — avoids a hard dependency on Express types. */
interface UploadedBlob {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

@Controller()
export class AssignmentsController {
  constructor(private readonly assignments: AssignmentsService) {}

  // ---- Coursework (manage = assigned instructor or org admin) ----

  @Post('courses/:courseId/assignments')
  create(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Body() dto: CreateAssignmentDto,
  ) {
    return this.assignments.create(user, courseId, dto);
  }

  @Get('courses/:courseId/assignments')
  list(@CurrentUser() user: JwtPayload, @Param('courseId') courseId: string) {
    return this.assignments.listForCourse(user, courseId);
  }

  /** Manager dashboard: assignments with submitted vs missing rosters. */
  @Get('courses/:courseId/assignments/tracking')
  tracking(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.assignments.courseTracking(user, courseId);
  }

  @Get('assignments/:id/submissions')
  submissions(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.assignments.listSubmissions(user, id);
  }

  // ---- Student submission ----

  /** The signed-in student's assignments across enrolled courses — powers the
   *  VSCode extension's submit picker (and a future web "my work" view). */
  @Get('assignments/mine')
  @Roles(Role.STUDENT)
  mine(@CurrentUser() user: JwtPayload) {
    return this.assignments.mine(user);
  }

  @Post('assignments/:id/submissions')
  @Roles(Role.STUDENT)
  submit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SubmitAssignmentDto,
  ) {
    return this.assignments.submit(user, id, dto);
  }

  /** Student uploads a recitation audio (or image/PDF) as their submission. */
  @Post('assignments/:id/submissions/upload')
  @Roles(Role.STUDENT)
  // Cap at the multer layer so an oversized upload is aborted mid-stream
  // instead of buffered whole into memory (the service re-checks size too).
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }))
  uploadSubmission(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @UploadedFile() file: UploadedBlob,
  ) {
    return this.assignments.uploadSubmission(user, id, file);
  }

  /** Streams a submission's uploaded blob (owner or course manager only). */
  @Get('files/submission/:id')
  async submissionFile(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
  ) {
    const { stream, mime } = await this.assignments.streamSubmissionFile(
      user,
      id,
    );
    return new StreamableFile(stream, { type: mime });
  }

  // ---- Grading ----

  @Patch('submissions/:id')
  grade(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: GradeSubmissionDto,
  ) {
    return this.assignments.grade(user, id, dto);
  }
}
