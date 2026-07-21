import { Injectable } from '@nestjs/common';
import { PointsReason, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Points awarded per correct quiz answer. */
export const POINTS_QUIZ_CORRECT = 10;
/** Points awarded for winning a buzzer round. */
export const POINTS_BUZZER_WIN = 25;

export interface LeaderboardRow {
  userId: string;
  name: string;
  points: number;
  rank: number;
}

@Injectable()
export class PointsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append to the ledger. Pass `tx` to make the award part of a larger
   * transaction (e.g. answer + points must land together).
   */
  award(
    opts: {
      studentId: string;
      courseId: string;
      delta: number;
      reason: PointsReason;
      refId?: string;
    },
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    return tx.pointsLedger.create({ data: opts });
  }

  /**
   * Public course leaderboard (feature: all students see each other's
   * points). Computed from the ledger; a Redis ZSET projection will take
   * over the hot read path once the realtime gateway lands.
   */
  async leaderboard(courseId: string): Promise<LeaderboardRow[]> {
    const sums = await this.prisma.pointsLedger.groupBy({
      by: ['studentId'],
      where: { courseId },
      _sum: { delta: true },
    });
    if (sums.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: sums.map((s) => s.studentId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    return sums
      .map((s) => ({
        userId: s.studentId,
        name: nameById.get(s.studentId) ?? 'Unknown',
        points: s._sum.delta ?? 0,
      }))
      .sort((a, b) => b.points - a.points)
      .map((row, i) => ({ ...row, rank: i + 1 }));
  }

  async myPoints(studentId: string, courseId: string) {
    const agg = await this.prisma.pointsLedger.aggregate({
      where: { studentId, courseId },
      _sum: { delta: true },
    });
    return { courseId, points: agg._sum.delta ?? 0 };
  }
}
