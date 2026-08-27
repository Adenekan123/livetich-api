import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CodingAssignmentStatus, Prisma, Role } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCodingAssignmentDto } from './dto/create-coding-assignment.dto';
import { UpdateCodingAssignmentDto } from './dto/update-coding-assignment.dto';

/**
 * Coding Instructor Plugin — authoring & delivery of rich coding assignments.
 * Submissions, AI review and the instructor dashboard build on top of this in
 * their own services; this one owns the assignment + requirements + rubric.
 */
@Injectable()
export class CodingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
  ) {}

  /** Assigned instructor or org admin authors a coding assignment. */
  async create(
    user: JwtPayload,
    courseId: string,
    dto: CreateCodingAssignmentDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    if (dto.sessionId) await this.assertSessionInCourse(dto.sessionId, courseId);

    return this.prisma.codingAssignment.create({
      data: {
        courseId,
        sessionId: dto.sessionId ?? null,
        createdById: user.sub,
        title: dto.title,
        description: dto.description ?? null,
        language: dto.language ?? null,
        framework: dto.framework ?? null,
        difficulty: dto.difficulty ?? null,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        timeLimitSec: dto.timeLimitSec ?? null,
        ...scalarDefaults(dto),
        requirements: {
          create: dto.requirements.map((r, i) => ({
            order: i,
            text: r.text,
            mandatory: r.mandatory ?? false,
          })),
        },
        rubric: dto.rubric?.length
          ? {
              create: dto.rubric.map((r, i) => ({
                order: i,
                criterion: r.criterion,
                weight: r.weight,
                mandatory: r.mandatory ?? false,
                aiInstructions: r.aiInstructions ?? null,
              })),
            }
          : undefined,
      },
      include: fullInclude,
    });
  }

  /** Patch scalar fields; replace requirements/rubric wholesale when supplied. */
  async update(
    user: JwtPayload,
    id: string,
    dto: UpdateCodingAssignmentDto,
  ) {
    await this.getManageable(user, id);

    const data: Prisma.CodingAssignmentUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.language !== undefined) data.language = dto.language;
    if (dto.framework !== undefined) data.framework = dto.framework;
    if (dto.difficulty !== undefined) data.difficulty = dto.difficulty;
    if (dto.dueAt !== undefined) data.dueAt = dto.dueAt ? new Date(dto.dueAt) : null;
    if (dto.timeLimitSec !== undefined) data.timeLimitSec = dto.timeLimitSec;
    if (dto.maxAttempts !== undefined) data.maxAttempts = dto.maxAttempts;
    if (dto.allowResubmit !== undefined) data.allowResubmit = dto.allowResubmit;
    if (dto.keepHighest !== undefined) data.keepHighest = dto.keepHighest;
    if (dto.passingScore !== undefined) data.passingScore = dto.passingScore;
    if (dto.aiAutoReview !== undefined) data.aiAutoReview = dto.aiAutoReview;
    if (dto.showAiToStudents !== undefined) {
      data.showAiToStudents = dto.showAiToStudents;
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.requirements) {
        await tx.codingRequirement.deleteMany({ where: { assignmentId: id } });
        data.requirements = {
          create: dto.requirements.map((r, i) => ({
            order: i,
            text: r.text,
            mandatory: r.mandatory ?? false,
          })),
        };
      }
      if (dto.rubric) {
        await tx.codingRubricItem.deleteMany({ where: { assignmentId: id } });
        data.rubric = {
          create: dto.rubric.map((r, i) => ({
            order: i,
            criterion: r.criterion,
            weight: r.weight,
            mandatory: r.mandatory ?? false,
            aiInstructions: r.aiInstructions ?? null,
          })),
        };
      }
      return tx.codingAssignment.update({
        where: { id },
        data,
        include: fullInclude,
      });
    });
  }

  /** Every coding assignment in a course (managers only). */
  async listForCourse(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    return this.prisma.codingAssignment.findMany({
      where: { courseId },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        session: { select: { id: true, status: true } },
        _count: { select: { requirements: true, submissions: true } },
      },
    });
  }

  /** Full detail — managers see everything; enrolled students see the task plus
   *  their own attempts (never anyone else's). */
  async get(user: JwtPayload, id: string) {
    const assignment = await this.prisma.codingAssignment.findUnique({
      where: { id },
      include: fullInclude,
    });
    if (!assignment) throw new NotFoundException('Assignment not found');

    if (user.role !== Role.STUDENT) {
      await this.courses.assertCanManageCourse(user, assignment.courseId);
      return assignment;
    }

    await this.assertEnrolled(user.sub, assignment.courseId);
    const mySubmissions = await this.prisma.codingSubmission.findMany({
      where: { assignmentId: id, studentId: user.sub },
      orderBy: { attemptNumber: 'asc' },
      include: {
        reviews: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { findings: true, results: true },
        },
        feedback: {
          where: { visibleToStudent: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    return { ...assignment, mySubmissions };
  }

  /** The signed-in student's coding assignments across enrolled courses, with
   *  their latest attempt status. Powers the VS Code plugin's assignment list. */
  async mine(user: JwtPayload) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId: user.sub },
      select: { courseId: true },
    });
    const courseIds = enrollments.map((e) => e.courseId);
    if (courseIds.length === 0) return [];

    const assignments = await this.prisma.codingAssignment.findMany({
      where: { courseId: { in: courseIds }, status: { not: 'DRAFT' } },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        course: { select: { title: true } },
        session: { select: { id: true, status: true } },
        submissions: {
          where: { studentId: user.sub },
          orderBy: { attemptNumber: 'desc' },
          take: 1,
          select: {
            id: true,
            attemptNumber: true,
            status: true,
            finalScore: true,
            provisionalScore: true,
          },
        },
        _count: { select: { requirements: true } },
      },
    });

    return assignments.map((a) => ({
      id: a.id,
      title: a.title,
      language: a.language,
      framework: a.framework,
      difficulty: a.difficulty,
      courseId: a.courseId,
      courseTitle: a.course.title,
      sessionId: a.sessionId,
      sessionLive: a.session?.status === 'LIVE',
      status: a.status,
      dueAt: a.dueAt,
      requirementCount: a._count.requirements,
      maxAttempts: a.maxAttempts,
      allowResubmit: a.allowResubmit,
      latestSubmission: a.submissions[0] ?? null,
    }));
  }

  /** Launch a task live ("Practice now") — moves it to LIVE and (optionally)
   *  binds it to the session it was launched from. */
  async launch(user: JwtPayload, id: string, sessionId?: string) {
    const assignment = await this.getManageable(user, id);
    if (sessionId) {
      await this.assertSessionInCourse(sessionId, assignment.courseId);
    }
    return this.prisma.codingAssignment.update({
      where: { id },
      data: {
        status: CodingAssignmentStatus.LIVE,
        sessionId: sessionId ?? assignment.sessionId,
      },
      include: fullInclude,
    });
  }

  /** Close a task — no further submissions accepted. */
  async close(user: JwtPayload, id: string) {
    await this.getManageable(user, id);
    return this.prisma.codingAssignment.update({
      where: { id },
      data: { status: CodingAssignmentStatus.CLOSED },
    });
  }

  // ---------- Helpers ----------

  /** Loads an assignment and asserts the caller can manage its course. */
  async getManageable(user: JwtPayload, id: string) {
    const assignment = await this.prisma.codingAssignment.findUnique({
      where: { id },
      select: { id: true, courseId: true, sessionId: true, status: true },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    await this.courses.assertCanManageCourse(user, assignment.courseId);
    return assignment;
  }

  private async assertSessionInCourse(sessionId: string, courseId: string) {
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, courseId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('Session not found in course');
  }

  private async assertEnrolled(studentId: string, courseId: string) {
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId, studentId } },
      select: { id: true },
    });
    if (!enrolled) throw new ForbiddenException('Not enrolled in this program');
  }
}

/** Boolean/score fields with their defaults, applied only when the DTO omits
 *  them so the schema defaults still govern an unspecified create. */
function scalarDefaults(dto: CreateCodingAssignmentDto) {
  const out: Record<string, unknown> = {};
  if (dto.maxAttempts !== undefined) out.maxAttempts = dto.maxAttempts;
  if (dto.allowResubmit !== undefined) out.allowResubmit = dto.allowResubmit;
  if (dto.keepHighest !== undefined) out.keepHighest = dto.keepHighest;
  if (dto.passingScore !== undefined) out.passingScore = dto.passingScore;
  if (dto.aiAutoReview !== undefined) out.aiAutoReview = dto.aiAutoReview;
  if (dto.showAiToStudents !== undefined) {
    out.showAiToStudents = dto.showAiToStudents;
  }
  return out;
}

const fullInclude = {
  requirements: { orderBy: { order: 'asc' } },
  rubric: { orderBy: { order: 'asc' } },
} satisfies Prisma.CodingAssignmentInclude;
