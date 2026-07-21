import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  // ---------- Browse (any authenticated user) ----------

  @Get()
  list() {
    return this.courses.listCourses();
  }

  /** Must be declared before :id so "enrolled" isn't matched as a course id. */
  @Get('enrolled')
  @Roles(Role.STUDENT)
  enrolled(@CurrentUser() user: JwtPayload) {
    return this.courses.listEnrolled(user.sub);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.courses.getCourse(id);
  }

  // ---------- Instructor ----------

  @Post()
  @Roles(Role.INSTRUCTOR)
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateCourseDto) {
    return this.courses.createCourse(user.sub, dto);
  }

  @Patch(':id')
  @Roles(Role.INSTRUCTOR)
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateCourseDto,
  ) {
    return this.courses.updateCourse(user.sub, id, dto);
  }

  @Post(':id/sections')
  @Roles(Role.INSTRUCTOR)
  addSection(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: CreateSectionDto,
  ) {
    return this.courses.addSection(user.sub, id, dto);
  }

  @Patch(':id/sections/:sectionId')
  @Roles(Role.INSTRUCTOR)
  updateSection(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateSectionDto,
  ) {
    return this.courses.updateSection(user.sub, id, sectionId, dto);
  }

  @Get(':id/students')
  @Roles(Role.INSTRUCTOR)
  students(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.listStudents(user.sub, id);
  }

  // ---------- Student ----------

  @Post(':id/enroll')
  @Roles(Role.STUDENT)
  enroll(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.enroll(user.sub, id);
  }

  @Delete(':id/enroll')
  @Roles(Role.STUDENT)
  unenroll(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.courses.unenroll(user.sub, id);
  }
}
