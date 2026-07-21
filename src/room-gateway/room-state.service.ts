import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import type { BuzzerState, RoomUser } from '../shared';
import { REDIS } from '../redis/redis.module';

/**
 * All ephemeral room state lives in Redis keyed by sessionId, so any gateway
 * instance can serve any room. Keys are TTL'd to self-clean after sessions.
 */
@Injectable()
export class RoomStateService {
  private static readonly TTL = 60 * 60 * 12; // 12h safety net

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  // ---------- Presence ----------

  async addPresence(sessionId: string, user: RoomUser) {
    const key = this.k(sessionId, 'presence');
    await this.redis.hset(key, user.userId, JSON.stringify(user));
    await this.redis.expire(key, RoomStateService.TTL);
  }

  async removePresence(sessionId: string, userId: string) {
    await this.redis.hdel(this.k(sessionId, 'presence'), userId);
  }

  async listPresence(sessionId: string): Promise<RoomUser[]> {
    const raw = await this.redis.hvals(this.k(sessionId, 'presence'));
    return raw.map((r) => JSON.parse(r) as RoomUser);
  }

  // ---------- Chat lock ----------

  async setChatLock(sessionId: string, locked: boolean) {
    const key = this.k(sessionId, 'chatlock');
    if (locked) {
      await this.redis.set(key, '1', 'EX', RoomStateService.TTL);
    } else {
      await this.redis.del(key);
    }
  }

  async isChatLocked(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(this.k(sessionId, 'chatlock'))) === 1;
  }

  // ---------- Raised hands ----------

  async raiseHand(sessionId: string, user: RoomUser) {
    const key = this.k(sessionId, 'hands');
    await this.redis.hset(key, user.userId, JSON.stringify(user));
    await this.redis.expire(key, RoomStateService.TTL);
  }

  async lowerHand(sessionId: string, userId: string) {
    await this.redis.hdel(this.k(sessionId, 'hands'), userId);
  }

  async listHands(sessionId: string): Promise<RoomUser[]> {
    const raw = await this.redis.hvals(this.k(sessionId, 'hands'));
    return raw.map((r) => JSON.parse(r) as RoomUser);
  }

  async clearHands(sessionId: string) {
    await this.redis.del(this.k(sessionId, 'hands'));
  }

  async randomHand(sessionId: string): Promise<RoomUser | null> {
    const key = this.k(sessionId, 'hands');
    const userIds = await this.redis.hkeys(key);
    if (userIds.length === 0) return null;
    const pick = userIds[Math.floor(Math.random() * userIds.length)];
    const raw = await this.redis.hget(key, pick);
    return raw ? (JSON.parse(raw) as RoomUser) : null;
  }

  // ---------- Buzzer ----------

  async setBuzzerState(sessionId: string, state: BuzzerState) {
    await this.redis.set(
      this.k(sessionId, 'buzzer'),
      JSON.stringify(state),
      'EX',
      RoomStateService.TTL,
    );
  }

  async getBuzzerState(sessionId: string): Promise<BuzzerState | null> {
    const raw = await this.redis.get(this.k(sessionId, 'buzzer'));
    return raw ? (JSON.parse(raw) as BuzzerState) : null;
  }

  /** Returns true the first time a student answers the open buzzer question. */
  async markBuzzerAnswered(sessionId: string, userId: string): Promise<boolean> {
    const key = this.k(sessionId, 'buzzer-answered');
    const added = await this.redis.sadd(key, userId);
    await this.redis.expire(key, RoomStateService.TTL);
    return added === 1;
  }

  async clearBuzzerAnswered(sessionId: string) {
    await this.redis.del(this.k(sessionId, 'buzzer-answered'));
  }

  private k(sessionId: string, part: string): string {
    return `room:${sessionId}:${part}`;
  }
}
