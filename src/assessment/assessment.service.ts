import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PointsReason, Prisma, Role, RemediationStatus } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PointsService,
  POINTS_QUIZ_CORRECT,
} from '../points/points.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { UpdateQuestionDto } from './dto/update-question.dto';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';

/** Max questions pulled into a single class-end assessment. */
const MAX_QUESTIONS = 20;

@Injectable()
export class AssessmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly points: PointsService,
  ) {}

  // ======================= Authoring: question bank =======================

  async listQuestions(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    return this.prisma.assessmentQuestion.findMany({
      where: { courseId, active: true },
      orderBy: [{ sectionId: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createQuestion(
    user: JwtPayload,
    courseId: string,
    dto: CreateQuestionDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertSectionInCourse(dto.sectionId, courseId);
    this.assertCorrectIndex(dto.correctIndex, dto.options);
    return this.prisma.assessmentQuestion.create({
      data: {
        courseId,
        sectionId: dto.sectionId,
        body: dto.body,
        options: dto.options,
        correctIndex: dto.correctIndex,
        createdById: user.sub,
      },
    });
  }

  async updateQuestion(
    user: JwtPayload,
    courseId: string,
    questionId: string,
    dto: UpdateQuestionDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    const question = await this.prisma.assessmentQuestion.findFirst({
      where: { id: questionId, courseId },
    });
    if (!question) throw new NotFoundException('Question not found');
    const options = dto.options ?? (question.options as string[]);
    const correctIndex = dto.correctIndex ?? question.correctIndex;
    this.assertCorrectIndex(correctIndex, options);
    return this.prisma.assessmentQuestion.update({
      where: { id: questionId },
      data: {
        body: dto.body,
        options: dto.options,
        correctIndex: dto.correctIndex,
        active: dto.active,
      },
    });
  }

  /** Soft-delete — the row may be referenced by past assessments. */
  async deleteQuestion(user: JwtPayload, courseId: string, questionId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    const question = await this.prisma.assessmentQuestion.findFirst({
      where: { id: questionId, courseId },
      select: { id: true },
    });
    if (!question) throw new NotFoundException('Question not found');
    await this.prisma.assessmentQuestion.update({
      where: { id: questionId },
      data: { active: false },
    });
    return { deleted: true };
  }

  /** Save a reviewed batch of questions (e.g. accepted AI drafts) into a section. */
  async createQuestionsBatch(
    user: JwtPayload,
    courseId: string,
    sectionId: string,
    items: { body: string; options: string[]; correctIndex: number }[],
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertSectionInCourse(sectionId, courseId);
    for (const q of items) this.assertCorrectIndex(q.correctIndex, q.options);
    const result = await this.prisma.assessmentQuestion.createMany({
      data: items.map((q) => ({
        courseId,
        sectionId,
        body: q.body,
        options: q.options,
        correctIndex: q.correctIndex,
        createdById: user.sub,
      })),
    });
    return { created: result.count };
  }

  // ==================== Authoring: remediation task bank ====================

  async listTasks(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    return this.prisma.remediationTask.findMany({
      where: { courseId, active: true },
      orderBy: [{ sectionId: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createTask(user: JwtPayload, courseId: string, dto: CreateTaskDto) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertSectionInCourse(dto.sectionId, courseId);
    return this.prisma.remediationTask.create({
      data: {
        courseId,
        sectionId: dto.sectionId,
        title: dto.title,
        instructions: dto.instructions,
        createdById: user.sub,
      },
    });
  }

  /** Save a reviewed batch of remediation tasks (e.g. accepted AI drafts). */
  async createTasksBatch(
    user: JwtPayload,
    courseId: string,
    sectionId: string,
    items: { title: string; instructions?: string }[],
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertSectionInCourse(sectionId, courseId);
    const result = await this.prisma.remediationTask.createMany({
      data: items.map((t) => ({
        courseId,
        sectionId,
        title: t.title,
        instructions: t.instructions,
        createdById: user.sub,
      })),
    });
    return { created: result.count };
  }

  async updateTask(
    user: JwtPayload,
    courseId: string,
    taskId: string,
    dto: UpdateTaskDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    const task = await this.prisma.remediationTask.findFirst({
      where: { id: taskId, courseId },
      select: { id: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    return this.prisma.remediationTask.update({
      where: { id: taskId },
      data: {
        title: dto.title,
        instructions: dto.instructions,
        active: dto.active,
      },
    });
  }

  async deleteTask(user: JwtPayload, courseId: string, taskId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    const task = await this.prisma.remediationTask.findFirst({
      where: { id: taskId, courseId },
      select: { id: true },
    });
    if (!task) throw new NotFoundException('Task not found');
    await this.prisma.remediationTask.update({
      where: { id: taskId },
      data: { active: false },
    });
    return { deleted: true };
  }

  // ========================= Runtime: creation ============================

  /**
   * Materialise the class-end assessment for an ended session. Freezes the
   * active questions for the session's topic (or the whole course if the
   * session had no section). Best-effort: returns null when there's no bank yet
   * or one already exists. Called fire-and-forget from SessionsService.end.
   */
  async createForSession(session: {
    id: string;
    courseId: string;
    sectionId: string | null;
  }): Promise<{ id: string } | null> {
    const existing = await this.prisma.assessment.findUnique({
      where: { sessionId: session.id },
      select: { id: true },
    });
    if (existing) return existing;

    const questions = await this.prisma.assessmentQuestion.findMany({
      where: {
        courseId: session.courseId,
        active: true,
        ...(session.sectionId ? { sectionId: session.sectionId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_QUESTIONS,
      select: { id: true },
    });
    if (questions.length === 0) return null;

    return this.prisma.assessment.create({
      data: {
        courseId: session.courseId,
        sessionId: session.id,
        sectionId: session.sectionId,
        questionIds: questions.map((q) => q.id),
      },
      select: { id: true },
    });
  }

  // ===================== Runtime: student take + grade =====================

  /** Assessments in a course the student can take, with their attempt status. */
  async listMine(user: JwtPayload, courseId: string) {
    await this.assertEnrolled(user.sub, courseId);
    const assessments = await this.prisma.assessment.findMany({
      where: { courseId },
      orderBy: { createdAt: 'desc' },
      include: {
        attempts: { where: { studentId: user.sub } },
        session: { select: { section: { select: { title: true } } } },
      },
    });
    return assessments.map((a) => {
      const mine = a.attempts[0];
      return {
        id: a.id,
        createdAt: a.createdAt,
        topic: a.session.section?.title ?? null,
        questionCount: this.questionIds(a.questionIds).length,
        attempt: mine
          ? {
              submittedAt: mine.submittedAt,
              score: mine.score,
              total: mine.total,
            }
          : null,
      };
    });
  }

  /** The questions to answer (correct answers stripped) or the graded result. */
  async getForStudent(user: JwtPayload, assessmentId: string) {
    const assessment = await this.prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        attempts: { where: { studentId: user.sub } },
        session: { select: { section: { select: { title: true } } } },
      },
    });
    if (!assessment) throw new NotFoundException('Assessment not found');
    await this.assertEnrolled(user.sub, assessment.courseId);

    const ids = this.questionIds(assessment.questionIds);
    const questions = await this.prisma.assessmentQuestion.findMany({
      where: { id: { in: ids } },
    });
    const ordered = ids
      .map((id) => questions.find((q) => q.id === id))
      .filter((q): q is (typeof questions)[number] => Boolean(q));

    const mine = assessment.attempts[0];
    const submitted = mine?.submittedAt != null;

    // Once submitted, reveal correctness; otherwise hide the answer key.
    const responses = submitted
      ? await this.prisma.assessmentResponse.findMany({
          where: { attemptId: mine.id },
        })
      : [];
    const byQuestion = new Map(responses.map((r) => [r.questionId, r]));

    return {
      id: assessment.id,
      topic: assessment.session.section?.title ?? null,
      submitted,
      score: mine?.score ?? null,
      total: mine?.total ?? null,
      questions: ordered.map((q) => ({
        id: q.id,
        body: q.body,
        options: q.options as string[],
        ...(submitted
          ? {
              correctIndex: q.correctIndex,
              myAnswerIndex: byQuestion.get(q.id)?.answerIndex ?? null,
            }
          : {}),
      })),
    };
  }

  /**
   * Grade an attempt deterministically and route remediation: any Section the
   * student answered wrong assigns that Section's active remediation tasks.
   */
  async submit(user: JwtPayload, assessmentId: string, dto: SubmitAttemptDto) {
    const assessment = await this.prisma.assessment.findUnique({
      where: { id: assessmentId },
    });
    if (!assessment) throw new NotFoundException('Assessment not found');
    await this.assertEnrolled(user.sub, assessment.courseId);

    const existing = await this.prisma.assessmentAttempt.findUnique({
      where: {
        assessmentId_studentId: { assessmentId, studentId: user.sub },
      },
      select: { submittedAt: true },
    });
    if (existing?.submittedAt) {
      throw new ForbiddenException(
        'You have already submitted this assessment',
      );
    }

    const ids = this.questionIds(assessment.questionIds);
    const questions = await this.prisma.assessmentQuestion.findMany({
      where: { id: { in: ids } },
      select: { id: true, sectionId: true, correctIndex: true },
    });
    const qById = new Map(questions.map((q) => [q.id, q]));

    // Grade only answers that belong to this assessment; last write wins.
    const answerByQuestion = new Map<string, number>();
    for (const a of dto.answers) {
      if (qById.has(a.questionId))
        answerByQuestion.set(a.questionId, a.answerIndex);
    }

    const responses: {
      questionId: string;
      answerIndex: number;
      isCorrect: boolean;
    }[] = [];
    const wrongSections = new Set<string>();
    let score = 0;
    for (const q of questions) {
      const answerIndex = answerByQuestion.get(q.id);
      if (answerIndex === undefined) {
        wrongSections.add(q.sectionId); // unanswered → topic not mastered
        continue;
      }
      const isCorrect = answerIndex === q.correctIndex;
      if (isCorrect) score += 1;
      else wrongSections.add(q.sectionId);
      responses.push({ questionId: q.id, answerIndex, isCorrect });
    }

    const attempt = await this.prisma.$transaction(async (tx) => {
      const created = await tx.assessmentAttempt.upsert({
        where: {
          assessmentId_studentId: { assessmentId, studentId: user.sub },
        },
        create: {
          assessmentId,
          studentId: user.sub,
          submittedAt: new Date(),
          score,
          total: questions.length,
        },
        update: { submittedAt: new Date(), score, total: questions.length },
      });
      if (responses.length) {
        await tx.assessmentResponse.createMany({
          data: responses.map((r) => ({ ...r, attemptId: created.id })),
        });
      }
      // Award points for correct answers, in the same transaction so the grade
      // and the ledger land together. Assessments submit once (resubmission is
      // blocked above), so this never double-awards.
      if (score > 0) {
        await this.points.award(
          {
            studentId: user.sub,
            courseId: assessment.courseId,
            delta: score * POINTS_QUIZ_CORRECT,
            reason: PointsReason.QUIZ_CORRECT,
            refId: created.id,
          },
          tx,
        );
      }
      return created;
    });

    const assigned = await this.routeRemediation(
      assessment.courseId,
      user.sub,
      attempt.id,
      [...wrongSections],
    );

    return {
      score,
      total: questions.length,
      assignedRemediation: assigned,
    };
  }

  /** For each missed section, assign its active remediation tasks (deduped). */
  private async routeRemediation(
    courseId: string,
    studentId: string,
    attemptId: string,
    sectionIds: string[],
  ) {
    if (sectionIds.length === 0) return [];
    const tasks = await this.prisma.remediationTask.findMany({
      where: { courseId, active: true, sectionId: { in: sectionIds } },
      select: { id: true, sectionId: true, title: true },
    });
    if (tasks.length === 0) return [];
    await this.prisma.assignedRemediation.createMany({
      data: tasks.map((t) => ({
        studentId,
        taskId: t.id,
        attemptId,
        sectionId: t.sectionId,
      })),
      skipDuplicates: true,
    });
    return tasks.map((t) => ({ id: t.id, title: t.title }));
  }

  // ======================== Runtime: remediation ==========================

  async listMyRemediation(user: JwtPayload, courseId: string) {
    await this.assertEnrolled(user.sub, courseId);
    return this.prisma.assignedRemediation.findMany({
      where: { studentId: user.sub, task: { courseId } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        task: {
          select: {
            id: true,
            title: true,
            instructions: true,
            section: { select: { id: true, title: true } },
          },
        },
      },
    });
  }

  async markRemediationDone(user: JwtPayload, remediationId: string) {
    const row = await this.prisma.assignedRemediation.findUnique({
      where: { id: remediationId },
      select: { id: true, studentId: true },
    });
    if (!row || row.studentId !== user.sub) {
      throw new NotFoundException('Remediation not found');
    }
    return this.prisma.assignedRemediation.update({
      where: { id: remediationId },
      data: { status: RemediationStatus.DONE, completedAt: new Date() },
    });
  }

  // ========================== Manager: results ============================

  async results(user: JwtPayload, assessmentId: string) {
    const assessment = await this.prisma.assessment.findUnique({
      where: { id: assessmentId },
      include: {
        session: { select: { section: { select: { title: true } } } },
      },
    });
    if (!assessment) throw new NotFoundException('Assessment not found');
    await this.courses.assertCanManageCourse(user, assessment.courseId);

    const [attempts, enrolledCount] = await Promise.all([
      this.prisma.assessmentAttempt.findMany({
        where: { assessmentId, submittedAt: { not: null } },
        include: { student: { select: { id: true, name: true, email: true } } },
        orderBy: { submittedAt: 'desc' },
      }),
      this.prisma.enrollment.count({
        where: { courseId: assessment.courseId },
      }),
    ]);

    return {
      id: assessment.id,
      topic: assessment.session.section?.title ?? null,
      questionCount: this.questionIds(assessment.questionIds).length,
      enrolledCount,
      attempts: attempts.map((a) => ({
        student: a.student,
        score: a.score,
        total: a.total,
        submittedAt: a.submittedAt,
      })),
    };
  }

  // ============================== Helpers =================================

  private questionIds(json: Prisma.JsonValue): string[] {
    return Array.isArray(json) ? (json as string[]) : [];
  }

  private assertCorrectIndex(index: number, options: string[]) {
    if (index >= options.length) {
      throw new BadRequestException('correctIndex is out of range for options');
    }
  }

  private async assertSectionInCourse(sectionId: string, courseId: string) {
    const section = await this.prisma.section.findFirst({
      where: { id: sectionId, courseId },
      select: { id: true },
    });
    if (!section) throw new NotFoundException('Section not found in course');
  }

  private async assertEnrolled(studentId: string, courseId: string) {
    // Managers can preview too; students must be enrolled.
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId, studentId } },
      select: { id: true },
    });
    if (!enrolled) throw new ForbiddenException('Not enrolled in this program');
  }

  /** Access guard for a student-facing course id (kept for symmetry/use). */
  async assertCourseAccess(user: JwtPayload, courseId: string) {
    if (user.role === Role.STUDENT)
      return this.assertEnrolled(user.sub, courseId);
    return this.courses.assertCanManageCourse(user, courseId);
  }
}
