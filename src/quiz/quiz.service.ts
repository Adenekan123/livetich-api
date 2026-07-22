import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PointsReason, Prisma, Role } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { PointsService, POINTS_QUIZ_CORRECT } from '../points/points.service';
import { CreateQuizDto } from './dto/create-quiz.dto';

@Injectable()
export class QuizService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly points: PointsService,
  ) {}

  async create(instructorId: string, dto: CreateQuizDto) {
    const courseId = await this.resolveCourseId(dto);
    await this.courses.assertCourseOwner(instructorId, courseId);

    dto.questions.forEach((q, i) => {
      if (q.correctIndex >= q.options.length) {
        throw new BadRequestException(
          `questions[${i}].correctIndex is out of range`,
        );
      }
    });

    return this.prisma.quiz.create({
      data: {
        sectionId: dto.sectionId,
        sessionId: dto.sessionId,
        type: dto.type,
        questions: {
          create: dto.questions.map((q) => ({
            body: q.body,
            options: q.options,
            correctIndex: q.correctIndex,
            ...(q.timeLimitSec !== undefined && {
              timeLimitSec: q.timeLimitSec,
            }),
          })),
        },
      },
      include: { questions: true },
    });
  }

  /** Session quizzes for the owning instructor (drives the buzzer UI). */
  async listForSession(instructorId: string, sessionId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      select: { courseId: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    await this.courses.assertCourseOwner(instructorId, session.courseId);
    return this.prisma.quiz.findMany({
      where: { sessionId },
      include: { questions: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Instructors who own the quiz see correctIndex; students never do. */
  async get(user: JwtPayload, id: string) {
    const quiz = await this.prisma.quiz.findUnique({
      where: { id },
      include: { questions: true },
    });
    if (!quiz) throw new NotFoundException('Quiz not found');

    const courseId = await this.courseIdOf(quiz);
    if (user.role === Role.INSTRUCTOR) {
      await this.courses.assertCourseOwner(user.sub, courseId);
      return quiz;
    }

    await this.assertEnrolled(user.sub, courseId);
    return {
      ...quiz,
      questions: quiz.questions.map(({ correctIndex: _, ...q }) => q),
    };
  }

  /**
   * Answer a question. Server receipt time is recorded by the DB default
   * (DATETIME(3)); correct answers award points in the same transaction.
   * NOTE: open/close timing enforcement arrives with the realtime gateway —
   * REST answering is meant for self-paced section quizzes.
   */
  async answer(user: JwtPayload, questionId: string, answerIndex: number) {
    const question = await this.prisma.quizQuestion.findUnique({
      where: { id: questionId },
      include: { quiz: true },
    });
    if (!question) throw new NotFoundException('Question not found');

    const options = question.options as string[];
    if (answerIndex >= options.length) {
      throw new BadRequestException('answerIndex is out of range');
    }

    const courseId = await this.courseIdOf(question.quiz);
    await this.assertEnrolled(user.sub, courseId);

    const isCorrect = answerIndex === question.correctIndex;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.quizAnswer.create({
          data: { questionId, studentId: user.sub, answerIndex, isCorrect },
        });
        if (isCorrect) {
          await this.points.award(
            {
              studentId: user.sub,
              courseId,
              delta: POINTS_QUIZ_CORRECT,
              reason: PointsReason.QUIZ_CORRECT,
              refId: questionId,
            },
            tx,
          );
        }
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Already answered');
      }
      throw e;
    }

    return {
      isCorrect,
      pointsAwarded: isCorrect ? POINTS_QUIZ_CORRECT : 0,
    };
  }

  /** Per-question stats for the owning instructor. */
  async results(instructorId: string, quizId: string) {
    const quiz = await this.prisma.quiz.findUnique({
      where: { id: quizId },
      include: {
        questions: {
          include: {
            answers: {
              include: { student: { select: { id: true, name: true } } },
              orderBy: { receivedAt: 'asc' },
            },
          },
        },
      },
    });
    if (!quiz) throw new NotFoundException('Quiz not found');
    await this.courses.assertCourseOwner(
      instructorId,
      await this.courseIdOf(quiz),
    );

    return quiz.questions.map((q) => ({
      questionId: q.id,
      body: q.body,
      correctIndex: q.correctIndex,
      totalAnswers: q.answers.length,
      correctCount: q.answers.filter((a) => a.isCorrect).length,
      answers: q.answers.map((a) => ({
        student: a.student,
        answerIndex: a.answerIndex,
        isCorrect: a.isCorrect,
        receivedAt: a.receivedAt,
      })),
    }));
  }

  // ---------- Helpers ----------

  private async resolveCourseId(dto: CreateQuizDto): Promise<string> {
    if (!dto.sectionId && !dto.sessionId) {
      throw new BadRequestException('sectionId or sessionId is required');
    }
    let fromSection: string | undefined;
    let fromSession: string | undefined;

    if (dto.sectionId) {
      const section = await this.prisma.section.findUnique({
        where: { id: dto.sectionId },
        select: { courseId: true },
      });
      if (!section) throw new NotFoundException('Section not found');
      fromSection = section.courseId;
    }
    if (dto.sessionId) {
      const session = await this.prisma.liveSession.findUnique({
        where: { id: dto.sessionId },
        select: { courseId: true },
      });
      if (!session) throw new NotFoundException('Session not found');
      fromSession = session.courseId;
    }
    if (fromSection && fromSession && fromSection !== fromSession) {
      throw new BadRequestException(
        'Section and session belong to different courses',
      );
    }
    return (fromSection ?? fromSession)!;
  }

  private async courseIdOf(quiz: {
    sectionId: string | null;
    sessionId: string | null;
  }): Promise<string> {
    if (quiz.sectionId) {
      const s = await this.prisma.section.findUnique({
        where: { id: quiz.sectionId },
        select: { courseId: true },
      });
      if (s) return s.courseId;
    }
    if (quiz.sessionId) {
      const s = await this.prisma.liveSession.findUnique({
        where: { id: quiz.sessionId },
        select: { courseId: true },
      });
      if (s) return s.courseId;
    }
    throw new NotFoundException('Quiz has no resolvable course');
  }

  private async assertEnrolled(studentId: string, courseId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId, studentId } },
      select: { id: true },
    });
    if (!enrollment) throw new ForbiddenException('Not enrolled');
  }
}
