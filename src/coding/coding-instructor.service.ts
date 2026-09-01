import { Injectable, NotFoundException } from '@nestjs/common';
import { CodingSubmissionStatus, CodingVerdict } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { CodingLiveService } from './coding-live.service';
import { CreateFeedbackDto } from './dto/feedback.dto';
import { DecisionDto, DecisionKind } from './dto/decision.dto';

/** Statuses that still need the instructor's eyes (vs. finalised pass/fail). */
const AWAITING = new Set<CodingSubmissionStatus>([
  CodingSubmissionStatus.SUBMITTED,
  CodingSubmissionStatus.UNDER_REVIEW,
  CodingSubmissionStatus.AI_REVIEWED,
  CodingSubmissionStatus.NEEDS_REVIEW,
]);

/**
 * Coding Instructor Plugin — the manager side: the submissions dashboard, plus
 * feedback and the final decision (which always overrides the AI, per spec §15).
 */
@Injectable()
export class CodingInstructorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly live: CodingLiveService,
  ) {}

  /**
   * The dashboard for one assignment: the enrolled roster reduced to each
   * student's latest attempt, plus headline counts for the filter chips.
   */
  async dashboard(user: JwtPayload, assignmentId: string) {
    const assignment = await this.prisma.codingAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        courseId: true,
        title: true,
        passingScore: true,
        status: true,
      },
    });
    if (!assignment) throw new NotFoundException('Assignment not found');
    await this.courses.assertCanManageCourse(user, assignment.courseId);

    const studentSelect = { id: true, name: true, email: true } as const;
    const [enrollments, submissions] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { courseId: assignment.courseId },
        select: { student: { select: studentSelect } },
        orderBy: { student: { name: 'asc' } },
      }),
      this.prisma.codingSubmission.findMany({
        where: { assignmentId },
        orderBy: { attemptNumber: 'desc' },
        include: {
          student: { select: studentSelect },
          reviews: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { confidence: true, score: true, status: true },
          },
          _count: { select: { feedback: true } },
        },
      }),
    ]);

    // Reduce to each student's latest attempt (submissions are attempt-desc).
    const latestByStudent = new Map<string, (typeof submissions)[number]>();
    const attemptsByStudent = new Map<string, number>();
    for (const s of submissions) {
      attemptsByStudent.set(
        s.studentId,
        (attemptsByStudent.get(s.studentId) ?? 0) + 1,
      );
      if (!latestByStudent.has(s.studentId)) latestByStudent.set(s.studentId, s);
    }

    const rows = enrollments.map((e) => {
      const s = latestByStudent.get(e.student.id);
      return {
        student: e.student,
        attempts: attemptsByStudent.get(e.student.id) ?? 0,
        latest: s
          ? {
              submissionId: s.id,
              attemptNumber: s.attemptNumber,
              status: s.status,
              provisionalScore: s.provisionalScore,
              finalScore: s.finalScore,
              finalDecision: s.finalDecision,
              aiConfidence: s.reviews[0]?.confidence ?? null,
              feedbackCount: s._count.feedback,
              submittedAt: s.submittedAt,
            }
          : null,
      };
    });

    const withSub = rows.filter((r) => r.latest);
    const stats = {
      students: enrollments.length,
      submitted: withSub.length,
      notSubmitted: enrollments.length - withSub.length,
      passed: withSub.filter(
        (r) => r.latest!.status === CodingSubmissionStatus.PASSED,
      ).length,
      failed: withSub.filter(
        (r) => r.latest!.status === CodingSubmissionStatus.FAILED,
      ).length,
      needsReview: withSub.filter((r) => AWAITING.has(r.latest!.status)).length,
    };

    return { assignment, stats, rows };
  }

  /** Instructor adds feedback (general, or an inline file/line comment). */
  async addFeedback(
    user: JwtPayload,
    submissionId: string,
    dto: CreateFeedbackDto,
  ) {
    await this.assertManagesSubmission(user, submissionId);
    return this.prisma.codingFeedback.create({
      data: {
        submissionId,
        authorId: user.sub,
        body: dto.body,
        filePath: dto.filePath ?? null,
        line: dto.line ?? null,
        visibleToStudent: dto.visibleToStudent ?? true,
      },
    });
  }

  /**
   * The instructor's final ruling — overrides the AI. PASS/FAIL finalise the
   * attempt; RETURN sends it back for revision (the student may resubmit if the
   * assignment allows it and attempts remain).
   */
  async decide(user: JwtPayload, submissionId: string, dto: DecisionDto) {
    await this.assertManagesSubmission(user, submissionId);

    const status =
      dto.decision === DecisionKind.PASS
        ? CodingSubmissionStatus.PASSED
        : dto.decision === DecisionKind.FAIL
          ? CodingSubmissionStatus.FAILED
          : CodingSubmissionStatus.RETURNED;
    const finalDecision =
      dto.decision === DecisionKind.PASS
        ? CodingVerdict.PASS
        : dto.decision === DecisionKind.FAIL
          ? CodingVerdict.FAIL
          : null;

    const result = await this.prisma.$transaction(async (tx) => {
      if (dto.feedback?.trim()) {
        await tx.codingFeedback.create({
          data: {
            submissionId,
            authorId: user.sub,
            body: dto.feedback.trim(),
            visibleToStudent: true,
          },
        });
      }
      return tx.codingSubmission.update({
        where: { id: submissionId },
        data: {
          status,
          finalDecision,
          finalScore: dto.finalScore ?? undefined,
          reviewedById: user.sub,
          reviewedAt: new Date(),
        },
        include: { feedback: { orderBy: { createdAt: 'asc' } } },
      });
    });

    // The final ruling overrides the AI — push it to the live board + staff card.
    await this.live.broadcastSubmissionUpdate(submissionId);
    return result;
  }

  // ---------- Helpers ----------

  private async assertManagesSubmission(user: JwtPayload, submissionId: string) {
    const submission = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, assignment: { select: { courseId: true } } },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    await this.courses.assertCanManageCourse(
      user,
      submission.assignment.courseId,
    );
    return submission;
  }
}
