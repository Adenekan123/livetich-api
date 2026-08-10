import { Prisma, SessionStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

export interface StudentStat {
  points: number;
  interactions: number; // chat messages + quiz/buzzer answers
  attended: number; // live sessions joined (within scope)
  held: number; // ENDED sessions in scope (attendance denominator)
  assignmentsSubmitted: number; // submissions made (within scope)
  assignmentsTotal: number; // assignments across the student's enrolled courses in scope
}

/**
 * Aggregate performance for a set of students, scoped to the courses matched by
 * `courseWhere` (e.g. one program, a whole org, or an instructor's courses).
 */
export async function aggregateStudentStats(
  prisma: PrismaService,
  students: { id: string; enrolledCourseIds: string[] }[],
  courseWhere: Prisma.CourseWhereInput,
): Promise<Map<string, StudentStat>> {
  const stats = new Map<string, StudentStat>();
  if (students.length === 0) return stats;
  const studentIds = students.map((s) => s.id);
  for (const id of studentIds) {
    stats.set(id, {
      points: 0,
      interactions: 0,
      attended: 0,
      held: 0,
      assignmentsSubmitted: 0,
      assignmentsTotal: 0,
    });
  }

  const [points, chats, answers, attendance, held, submissions, courseAssignments] =
    await Promise.all([
    prisma.pointsLedger.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds }, course: courseWhere },
      _sum: { delta: true },
    }),
    prisma.chatMessage.groupBy({
      by: ['userId'],
      where: { userId: { in: studentIds }, session: { course: courseWhere } },
      _count: { _all: true },
    }),
    prisma.quizAnswer.groupBy({
      by: ['studentId'],
      where: {
        studentId: { in: studentIds },
        question: { quiz: { session: { course: courseWhere } } },
      },
      _count: { _all: true },
    }),
    prisma.attendance.groupBy({
      by: ['studentId'],
      where: { studentId: { in: studentIds }, session: { course: courseWhere } },
      _count: { _all: true },
    }),
    prisma.liveSession.count({
      where: { status: SessionStatus.ENDED, course: courseWhere },
    }),
    prisma.submission.groupBy({
      by: ['studentId'],
      where: {
        studentId: { in: studentIds },
        assignment: { course: courseWhere },
      },
      _count: { _all: true },
    }),
    prisma.assignment.groupBy({
      by: ['courseId'],
      where: { course: courseWhere },
      _count: { _all: true },
    }),
  ]);

  for (const p of points) {
    stats.get(p.studentId)!.points = p._sum.delta ?? 0;
  }
  for (const c of chats) {
    stats.get(c.userId)!.interactions += c._count._all;
  }
  for (const a of answers) {
    stats.get(a.studentId)!.interactions += a._count._all;
  }
  for (const a of attendance) {
    stats.get(a.studentId)!.attended = a._count._all;
  }
  for (const s of stats.values()) s.held = held;

  for (const sub of submissions) {
    stats.get(sub.studentId)!.assignmentsSubmitted = sub._count._all;
  }
  // Assignments a student is expected to do = those in their enrolled,
  // in-scope courses (the groupBy only returns in-scope courses).
  const perCourse = new Map(
    courseAssignments.map((a) => [a.courseId, a._count._all]),
  );
  for (const s of students) {
    let total = 0;
    for (const cid of s.enrolledCourseIds) total += perCourse.get(cid) ?? 0;
    stats.get(s.id)!.assignmentsTotal = total;
  }

  return stats;
}
