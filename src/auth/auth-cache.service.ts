import { Global, Inject, Injectable, Module } from '@nestjs/common';
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

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  private key(userId: string): string {
    return `authcache:${userId}`;
  }

  /** Cached account state, or null if the user no longer exists. */
  async getState(userId: string): Promise<AccountState | null> {
    const cached = await this.redis.get(this.key(userId));
    if (cached) return JSON.parse(cached) as AccountState;

    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true, emailVerified: true },
    });
    if (!account) return null;

    await this.redis.set(
      this.key(userId),
      JSON.stringify(account),
      'EX',
      AuthCacheService.TTL_SECONDS,
    );
    return account;
  }

  /** Drop the cached state so the next request re-reads from the DB. */
  async invalidate(userId: string): Promise<void> {
    await this.redis.del(this.key(userId));
  }
}

@Global()
@Module({
  providers: [AuthCacheService],
  exports: [AuthCacheService],
})
export class AuthCacheModule {}
