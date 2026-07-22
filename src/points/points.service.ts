import { Inject, Injectable, Logger } from '@nestjs/common';
import { PointsReason, Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

/** Points awarded per correct quiz answer. */
export const POINTS_QUIZ_CORRECT = 10;
/** Points awarded for winning a buzzer round. */
export const POINTS_BUZZER_WIN = 25;

/** How long a rebuilt ZSET projection is trusted before a cold rebuild. */
const PROJECTION_TTL_SEC = 3600;

export interface LeaderboardRow {
  userId: string;
  name: string;
  points: number;
  rank: number;
}

const zsetKey = (courseId: string) => `lb:${courseId}`;
const builtKey = (courseId: string) => `lb:${courseId}:built`;

@Injectable()
export class PointsService {
  private readonly logger = new Logger(PointsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Append to the ledger (the source of truth). Pass `tx` to make the award
   * part of a larger transaction (e.g. answer + points must land together).
   * The Redis leaderboard ZSET is bumped best-effort as a projection.
   */
  async award(
    opts: {
      studentId: string;
      courseId: string;
      delta: number;
      reason: PointsReason;
      refId?: string;
    },
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const entry = await tx.pointsLedger.create({ data: opts });
    // Fire-and-forget: never let a Redis hiccup fail an award.
    void this.bumpProjection(opts.courseId, opts.studentId, opts.delta);
    return entry;
  }

  /**
   * Public course leaderboard (feature: all students see each other's
   * points). Served from a Redis ZSET projection; rebuilt from the ledger
   * on a cold cache.
   */
  async leaderboard(courseId: string): Promise<LeaderboardRow[]> {
    const ranked = await this.readProjection(courseId);
    const scores = ranked ?? (await this.rebuildProjection(courseId));
    if (scores.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: scores.map((s) => s.userId) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(users.map((u) => [u.id, u.name]));

    return scores.map((s, i) => ({
      userId: s.userId,
      name: nameById.get(s.userId) ?? 'Unknown',
      points: s.points,
      rank: i + 1,
    }));
  }

  async myPoints(studentId: string, courseId: string) {
    const agg = await this.prisma.pointsLedger.aggregate({
      where: { studentId, courseId },
      _sum: { delta: true },
    });
    return { courseId, points: agg._sum.delta ?? 0 };
  }

  // ---------- Redis projection ----------

  /** Increment the ZSET only while it is a trusted (built) projection. */
  private async bumpProjection(
    courseId: string,
    studentId: string,
    delta: number,
  ) {
    try {
      if (await this.redis.exists(builtKey(courseId))) {
        await this.redis.zincrby(zsetKey(courseId), delta, studentId);
      }
    } catch (e) {
      this.logger.debug(`Leaderboard projection bump skipped: ${String(e)}`);
    }
  }

  /** Descending scores from the ZSET, or null if the projection is cold. */
  private async readProjection(
    courseId: string,
  ): Promise<{ userId: string; points: number }[] | null> {
    try {
      if (!(await this.redis.exists(builtKey(courseId)))) return null;
      const flat = await this.redis.zrevrange(
        zsetKey(courseId),
        0,
        -1,
        'WITHSCORES',
      );
      const rows: { userId: string; points: number }[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        rows.push({ userId: flat[i], points: Number(flat[i + 1]) });
      }
      return rows;
    } catch (e) {
      this.logger.debug(`Leaderboard projection read failed: ${String(e)}`);
      return null;
    }
  }

  /** Recompute from the ledger and repopulate the ZSET. Always returns data. */
  private async rebuildProjection(
    courseId: string,
  ): Promise<{ userId: string; points: number }[]> {
    const sums = await this.prisma.pointsLedger.groupBy({
      by: ['studentId'],
      where: { courseId },
      _sum: { delta: true },
    });
    const rows = sums
      .map((s) => ({ userId: s.studentId, points: s._sum.delta ?? 0 }))
      .sort((a, b) => b.points - a.points);

    try {
      const key = zsetKey(courseId);
      const pipeline = this.redis.multi();
      pipeline.del(key);
      if (rows.length > 0) {
        const args: (string | number)[] = [];
        for (const r of rows) args.push(r.points, r.userId);
        pipeline.zadd(key, ...args);
        pipeline.expire(key, PROJECTION_TTL_SEC);
      }
      pipeline.set(builtKey(courseId), '1', 'EX', PROJECTION_TTL_SEC);
      await pipeline.exec();
    } catch (e) {
      this.logger.debug(`Leaderboard projection rebuild skipped: ${String(e)}`);
    }
    return rows;
  }
}
