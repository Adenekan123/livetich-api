import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { AssignmentsService } from './assignments.service';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { GradeSubmissionDto } from './dto/grade-submission.dto';
import { SubmitAssignmentDto } from './dto/submit-assignment.dto';

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

  @Get('assignments/:id/submissions')
  submissions(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.assignments.listSubmissions(user, id);
  }

  // ---- Student submission ----

  @Post('assignments/:id/submissions')
  @Roles(Role.STUDENT)
  submit(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: SubmitAssignmentDto,
  ) {
    return this.assignments.submit(user, id, dto);
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
