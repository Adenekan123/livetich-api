import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { CoursesService } from './courses.service';
import { AssignInstructorDto } from './dto/assign-instructor.dto';
import { CreateBatchDto } from './dto/create-batch.dto';
import { CreateCourseDto } from './dto/create-course.dto';
import { EnrollStudentDto } from './dto/enroll-student.dto';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  // ---------- Catalog (company-scoped; instructors see only their own) ----------

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.courses.listCatalog(user);
  }

  /** Static routes must precede :id so they aren't matched as a course id. */
  @Get('enrolled')
  @Roles(Role.STUDENT)
  enrolled(@CurrentUser() user: JwtPayload) {
    return this.courses.listEnrolled(user.sub);
  }

  /** An instructor's students across every course they handle. */
  @Get('students')
  @Roles(Role.INSTRUCTOR)
  myStudents(@CurrentUser() user: JwtPayload) {
    return this.courses.listInstructorStudents(user.sub);
  }

  /** The instructor's students with performance metrics; optional ?courseId=. */
  @Get('students/stats')
  @Roles(Role.INSTRUCTOR)
  myStudentStats(
    @CurrentUser() user: JwtPayload,
    @Query('courseId') courseId?: string,
  ) {
    return this.courses.instructorStudentStats(user.sub, courseId || undefined);
  }

  @Get(':id')
  get(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.getCourseFor(user, id);
  }

  /** Recurring calendar file for the class schedule (Add-to-calendar). */
  @Get(':id/calendar.ics')
  @Header('Content-Type', 'text/calendar; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="livetich-class.ics"')
  calendar(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.getCalendarIcs(user, id);
  }

  /** Records that the student tapped "Add to calendar" (reminder-set proxy). */
  @Post(':id/reminder')
  @HttpCode(200)
  markReminder(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.markReminderAdded(user.sub, id);
  }

  // ---------- Org admin: create + assign ----------

  @Post()
  @Roles(Role.ORG_ADMIN)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCourseDto) {
    return this.courses.createCourse(user, dto);
  }

  // ---------- Batches (scheduled instances of a program) ----------

  /** Batches of a program — visible to anyone who can see the program. */
  @Get(':id/batches')
  listBatches(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.listBatches(user, id);
  }

  /** Org admin spins up a new batch of a program (own schedule + roster). */
  @Post(':id/batches')
  @Roles(Role.ORG_ADMIN)
  createBatch(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateBatchDto,
  ) {
    return this.courses.createBatch(user, id, dto);
  }

  /** Danger zone: permanently delete a program (or batch) and all its data. */
  @Delete(':id')
  @Roles(Role.ORG_ADMIN)
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.deleteCourse(user, id);
  }

  @Patch(':id/instructor')
  @Roles(Role.ORG_ADMIN)
  assignInstructor(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: AssignInstructorDto,
  ) {
    return this.courses.assignInstructor(user, id, dto);
  }

  // ---------- Manage (owning admin or assigned instructor) ----------

  /** Editing the program itself (title, schedule, dates, cadence) is admin-only;
   *  instructors manage teaching surfaces (sections, assessments) but don't
   *  reconfigure the program. */
  @Patch(':id')
  @Roles(Role.ORG_ADMIN)
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateCourseDto,
  ) {
    return this.courses.updateCourse(user, id, dto);
  }

  @Post(':id/sections')
  addSection(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateSectionDto,
  ) {
    return this.courses.addSection(user, id, dto);
  }

  @Patch(':id/sections/:sectionId')
  updateSection(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateSectionDto,
  ) {
    return this.courses.updateSection(user, id, sectionId, dto);
  }

  @Get(':id/students')
  students(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.listStudents(user, id);
  }

  /** Org admin enrolls a specific student into this program. */
  @Post(':id/students')
  @Roles(Role.ORG_ADMIN)
  addStudent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: EnrollStudentDto,
  ) {
    return this.courses.enrollStudent(user, id, dto.studentId);
  }

  @Delete(':id/students/:studentId')
  @Roles(Role.ORG_ADMIN)
  removeStudent(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('studentId') studentId: string,
  ) {
    return this.courses.removeStudentByAdmin(user, id, studentId);
  }

  // ---------- Student enrollment ----------

  @Post(':id/enroll')
  @Roles(Role.STUDENT)
  enroll(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.enroll(user, id);
  }

  @Delete(':id/enroll')
  @Roles(Role.STUDENT)
  unenroll(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.unenroll(user.sub, id);
  }
}
