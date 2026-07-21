import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, SessionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { LivekitService } from './livekit.service';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly livekit: LivekitService,
  ) {}

  async schedule(instructorId: string, dto: CreateSessionDto) {
    await this.courses.assertCourseOwner(instructorId, dto.courseId);
    if (dto.sectionId) {
      const section = await this.prisma.section.findFirst({
        where: { id: dto.sectionId, courseId: dto.courseId },
        select: { id: true },
      });
      if (!section) throw new NotFoundException('Section not found in course');
    }
    return this.prisma.liveSession.create({
      data: {
        courseId: dto.courseId,
        sectionId: dto.sectionId,
        scheduledAt: new Date(dto.scheduledAt),
        livekitRoom: `session-${randomUUID()}`,
      },
    });
  }

  listForCourse(courseId: string) {
    return this.prisma.liveSession.findMany({
      where: { courseId },
      orderBy: { scheduledAt: 'desc' },
      include: { section: { select: { id: true, title: true, order: true } } },
    });
  }

  async get(id: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id },
      include: {
        section: { select: { id: true, title: true, order: true } },
        course: {
          select: {
            id: true,
            title: true,
            instructor: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    return session;
  }

  async start(instructorId: string, id: string) {
    const session = await this.getOwned(instructorId, id);
    if (session.status !== SessionStatus.SCHEDULED) {
      throw new ConflictException(`Cannot start a ${session.status} session`);
    }
    return this.prisma.liveSession.update({
      where: { id },
      data: { status: SessionStatus.LIVE, startedAt: new Date() },
    });
  }

  async end(instructorId: string, id: string) {
    const session = await this.getOwned(instructorId, id);
    if (session.status !== SessionStatus.LIVE) {
      throw new ConflictException(`Cannot end a ${session.status} session`);
    }
    return this.prisma.liveSession.update({
      where: { id },
      data: { status: SessionStatus.ENDED, endedAt: new Date() },
    });
  }

  /**
   * Join token. Instructors (owner only) can join while SCHEDULED to set up;
   * students must be enrolled and the session must be LIVE.
   */
  async joinToken(user: JwtPayload, id: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id },
      include: { course: { select: { id: true, instructorId: true } } },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.status === SessionStatus.ENDED) {
      throw new ConflictException('Session has ended');
    }

    if (user.role === Role.INSTRUCTOR) {
      if (session.course.instructorId !== user.sub) {
        throw new ForbiddenException('Not your session');
      }
    } else {
      if (session.status !== SessionStatus.LIVE) {
        throw new ConflictException('Session is not live yet');
      }
      const enrollment = await this.prisma.enrollment.findUnique({
        where: {
          courseId_studentId: {
            courseId: session.course.id,
            studentId: user.sub,
          },
        },
        select: { id: true },
      });
      if (!enrollment) throw new ForbiddenException('Not enrolled');
    }

    const token = await this.livekit.mintJoinToken({
      room: session.livekitRoom,
      userId: user.sub,
      name: user.name,
      role: user.role,
    });
    return { token, url: this.livekit.url, room: session.livekitRoom };
  }

  private async getOwned(instructorId: string, id: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id },
      include: { course: { select: { instructorId: true } } },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.course.instructorId !== instructorId) {
      throw new ForbiddenException('Not your session');
    }
    return session;
  }
}
