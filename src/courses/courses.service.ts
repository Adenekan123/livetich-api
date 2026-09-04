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
import { CreateBatchDto } from './dto/create-batch.dto';
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
   * Create a *batch* (a scheduled instance) of an existing program. The batch
   * inherits the program's identity (title/description/category/level) and,
   * unless overridden, its cadence — but owns its own schedule, timezone,
   * instructor, roster and runtime. The program's content (syllabus,
   * assessment questions, assignment templates, documents) is snapshotted into
   * the batch so it teaches and assesses like the program from day one; later
   * program edits don't retro-change a running batch.
   */
  async createBatch(user: JwtPayload, programId: string, dto: CreateBatchDto) {
    const orgId = this.orgOf(user);
    const program = await this.prisma.course.findUnique({
      where: { id: programId },
      select: {
        id: true,
        organizationId: true,
        instructorId: true,
        parentCourseId: true,
        title: true,
        description: true,
        posterUrl: true,
        category: true,
        level: true,
        startDate: true,
        durationWeeks: true,
        meetingDays: true,
        meetingTime: true,
        meetingTimesByDay: true,
        timezone: true,
        instantClassAssessment: true,
      },
    });
    if (!program || program.organizationId !== orgId) {
      throw new NotFoundException('Program not found');
    }
    // One level only: a batch can't itself have batches.
    if (program.parentCourseId) {
      throw new BadRequestException(
        'Batches can only be created on a program, not on another batch',
      );
    }
    if (dto.instructorId) await this.assertOrgInstructor(orgId, dto.instructorId);

    const label = dto.label?.trim();
    const title = label ? `${program.title} — ${label}` : program.title;

    // Each schedule field falls back to the program's cadence when omitted.
    const meetingDays =
      dto.meetingDays !== undefined
        ? Array.from(new Set(dto.meetingDays)).sort((a, b) => a - b)
        : program.meetingDays;

    return this.prisma.$transaction(async (tx) => {
      const batch = await tx.course.create({
        data: {
          organizationId: orgId,
          parentCourseId: program.id,
          instructorId: dto.instructorId ?? program.instructorId ?? null,
          title,
          description: program.description,
          posterUrl: program.posterUrl,
          category: program.category,
          level: program.level,
          startDate:
            dto.startDate !== undefined
              ? new Date(dto.startDate)
              : program.startDate,
          durationWeeks: dto.durationWeeks ?? program.durationWeeks,
          meetingDays:
            meetingDays == null
              ? Prisma.DbNull
              : (meetingDays as Prisma.InputJsonValue),
          meetingTime: dto.meetingTime ?? program.meetingTime,
          timezone: dto.timezone ?? program.timezone,
          instantClassAssessment: program.instantClassAssessment,
          scheduleUpdatedAt: new Date(),
        },
      });
      await this.snapshotProgramContent(tx, program.id, batch.id);
      return batch;
    });
  }

  /**
   * Copy a program's authored content into a fresh batch: syllabus sections
   * first (so their ids can be remapped), then the assessment questions and
   * assignment templates that hang off them, then shared documents. Roster- and
   * runtime-scoped rows (enrollments, groups, sessions, points, certificates,
   * hifz/coding-per-student targets) are deliberately NOT copied — a batch
   * starts empty on those.
   */
  private async snapshotProgramContent(
    tx: Prisma.TransactionClient,
    fromCourseId: string,
    toCourseId: string,
  ): Promise<void> {
    // 1) Sections — recreate and remember old→new ids for FK remapping.
    const sections = await tx.section.findMany({
      where: { courseId: fromCourseId },
      orderBy: { order: 'asc' },
    });
    const sectionIdMap = new Map<string, string>();
    for (const s of sections) {
      const copy = await tx.section.create({
        data: {
          courseId: toCourseId,
          order: s.order,
          title: s.title,
          description: s.description,
        },
      });
      sectionIdMap.set(s.id, copy.id);
    }

    // 2) Assessment questions (the post-class quiz bank) — sectionId required.
    const questions = await tx.assessmentQuestion.findMany({
      where: { courseId: fromCourseId, active: true },
    });
    if (questions.length) {
      await tx.assessmentQuestion.createMany({
        data: questions.flatMap((q) => {
          const sectionId = sectionIdMap.get(q.sectionId);
          if (!sectionId) return []; // orphaned section — skip defensively
          return [
            {
              courseId: toCourseId,
              sectionId,
              body: q.body,
              options: q.options as Prisma.InputJsonValue,
              correctIndex: q.correctIndex,
              active: q.active,
              createdById: q.createdById,
            },
          ];
        }),
      });
    }

    // 3) Assignment templates — remap section; drop session/group (runtime/roster).
    const assignments = await tx.assignment.findMany({
      where: { courseId: fromCourseId },
    });
    if (assignments.length) {
      await tx.assignment.createMany({
        data: assignments.map((a) => ({
          courseId: toCourseId,
          sectionId: a.sectionId ? (sectionIdMap.get(a.sectionId) ?? null) : null,
          title: a.title,
          instructions: a.instructions,
          dueAt: a.dueAt,
          maxPoints: a.maxPoints,
          createdById: a.createdById,
        })),
      });
    }

    // 4) Shared documents — same object-store key (read-only reference).
    const docs = await tx.courseDocument.findMany({
      where: { courseId: fromCourseId },
    });
    if (docs.length) {
      await tx.courseDocument.createMany({
        data: docs.map((d) => ({
          courseId: toCourseId,
          filename: d.filename,
          storageKey: d.storageKey,
          mimeType: d.mimeType,
          charCount: d.charCount,
          extractedText: d.extractedText,
          createdById: d.createdById,
        })),
      });
    }
  }

  /** Batches (scheduled instances) of a program, with a light session summary. */
  async listBatches(user: JwtPayload, programId: string) {
    // Scope like getCourseFor: same org, and assigned-instructor only.
    await this.getCourseFor(user, programId);
    const batches = await this.prisma.course.findMany({
      where: { parentCourseId: programId },
      include: {
        instructor: { select: { id: true, name: true } },
        _count: { select: { enrollments: true } },
        sessions: {
          where: {
            status: { in: [SessionStatus.LIVE, SessionStatus.SCHEDULED] },
          },
          select: { id: true, status: true, scheduledAt: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return batches.map(({ sessions, ...c }) => {
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

  /**
   * Hard-delete a program (or batch) and everything under it — a destructive,
   * admin-only action confirmed in the UI by retyping the title. Children are
   * removed in dependency order in one transaction; the relations that already
   * cascade (coding tasks, assessment attempts/responses, group members) are
   * left to the DB. A program that still has batches is refused so the admin
   * makes that call per batch first.
   */
  async deleteCourse(user: JwtPayload, courseId: string) {
    const orgId = this.orgOf(user);
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        organizationId: true,
        _count: { select: { batches: true } },
      },
    });
    if (!course || course.organizationId !== orgId) {
      throw new NotFoundException('Course not found');
    }
    if (course._count.batches > 0) {
      throw new BadRequestException(
        'This program has batches. Delete its batches first, then delete the program.',
      );
    }

    const c = courseId;
    await this.prisma.$transaction(async (tx) => {
      // Coding: requirements, rubric, submissions (+files/reviews/feedback) all
      // cascade from the assignment.
      await tx.codingAssignment.deleteMany({ where: { courseId: c } });

      // Exams: answers → attempts → questions → exam (no cascades).
      await tx.examAnswer.deleteMany({
        where: { attempt: { exam: { courseId: c } } },
      });
      await tx.examAttempt.deleteMany({ where: { exam: { courseId: c } } });
      await tx.examQuestion.deleteMany({ where: { exam: { courseId: c } } });
      await tx.exam.deleteMany({ where: { courseId: c } });

      // Remediation assignments reference assessment attempts (no cascade), so
      // clear them before the assessments cascade those attempts away. They're
      // always assigned from this course's own tasks, so scoping by task covers
      // every attempt this course could delete.
      await tx.assignedRemediation.deleteMany({
        where: { task: { courseId: c } },
      });
      // Assessments cascade their attempts → responses.
      await tx.assessment.deleteMany({ where: { courseId: c } });
      await tx.remediationTask.deleteMany({ where: { courseId: c } });
      await tx.assessmentQuestion.deleteMany({ where: { courseId: c } });

      // Quizzes (course bank + session rounds): answers → questions → quiz.
      const quizWhere: Prisma.QuizWhereInput = {
        OR: [{ courseId: c }, { session: { courseId: c } }],
      };
      await tx.quizAnswer.deleteMany({ where: { question: { quiz: quizWhere } } });
      await tx.quizQuestion.deleteMany({ where: { quiz: quizWhere } });
      await tx.quiz.deleteMany({ where: quizWhere });

      // Assignments: submissions → assignment.
      await tx.submission.deleteMany({ where: { assignment: { courseId: c } } });
      await tx.assignment.deleteMany({ where: { courseId: c } });

      // Groups cascade their members.
      await tx.studentGroup.deleteMany({ where: { courseId: c } });

      await tx.hifzEntry.deleteMany({ where: { courseId: c } });
      await tx.hifzTarget.deleteMany({ where: { courseId: c } });

      // Session-scoped rows before the sessions themselves.
      await tx.attendance.deleteMany({ where: { session: { courseId: c } } });
      await tx.chatMessage.deleteMany({ where: { session: { courseId: c } } });

      await tx.pointsLedger.deleteMany({ where: { courseId: c } });
      await tx.certificate.deleteMany({ where: { courseId: c } });
      await tx.courseDocument.deleteMany({ where: { courseId: c } });
      await tx.enrollment.deleteMany({ where: { courseId: c } });
      await tx.sessionReminder.deleteMany({ where: { courseId: c } });
      await tx.invite.deleteMany({ where: { courseId: c } });
      await tx.section.deleteMany({ where: { courseId: c } });
      await tx.liveSession.deleteMany({ where: { courseId: c } });

      await tx.course.delete({ where: { id: c } });
    });
    return { ok: true };
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
        meetingTimesByDay: true,
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
    meetingTimesByDay?: Record<string, string> | null;
  }) {
    const out: {
      startDate?: Date | null;
      meetingDays?: Prisma.InputJsonValue | typeof Prisma.DbNull;
      meetingTimesByDay?: Prisma.InputJsonValue | typeof Prisma.DbNull;
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
    if (dto.meetingTimesByDay !== undefined) {
      out.meetingTimesByDay = CoursesService.cleanTimesByDay(
        dto.meetingTimesByDay,
      );
    }
    return out;
  }

  /**
   * Sanitize a per-day time map from the client: keep only day keys 0–6 with a
   * valid "HH:mm" value. An empty result (or null) becomes DbNull so the program
   * falls back to a single general time. Never trust the raw object — a bad key
   * or value would otherwise corrupt scheduling for the whole program.
   */
  private static cleanTimesByDay(
    raw: Record<string, string> | null,
  ): Prisma.InputJsonValue | typeof Prisma.DbNull {
    if (!raw || typeof raw !== 'object') return Prisma.DbNull;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      const day = Number(k);
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;
      if (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) {
        clean[String(day)] = v;
      }
    }
    return Object.keys(clean).length ? clean : Prisma.DbNull;
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
    let enrollment;
    try {
      enrollment = await this.prisma.enrollment.create({
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
    // Let the student know they've been added — best-effort, never blocks the
    // enrolment or fails the request if mail is down.
    await this.notifyEnrolled(courseId, studentId).catch(() => {});
    return enrollment;
  }

  /** Email a student that they've been added to a program (best-effort). */
  private async notifyEnrolled(
    courseId: string,
    studentId: string,
  ): Promise<void> {
    const [course, student] = await Promise.all([
      this.prisma.course.findUnique({
        where: { id: courseId },
        select: { title: true },
      }),
      this.prisma.user.findUnique({
        where: { id: studentId },
        select: { name: true, email: true },
      }),
    ]);
    if (!course || !student) return;
    const base = process.env.WEB_URL ?? 'http://localhost:3001';
    await this.mail.sendEnrolledInProgram(
      student.email,
      student.name,
      course.title,
      `${base}/courses/${courseId}`,
    );
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
