import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { CurrentUser } from '../auth/current-user.decorator';
import { Public } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { Roles } from '../auth/roles.guard';
import { CreateSessionDto } from './dto/create-session.dto';
import { SessionsService } from './sessions.service';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Post()
  @Roles(Role.INSTRUCTOR)
  schedule(@CurrentUser() user: JwtPayload, @Body() dto: CreateSessionDto) {
    return this.sessions.schedule(user.sub, dto);
  }

  /** Public: the course page shows the schedule to anonymous visitors. */
  @Public()
  @Get()
  list(@Query('courseId') courseId: string) {
    return this.sessions.listForCourse(courseId);
  }

  /** Public catalog feed — live + upcoming sessions across all courses.
   *  Declared before :id so "browse" isn't matched as a session id. */
  @Public()
  @Get('browse')
  browse() {
    return this.sessions.browse();
  }

  /** Join-button state for a course (generic, not user-specific).
   *  Declared before :id so "course" isn't matched as a session id. */
  @Public()
  @Get('course/:courseId/status')
  courseStatus(@Param('courseId') courseId: string) {
    return this.sessions.courseSessionStatus(courseId);
  }

  /** Enter today's live session for a course — materialises it on first join.
   *  `as=teach` lets an org admin enter as the instructor (solo-teacher mode). */
  @Post('course/:courseId/join')
  joinCourse(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Query('as') as?: string,
  ) {
    return this.sessions.resolveCourseSession(user, courseId, as === 'teach');
  }

  /** Attendance sheet for a course — instructor-owner or org-admin only.
   *  `sessionId` filters to one session; omit to default to the latest.
   *  Declared before :id so "course" isn't matched as a session id. */
  @Get('course/:courseId/attendance')
  attendance(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
    @Query('sessionId') sessionId?: string,
  ) {
    return this.sessions.attendanceForCourse(user, courseId, sessionId);
  }

  @Public()
  @Get(':id')
  get(@Param('id') id: string) {
    return this.sessions.get(id);
  }

  @Post(':id/start')
  @Roles(Role.INSTRUCTOR)
  start(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.sessions.start(user.sub, id);
  }

  @Post(':id/end')
  @Roles(Role.INSTRUCTOR, Role.ORG_ADMIN)
  end(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.sessions.end(user, id);
  }

  /** Mint a LiveKit join token for the current user.
   *  `as=teach` mints a visible instructor token for a solo-teacher admin. */
  @Post(':id/token')
  token(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Query('as') as?: string,
  ) {
    return this.sessions.joinToken(user, id, as === 'teach');
  }
}
