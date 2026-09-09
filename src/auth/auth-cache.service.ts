import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';

export interface AccountState {
  status: UserStatus;
  emailVerified: boolean;
}

/**
 * Caches the per-request account check (status + emailVerified) that the JWT
 * guard runs on every authenticated request, so MySQL isn't hit each time.
 * Short TTL as a safety net; the security-relevant mutations (disable/enable,
 * email verify) invalidate the key explicitly, so the gate stays immediate.
 */
@Injectable()
export class AuthCacheService {
  private static readonly TTL_SECONDS = 60;
  private readonly logger = new Logger(AuthCacheService.name);

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  private key(userId: string): string {
    return `authcache:${userId}`;
  }

  /** Cached account state, or null if the user no longer exists. */
  async getState(userId: string): Promise<AccountState | null> {
    // Redis is a cache, never the source of truth. If it's unreachable the
    // request must still succeed off the DB — otherwise a Redis blip would
    // 500 (or hang) every authenticated request, which is exactly what makes
    // joining a session slow/broken during an outage.
    try {
      const cached = await this.redis.get(this.key(userId));
      if (cached) return JSON.parse(cached) as AccountState;
    } catch (err) {
      this.logger.warn(`cache read failed, falling back to DB: ${String(err)}`);
    }

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, emailVerified: true },
    });
    if (!account) return null;

    try {
      await this.redis.set(
        this.key(userId),
        JSON.stringify(account),
        'EX',
        AuthCacheService.TTL_SECONDS,
      );
    } catch {
      // Best-effort cache write; a failed set just means the next request
      // re-reads from the DB.
    }
    return account;
  }

  /** Drop the cached state so the next request re-reads from the DB. */
  async invalidate(userId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId));
    } catch (err) {
      // If Redis is down there's nothing to invalidate — getState already
      // falls through to the DB, so the gate stays correct.
      this.logger.warn(`cache invalidate failed: ${String(err)}`);
    }
  }
}

@Global()
@Module({
  providers: [AuthCacheService],
  exports: [AuthCacheService],
})
export class AuthCacheModule {}
