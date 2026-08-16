import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExamDto } from './dto/create-exam.dto';
import { SubmitExamDto } from './dto/submit-exam.dto';

@Injectable()
export class ExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
  ) {}

  // ------------------------- Authoring (manager) -------------------------

  async createExam(user: JwtPayload, courseId: string, dto: CreateExamDto) {
    await this.courses.assertCanManageCourse(user, courseId);
    dto.questions.forEach((q, i) => {
      if (q.correctIndex >= q.options.length) {
        throw new BadRequestException(
          `Question ${i + 1}: correctIndex is out of range`,
        );
      }
    });
    return this.prisma.exam.create({
      data: {
        courseId,
        title: dto.title,
        durationMinutes: dto.durationMinutes,
        createdById: user.sub,
        questions: {
          create: dto.questions.map((q, i) => ({
            body: q.body,
            options: q.options,
            correctIndex: q.correctIndex,
            topic: q.topic ?? null,
            order: i,
          })),
        },
      },
      select: { id: true, title: true, durationMinutes: true },
    });
  }

  /** Manager list: each exam with its question count + attempt stats. */
  async listExams(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    const exams = await this.prisma.exam.findMany({
      where: { courseId, active: true },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { questions: true } },
        attempts: { where: { submittedAt: { not: null } }, select: { score: true } },
      },
    });
    return exams.map((e) => {
      const scores = e.attempts.map((a) => a.score ?? 0);
      const avg = scores.length
        ? Math.round(scores.reduce((s, n) => s + n, 0) / scores.length)
        : null;
      return {
        id: e.id,
        title: e.title,
        durationMinutes: e.durationMinutes,
        questionCount: e._count.questions,
        submissions: scores.length,
        averageScore: avg,
      };
    });
  }

  /** Manager analytics: per-student scores + per-topic accuracy. */
  async results(user: JwtPayload, examId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        questions: { select: { id: true, correctIndex: true, topic: true } },
      },
    });
    if (!exam) throw new NotFoundException('Exam not found');
    await this.courses.assertCanManageCourse(user, exam.courseId);

    const correctById = new Map(exam.questions.map((q) => [q.id, q.correctIndex]));
    const topicById = new Map(exam.questions.map((q) => [q.id, q.topic ?? 'General']));

    const attempts = await this.prisma.examAttempt.findMany({
      where: { examId, submittedAt: { not: null } },
      include: {
        student: { select: { id: true, name: true } },
        answers: true,
      },
      orderBy: { submittedAt: 'desc' },
    });

    const topics = new Map<string, { correct: number; total: number }>();
    for (const q of exam.questions) {
      const t = q.topic ?? 'General';
      if (!topics.has(t)) topics.set(t, { correct: 0, total: 0 });
    }
    for (const a of attempts) {
      for (const ans of a.answers) {
        const topic = topicById.get(ans.questionId);
        if (!topic) continue; // answer to a since-removed question
        const bucket = topics.get(topic)!;
        bucket.total += 1;
        if (correctById.get(ans.questionId) === ans.chosenIndex) bucket.correct += 1;
      }
    }

    return {
      examTitle: exam.title,
      students: attempts.map((a) => ({
        studentId: a.student.id,
        name: a.student.name,
        score: a.score,
        submittedAt: a.submittedAt,
      })),
      topics: [...topics.entries()].map(([topic, b]) => ({
        topic,
        accuracy: b.total ? Math.round((b.correct / b.total) * 100) : null,
        answered: b.total,
      })),
    };
  }

  // --------------------------- Student-facing ---------------------------

  /** Exams the enrolled student can sit, with their latest attempt (if any). */
  async listAvailable(user: JwtPayload, courseId: string) {
    await this.assertEnrolled(user, courseId);
    const exams = await this.prisma.exam.findMany({
      where: { courseId, active: true },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { questions: true } },
        attempts: {
          where: { studentId: user.sub },
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { id: true, score: true, submittedAt: true },
        },
      },
    });
    return exams.map((e) => {
      const attempt = e.attempts[0] ?? null;
      return {
        id: e.id,
        title: e.title,
        durationMinutes: e.durationMinutes,
        questionCount: e._count.questions,
        myAttempt: attempt
          ? {
              id: attempt.id,
              score: attempt.score,
              submitted: attempt.submittedAt != null,
            }
          : null,
      };
    });
  }

  /** Begin (or resume) a timed attempt. Returns questions WITHOUT answers. */
  async startAttempt(user: JwtPayload, examId: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
      include: {
        questions: {
          orderBy: { order: 'asc' },
          select: { id: true, body: true, options: true, topic: true },
        },
      },
    });
    if (!exam || !exam.active) throw new NotFoundException('Exam not found');
    await this.assertEnrolled(user, exam.courseId);

    // Resume an unsubmitted attempt rather than spawning duplicates.
    let attempt = await this.prisma.examAttempt.findFirst({
      where: { examId, studentId: user.sub, submittedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    attempt ??= await this.prisma.examAttempt.create({
      data: { examId, studentId: user.sub },
    });

    const deadline = new Date(
      attempt.startedAt.getTime() + exam.durationMinutes * 60_000,
    );
    return {
      attemptId: attempt.id,
      title: exam.title,
      durationMinutes: exam.durationMinutes,
      deadline: deadline.toISOString(),
      questions: exam.questions, // options included; correctIndex is NOT
    };
  }

  /** Score a submitted attempt. Auto-scores whatever was answered. */
  async submit(user: JwtPayload, attemptId: string, dto: SubmitExamDto) {
    const attempt = await this.prisma.examAttempt.findUnique({
      where: { id: attemptId },
      include: {
        exam: {
          include: {
            questions: { select: { id: true, correctIndex: true } },
          },
        },
      },
    });
    if (!attempt) throw new NotFoundException('Attempt not found');
    if (attempt.studentId !== user.sub) {
      throw new ForbiddenException('Not your attempt');
    }
    if (attempt.submittedAt) {
      throw new BadRequestException('Attempt already submitted');
    }

    const correctById = new Map(
      attempt.exam.questions.map((q) => [q.id, q.correctIndex]),
    );
    // Keep only answers to real questions; last write wins on duplicates.
    const chosen = new Map<string, number>();
    for (const a of dto.answers) {
      if (correctById.has(a.questionId)) chosen.set(a.questionId, a.chosenIndex);
    }

    const total = attempt.exam.questions.length;
    let correct = 0;
    for (const [qid, idx] of chosen) {
      if (correctById.get(qid) === idx) correct += 1;
    }
    const score = total ? Math.round((correct / total) * 100) : 0;

    await this.prisma.$transaction([
      this.prisma.examAnswer.deleteMany({ where: { attemptId } }),
      this.prisma.examAnswer.createMany({
        data: [...chosen].map(([questionId, chosenIndex]) => ({
          attemptId,
          questionId,
          chosenIndex,
        })),
      }),
      this.prisma.examAttempt.update({
        where: { id: attemptId },
        data: { submittedAt: new Date(), score },
      }),
    ]);

    return { score, correct, total, answered: chosen.size };
  }

  // ------------------------------ helpers ------------------------------

  private async assertEnrolled(user: JwtPayload, courseId: string) {
    if (user.role !== Role.STUDENT) {
      // Instructors/admins reach exams through the manager endpoints.
      await this.courses.assertCanManageCourse(user, courseId);
      return;
    }
    const enrolled = await this.prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId, studentId: user.sub } },
      select: { courseId: true },
    });
    if (!enrolled) throw new ForbiddenException('Not enrolled in this course');
  }
}
