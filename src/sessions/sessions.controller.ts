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

  /** Enter today's live session for a course — materialises it on first join. */
  @Post('course/:courseId/join')
  joinCourse(
    @CurrentUser() user: JwtPayload,
    @Param('courseId') courseId: string,
  ) {
    return this.sessions.resolveCourseSession(user, courseId);
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
  @Roles(Role.INSTRUCTOR)
  end(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.sessions.end(user.sub, id);
  }

  /** Mint a LiveKit join token for the current user. */
  @Post(':id/token')
  token(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.sessions.joinToken(user, id);
  }
}
