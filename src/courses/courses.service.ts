import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, SessionStatus } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { aggregateStudentStats } from '../performance/student-stats';
import { buildCourseIcs } from './calendar-ics';
import { AssignInstructorDto } from './dto/assign-instructor.dto';
import { CreateCourseDto } from './dto/create-course.dto';
import { CreateSectionDto } from './dto/create-section.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { UpdateSectionDto } from './dto/update-section.dto';

@Injectable()
export class CoursesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  // Schedule fields whose change should re-prompt students to update reminders.
  private static readonly SCHEDULE_FIELDS = [
    'startDate',
    'durationWeeks',
    'meetingDays',
    'meetingTime',
    'timezone',
  ] as const;

  // ---------- Courses ----------

  /** Org admin creates a course for their org; may assign an instructor now. */
  async createCourse(user: JwtPayload, dto: CreateCourseDto) {
    const orgId = this.orgOf(user);
    const { instructorId, ...rest } = dto;
    if (instructorId) await this.assertOrgInstructor(orgId, instructorId);
    return this.prisma.course.create({
      data: {
        ...rest,
        organizationId: orgId,
        instructorId: instructorId ?? null,
        ...this.cohortOverrides(dto),
      },
    });
  }

  /**
   * Company-scoped catalog. Students & admins see every course in their org;
   * instructors see only the courses assigned to them. Each row carries a
   * light session summary (live now / next scheduled) for the cohort cards.
   */
  async listCatalog(user: JwtPayload) {
    if (!user.organizationId) return [];
    const where: Prisma.CourseWhereInput = {
      organizationId: user.organizationId,
    };
    if (user.role === Role.INSTRUCTOR) where.instructorId = user.sub;

    const courses = await this.prisma.course.findMany({
      where,
      include: {
        instructor: { select: { id: true, name: true } },
        _count: { select: { enrollments: true, sections: true } },
        sessions: {
          where: {
            status: { in: [SessionStatus.LIVE, SessionStatus.SCHEDULED] },
          },
          select: { id: true, status: true, scheduledAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return courses.map(({ sessions, ...c }) => {
      const live = sessions.find((s) => s.status === SessionStatus.LIVE);
      const next = sessions
        .filter((s) => s.status === SessionStatus.SCHEDULED)
        .sort((a, b) => +a.scheduledAt - +b.scheduledAt)[0];
      return {
        ...c,
        liveSessionId: live?.id ?? null,
        nextSessionAt: next?.scheduledAt ?? null,
      };
    });
  }

  /** Course detail, scoped: same org required; instructors must be assigned. */
  async getCourseFor(user: JwtPayload, id: string) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        instructor: { select: { id: true, name: true } },
        sections: { orderBy: { order: 'asc' } },
        _count: { select: { enrollments: true } },
      },
    });
    if (!course) throw new NotFoundException('Course not found');
    // Don't leak existence across tenants.
    if (!user.organizationId || course.organizationId !== user.organizationId) {
      throw new NotFoundException('Course not found');
    }
    if (user.role === Role.INSTRUCTOR && course.instructorId !== user.sub) {
      throw new ForbiddenException('This course is not assigned to you');
    }
    return course;
  }

  // ---------- Calendar reminders ----------

  /** A recurring .ics for the course's weekly cadence (tenant-scoped). */
  async getCalendarIcs(user: JwtPayload, id: string): Promise<string> {
    const course = await this.prisma.course.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        organizationId: true,
        startDate: true,
        durationWeeks: true,
        meetingDays: true,
        meetingTime: true,
        timezone: true,
        scheduleUpdatedAt: true,
      },
    });
    if (
      !course ||
      !user.organizationId ||
      course.organizationId !== user.organizationId
    ) {
      throw new NotFoundException('Course not found');
    }
    const ics = buildCourseIcs(course);
    if (!ics) throw new BadRequestException('This class has no schedule yet');
    return ics;
  }

  /** Record that the student tapped "Add to calendar" (best-effort proxy). */
  async markReminderAdded(userId: string, courseId: string) {
    const updated = await this.prisma.enrollment.updateMany({
      where: { courseId, studentId: userId },
      data: { reminderAddedAt: new Date() },
    });
    if (updated.count === 0) {
      throw new NotFoundException('You are not enrolled in this class');
    }
    return { ok: true };
  }

  async updateCourse(user: JwtPayload, id: string, dto: UpdateCourseDto) {
    await this.assertCanManageCourse(user, id);
    const { instructorId, ...rest } = dto;
    const dtoRec = dto as Record<string, unknown>;
    const scheduleChanged = CoursesService.SCHEDULE_FIELDS.some(
      (f) => dtoRec[f] !== undefined,
    );
    const course = await this.prisma.course.update({
      where: { id },
      data: {
        ...rest,
        ...this.cohortOverrides(dto),
        ...(scheduleChanged ? { scheduleUpdatedAt: new Date() } : {}),
      },
    });
    // Prompt students who'd set a reminder to re-add the updated series.
    if (scheduleChanged) void this.notifyScheduleChange(id).catch(() => {});
    return course;
  }

  private async notifyScheduleChange(courseId: string): Promise<void> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        title: true,
        enrollments: {
          where: { reminderAddedAt: { not: null } },
          select: { student: { select: { name: true, email: true } } },
        },
      },
    });
    if (!course) return;
    const base = process.env.WEB_URL ?? 'http://localhost:3001';
    const url = `${base}/courses/${courseId}`;
    for (const e of course.enrollments) {
      await this.mail.sendScheduleChanged(
        e.student.email,
        e.student.name,
        course.title,
        url,
      );
    }
  }

  /** Org admin assigns (or clears) the instructor handling a course. */
  async assignInstructor(user: JwtPayload, id: string, dto: AssignInstructorDto) {
    const orgId = this.orgOf(user);
    const course = await this.prisma.course.findUnique({
      where: { id },
      select: { organizationId: true },
    });
    if (!course || course.organizationId !== orgId) {
      throw new NotFoundException('Course not found');
    }
    if (dto.instructorId) await this.assertOrgInstructor(orgId, dto.instructorId);
    return this.prisma.course.update({
      where: { id },
      data: { instructorId: dto.instructorId ?? null },
    });
  }

  /**
   * Normalize the two cohort fields Prisma can't take verbatim from the DTO:
   * a date-only `startDate` becomes a real Date, and `meetingDays` is
   * de-duplicated and sorted (Sun→Sat) so the client can render it directly.
   */
  private cohortOverrides(dto: {
    startDate?: string | null;
    meetingDays?: number[] | null;
  }) {
    const out: {
      startDate?: Date | null;
      meetingDays?: Prisma.InputJsonValue | typeof Prisma.DbNull;
    } = {};
    if (dto.startDate !== undefined) {
      out.startDate = dto.startDate === null ? null : new Date(dto.startDate);
    }
    if (dto.meetingDays !== undefined) {
      out.meetingDays =
        dto.meetingDays === null
          ? Prisma.DbNull
          : Array.from(new Set(dto.meetingDays)).sort((a, b) => a - b);
    }
    return out;
  }

  // ---------- Sections ----------

  async addSection(user: JwtPayload, courseId: string, dto: CreateSectionDto) {
    await this.assertCanManageCourse(user, courseId);
    const order = dto.order ?? (await this.nextSectionOrder(courseId));
    try {
      return await this.prisma.section.create({
        data: {
          courseId,
          title: dto.title,
          description: dto.description?.trim() || null,
          order,
        },
      });
    } catch (e) {
      throw this.mapDuplicateOrder(e, courseId);
    }
  }

  async updateSection(
    user: JwtPayload,
    courseId: string,
    sectionId: string,
    dto: UpdateSectionDto,
  ) {
    await this.assertCanManageCourse(user, courseId);
    const section = await this.prisma.section.findFirst({
      where: { id: sectionId, courseId },
    });
    if (!section) throw new NotFoundException('Section not found');
    try {
      return await this.prisma.section.update({
        where: { id: sectionId },
        data: dto,
      });
    } catch (e) {
      throw this.mapDuplicateOrder(e, courseId);
    }
  }

  // ---------- Enrollment ----------

  async enroll(user: JwtPayload, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, organizationId: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    // A student can only enroll in a course offered by their own company.
    if (!user.organizationId || course.organizationId !== user.organizationId) {
      throw new ForbiddenException('This course is not offered by your organization');
    }
    try {
      return await this.prisma.enrollment.create({
        data: { courseId, studentId: user.sub },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Already enrolled');
      }
      throw e;
    }
  }

  async unenroll(studentId: string, courseId: string) {
    const deleted = await this.prisma.enrollment.deleteMany({
      where: { courseId, studentId },
    });
    if (deleted.count === 0) throw new NotFoundException('Not enrolled');
    return { unenrolled: true };
  }

  /** Org admin enrolls a specific student into one of their org's programs. */
  async enrollStudent(user: JwtPayload, courseId: string, studentId: string) {
    const orgId = this.orgOf(user);
    await this.assertOrgCourse(orgId, courseId);
    await this.assertOrgStudent(orgId, studentId);
    try {
      return await this.prisma.enrollment.create({
        data: { courseId, studentId },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Already enrolled');
      }
      throw e;
    }
  }

  /** Org admin removes a specific student from one of their org's programs. */
  async removeStudentByAdmin(user: JwtPayload, courseId: string, studentId: string) {
    const orgId = this.orgOf(user);
    await this.assertOrgCourse(orgId, courseId);
    return this.unenroll(studentId, courseId);
  }

  /** Roster for one course — the assigned instructor or the org admin. */
  async listStudents(user: JwtPayload, courseId: string) {
    await this.assertCanManageCourse(user, courseId);
    return this.prisma.enrollment.findMany({
      where: { courseId },
      include: {
        student: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The instructor's students with performance metrics (their programs only). */
  async instructorStudentStats(instructorId: string, courseId?: string) {
    const courseWhere: Prisma.CourseWhereInput = {
      instructorId,
      ...(courseId && { id: courseId }),
    };
    const students = await this.prisma.user.findMany({
      where: {
        role: Role.STUDENT,
        enrollments: { some: { course: courseWhere } },
      },
      select: {
        id: true,
        name: true,
        email: true,
        enrollments: {
          where: { course: { instructorId } },
          select: { courseId: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const withEnrollments = students.map((s) => ({
      id: s.id,
      enrolledCourseIds: s.enrollments.map((e) => e.courseId),
    }));
    const stats = await aggregateStudentStats(
      this.prisma,
      withEnrollments,
      courseWhere,
    );

    return students.map((s, i) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      enrolledCourseIds: withEnrollments[i].enrolledCourseIds,
      ...stats.get(s.id)!,
    }));
  }

  /** Distinct students across all courses this instructor is assigned. */
  async listInstructorStudents(instructorId: string) {
    const rows = await this.prisma.enrollment.findMany({
      where: { course: { instructorId } },
      include: {
        student: { select: { id: true, name: true, email: true } },
        course: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows;
  }

  listEnrolled(studentId: string) {
    return this.prisma.enrollment.findMany({
      where: { studentId },
      include: {
        course: {
          include: { instructor: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ---------- Helpers ----------

  private orgOf(user: JwtPayload): string {
    if (!user.organizationId) {
      throw new ForbiddenException('No organization on this account');
    }
    return user.organizationId;
  }

  private async assertOrgInstructor(orgId: string, instructorId: string) {
    const found = await this.prisma.user.findFirst({
      where: { id: instructorId, organizationId: orgId, role: Role.INSTRUCTOR },
      select: { id: true },
    });
    if (!found) {
      throw new BadRequestException('Instructor not found in your organization');
    }
  }

  private async assertOrgStudent(orgId: string, studentId: string) {
    const found = await this.prisma.user.findFirst({
      where: { id: studentId, organizationId: orgId, role: Role.STUDENT },
      select: { id: true },
    });
    if (!found) {
      throw new BadRequestException('Student not found in your organization');
    }
  }

  /** Ensures the course exists and belongs to the given org. */
  private async assertOrgCourse(orgId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { organizationId: true },
    });
    if (!course || course.organizationId !== orgId) {
      throw new NotFoundException('Course not found');
    }
  }

  /** Assigned instructor of the course, or an admin of the owning org. */
  async assertCanManageCourse(user: JwtPayload, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { instructorId: true, organizationId: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    const isOwningAdmin =
      user.role === Role.ORG_ADMIN &&
      !!user.organizationId &&
      course.organizationId === user.organizationId;
    if (isOwningAdmin || course.instructorId === user.sub) return;
    throw new ForbiddenException('Not your course');
  }

  /** Assigned instructor only (used for live-session scheduling/control). */
  async assertCourseOwner(instructorId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { instructorId: true },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.instructorId !== instructorId) {
      throw new ForbiddenException('Not your course');
    }
  }

  private async nextSectionOrder(courseId: string): Promise<number> {
    const last = await this.prisma.section.findFirst({
      where: { courseId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    return (last?.order ?? 0) + 1;
  }

  private mapDuplicateOrder(e: unknown, courseId: string): unknown {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      return new ConflictException(
        `A section with that order already exists in course ${courseId}`,
      );
    }
    return e;
  }
}
