import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RoomBroadcaster } from '../realtime/room-broadcaster';
import type { CodingPointEntry } from '../shared';

/**
 * Coding Instructor Plugin — the live-session bridge. Pushes coding-task state
 * into a session room over the RoomBroadcaster seam (no gateway coupling):
 *  - `coding:task`       to everyone when a task is launched,
 *  - `coding:points`     to everyone as scores land (code never leaves),
 *  - `coding:submission` to staff so the instructor's in-room review card updates.
 *
 * Every method is a no-op when the task isn't bound to a session, so submission
 * and review flows can call it unconditionally.
 */
@Injectable()
export class CodingLiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcaster: RoomBroadcaster,
  ) {}

  /** Announce a launched task to its room, then seed the points board. */
  async broadcastTask(assignmentId: string): Promise<void> {
    const a = await this.prisma.codingAssignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        sessionId: true,
        status: true,
        title: true,
        language: true,
        dueAt: true,
        _count: { select: { requirements: true } },
      },
    });
    if (!a?.sessionId || a.status !== 'LIVE') return;
    this.broadcaster.emitToSession(a.sessionId, 'coding:task', {
      sessionId: a.sessionId,
      assignmentId: a.id,
      title: a.title,
      language: a.language,
      requirementCount: a._count.requirements,
      dueAt: a.dueAt ? a.dueAt.toISOString() : null,
    });
    await this.broadcastPoints(a.id);
  }

  /** Recompute the whole roster's standings and push them to the room. */
  async broadcastPoints(assignmentId: string): Promise<void> {
    const a = await this.prisma.codingAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, sessionId: true, courseId: true },
    });
    if (!a?.sessionId) return;

    const [enrollments, subs] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { courseId: a.courseId },
        select: { student: { select: { id: true, name: true } } },
        orderBy: { student: { name: 'asc' } },
      }),
      this.prisma.codingSubmission.findMany({
        where: { assignmentId },
        orderBy: { attemptNumber: 'desc' },
        select: {
          studentId: true,
          status: true,
          provisionalScore: true,
          finalScore: true,
        },
      }),
    ]);

    // Reduce to each student's latest attempt (submissions are attempt-desc).
    const latest = new Map<string, (typeof subs)[number]>();
    for (const s of subs) if (!latest.has(s.studentId)) latest.set(s.studentId, s);

    const entries: CodingPointEntry[] = enrollments
      .map((e) => {
        const s = latest.get(e.student.id);
        return {
          studentId: e.student.id,
          name: e.student.name,
          status: s?.status ?? 'CODING',
          score: s ? (s.finalScore ?? s.provisionalScore) : null,
        };
      })
      // Highest score first; students still coding (null) sort to the bottom.
      .sort((x, y) => (y.score ?? -1) - (x.score ?? -1));

    this.broadcaster.emitToSession(a.sessionId, 'coding:points', {
      sessionId: a.sessionId,
      assignmentId: a.id,
      entries,
    });
  }

  /** Push one submission's changed state to the instructor's staff room. */
  async broadcastReview(submissionId: string): Promise<void> {
    const s = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      select: {
        id: true,
        studentId: true,
        attemptNumber: true,
        status: true,
        provisionalScore: true,
        finalScore: true,
        assignment: { select: { id: true, sessionId: true } },
        student: { select: { name: true } },
        reviews: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { confidence: true },
        },
      },
    });
    const sessionId = s?.assignment.sessionId;
    if (!s || !sessionId) return;

    this.broadcaster.emitToSessionStaff(sessionId, 'coding:submission', {
      sessionId,
      submissionId: s.id,
      assignmentId: s.assignment.id,
      studentId: s.studentId,
      studentName: s.student.name,
      attemptNumber: s.attemptNumber,
      status: s.status,
      provisionalScore: s.provisionalScore,
      finalScore: s.finalScore,
      aiConfidence: s.reviews[0]?.confidence ?? null,
    });
  }

  /** Convenience: refresh both the room board and the staff review card. */
  async broadcastSubmissionUpdate(submissionId: string): Promise<void> {
    const s = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      select: { assignmentId: true },
    });
    if (!s) return;
    await Promise.all([
      this.broadcastPoints(s.assignmentId),
      this.broadcastReview(submissionId),
    ]);
  }
}
