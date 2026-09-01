import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role, SessionStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { JwtPayload } from '../auth/jwt-payload';
import { AssessmentService } from '../assessment/assessment.service';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoomBroadcaster } from '../realtime/room-broadcaster';
import { CreateSessionDto } from './dto/create-session.dto';
import { LivekitService } from './livekit.service';
import { resolveJoinWindow } from './session-schedule';

const COURSE_SCHEDULE_SELECT = {
  id: true,
  instructorId: true,
  organizationId: true,
  startDate: true,
  durationWeeks: true,
  meetingDays: true,
  meetingTime: true,
  timezone: true,
} as const;

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly livekit: LivekitService,
    private readonly assessment: AssessmentService,
    private readonly broadcaster: RoomBroadcaster,
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

  /**
   * Public catalog feed for the browse page: every live and upcoming session
   * across all courses, with the course + instructor context each tile needs.
   * Live first (most recently started), then upcoming (soonest scheduled).
   */
  browse() {
    return this.prisma.liveSession.findMany({
      where: { status: { in: [SessionStatus.LIVE, SessionStatus.SCHEDULED] } },
      orderBy: [{ startedAt: 'desc' }, { scheduledAt: 'asc' }],
      include: {
        section: { select: { id: true, title: true, order: true } },
        course: {
          select: {
            id: true,
            title: true,
            description: true,
            category: true,
            level: true,
            startDate: true,
            durationWeeks: true,
            meetingDays: true,
            meetingTime: true,
            timezone: true,
            instructor: { select: { id: true, name: true } },
            _count: { select: { enrollments: true } },
          },
        },
      },
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

  async end(user: JwtPayload, id: string) {
    const session = await this.getManageable(user, id);
    if (session.status !== SessionStatus.LIVE) {
      throw new ConflictException(`Cannot end a ${session.status} session`);
    }
    const ended = await this.prisma.liveSession.update({
      where: { id },
      data: { status: SessionStatus.ENDED, endedAt: new Date() },
    });

    // Class preferences that fire on end: whether the quiz releases instantly,
    // and whether students are evicted from the room.
    const course = await this.prisma.course.findUnique({
      where: { id: ended.courseId },
      select: {
        instantClassAssessment: true,
        organization: { select: { evictOnInstructorLeave: true } },
      },
    });

    // Materialise the class-end assessment (best-effort; no question bank → no-op).
    // Held (unreleased) when the course opts out of instant release.
    void this.assessment
      .createForSession(
        { id: ended.id, courseId: ended.courseId, sectionId: ended.sectionId },
        course?.instantClassAssessment ?? true,
      )
      .catch(() => {});

    // Evict students to the course page (they don't linger on a dead board).
    if (course?.organization?.evictOnInstructorLeave) {
      this.broadcaster.emitToSession(ended.id, 'room:closed', {
        sessionId: ended.id,
        reason: 'ENDED',
      });
    }
    return ended;
  }

  /**
   * The program cadence drives sessions now: on a scheduled meeting day (from
   * the meeting time onward) anyone entitled can Join, and today's occurrence is
   * materialised on first entry. The instructor arriving flips it LIVE; students
   * may enter beforehand and see the "instructor will join soon" board.
   */
  async resolveCourseSession(user: JwtPayload, courseId: string, teach = false) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: COURSE_SCHEDULE_SELECT,
    });
    if (!course) throw new NotFoundException('Course not found');

    const window = resolveJoinWindow(course);
    if (!window.current || !window.joinableNow) {
      throw new ConflictException('No live session scheduled right now');
    }

    const isOwner =
      user.role === Role.INSTRUCTOR && course.instructorId === user.sub;
    // Admins may resolve any of their org's live sessions to shadow-join them.
    const isAdmin =
      user.role === Role.ORG_ADMIN &&
      course.organizationId === user.organizationId;
    // A solo-teacher admin can enter as the instructor (teach-mode) — arriving
    // this way makes the room go live, exactly like the assigned instructor.
    const goingLiveAsHost = isOwner || (isAdmin && teach);
    if (user.role === Role.INSTRUCTOR && !isOwner) {
      throw new ForbiddenException('Not your course');
    }
    if (user.role === Role.STUDENT) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: { courseId_studentId: { courseId, studentId: user.sub } },
        select: { id: true },
      });
      if (!enrollment) throw new ForbiddenException('Not enrolled');
    } else if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Not a participant of this session');
    }

    const room = `course-${courseId}-${window.current.dateKey}`;
    // Idempotent on the unique room name — the first join today creates the row.
    const session = await this.prisma.liveSession.upsert({
      where: { livekitRoom: room },
      create: {
        courseId,
        scheduledAt: window.current.scheduledAt,
        livekitRoom: room,
      },
      update: {},
    });
    // Ending class isn't terminal for the day: within today's join window (the
    // guard above guarantees we're inside it) the room stays open, so an
    // instructor who ended early — or students who drifted off — can re-enter.
    // Reopen a previously-ended occurrence back to SCHEDULED; the instructor
    // arriving then flips it LIVE via the branch below.
    let status: SessionStatus = session.status;
    if (status === SessionStatus.ENDED) {
      await this.prisma.liveSession.update({
        where: { id: session.id },
        data: { status: SessionStatus.SCHEDULED, endedAt: null },
      });
      status = SessionStatus.SCHEDULED;
    }
    // The instructor arriving — or an admin entering in teach-mode — is what
    // makes the room live.
    if (goingLiveAsHost && status === SessionStatus.SCHEDULED) {
      await this.prisma.liveSession.update({
        where: { id: session.id },
        data: { status: SessionStatus.LIVE, startedAt: new Date() },
      });
    }
    return { sessionId: session.id };
  }

  /** Button state for the course page: can I join now, and when is the next meeting. */
  async courseSessionStatus(courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: COURSE_SCHEDULE_SELECT,
    });
    if (!course) throw new NotFoundException('Course not found');

    const window = resolveJoinWindow(course);
    let isLive = false;
    if (window.current) {
      const room = `course-${courseId}-${window.current.dateKey}`;
      const today = await this.prisma.liveSession.findUnique({
        where: { livekitRoom: room },
        select: { status: true },
      });
      isLive = today?.status === SessionStatus.LIVE;
    }
    return {
      joinableNow: window.joinableNow,
      isLive,
      nextAt: (window.current ?? window.next)?.scheduledAt ?? null,
    };
  }

  /**
   * Join token. Instructors (owner only) may enter their room; enrolled students
   * may enter any non-ended session — if the instructor hasn't arrived yet the
   * classroom shows a waiting board until it flips LIVE.
   */
  async joinToken(user: JwtPayload, id: string, teach = false) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id },
      include: {
        course: {
          select: { id: true, instructorId: true, organizationId: true },
        },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (session.status === SessionStatus.ENDED) {
      throw new ConflictException('Session has ended');
    }

    // Admins normally shadow-join: they observe without appearing to anyone. In
    // teach-mode a solo-teacher admin instead joins as the instructor — visible,
    // publishing, and with an INSTRUCTOR token so the room grants host powers.
    // Everyone else must own or be enrolled, and students are attended.
    const isAdmin = user.role === Role.ORG_ADMIN;
    const teaching = isAdmin && teach;
    const shadow = isAdmin && !teach;
    if (user.role === Role.INSTRUCTOR) {
      if (session.course.instructorId !== user.sub) {
        throw new ForbiddenException('Not your session');
      }
    } else if (isAdmin) {
      if (session.course.organizationId !== user.organizationId) {
        throw new ForbiddenException('Not your organization');
      }
    } else {
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

      // Record attendance the first time this student joins the live session.
      await this.prisma.attendance.upsert({
        where: {
          sessionId_studentId: { sessionId: id, studentId: user.sub },
        },
        create: { sessionId: id, studentId: user.sub },
        update: {},
      });
    }

    const token = await this.livekit.mintJoinToken({
      room: session.livekitRoom,
      userId: user.sub,
      name: user.name,
      // A teaching admin carries an INSTRUCTOR role in the token metadata so the
      // room treats them as the host, not an admin observer.
      role: teaching ? Role.INSTRUCTOR : user.role,
      hidden: shadow,
    });
    return { token, url: this.livekit.url, room: session.livekitRoom };
  }

  /**
   * Attendance sheet for a course: the full session list (for the filter
   * dropdown, newest first) plus, for the selected session — or the most
   * recent one when none is given — every enrolled student marked present or
   * absent from the Attendance log. Instructor-owner or org-admin only.
   */
  async attendanceForCourse(
    user: JwtPayload,
    courseId: string,
    sessionId?: string,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);

    const sessions = await this.prisma.liveSession.findMany({
      where: { courseId },
      orderBy: { scheduledAt: 'desc' },
      select: {
        id: true,
        scheduledAt: true,
        status: true,
        section: { select: { title: true } },
      },
    });
    const sessionList = sessions.map((s) => ({
      id: s.id,
      scheduledAt: s.scheduledAt,
      status: s.status,
      sectionTitle: s.section?.title ?? null,
    }));

    // Default to the most recent session; a supplied id must belong to this course.
    const selected = sessionId
      ? sessions.find((s) => s.id === sessionId)
      : sessions[0];
    if (!selected) {
      return { sessions: sessionList, sessionId: null, rows: [] };
    }

    const [enrollments, attendances] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { courseId },
        select: { student: { select: { id: true, name: true } } },
        orderBy: { student: { name: 'asc' } },
      }),
      this.prisma.attendance.findMany({
        where: { sessionId: selected.id },
        select: { studentId: true, joinedAt: true },
      }),
    ]);

    const joinedById = new Map(
      attendances.map((a) => [a.studentId, a.joinedAt]),
    );
    const rows = enrollments.map((e) => ({
      studentId: e.student.id,
      name: e.student.name,
      present: joinedById.has(e.student.id),
      joinedAt: joinedById.get(e.student.id) ?? null,
    }));

    return { sessions: sessionList, sessionId: selected.id, rows };
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

  /** The session if the caller may run it: the assigned instructor, or an admin
   *  of the owning org (a solo teacher ending their own teach-mode class). */
  private async getManageable(user: JwtPayload, id: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id },
      include: {
        course: { select: { instructorId: true, organizationId: true } },
      },
    });
    if (!session) throw new NotFoundException('Session not found');
    const isOwner =
      user.role === Role.INSTRUCTOR &&
      session.course.instructorId === user.sub;
    const isAdmin =
      user.role === Role.ORG_ADMIN &&
      session.course.organizationId === user.organizationId;
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException('Not your session');
    }
    return session;
  }
}
