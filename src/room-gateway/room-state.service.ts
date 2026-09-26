import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import type {
  BuzzerState,
  QuranPosition,
  RoomScheme,
  RoomUser,
  StageView,
  TajweedPart,
  TajweedTemporaryAnnotation,
} from '../shared';
import { ROOM_SCHEMES } from '../shared';
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

  // ---------- Active stage view (instructor-driven) ----------

  async setView(sessionId: string, view: StageView) {
    await this.redis.set(
      this.k(sessionId, 'view'),
      view,
      'EX',
      RoomStateService.TTL,
    );
  }

  async getView(sessionId: string): Promise<StageView> {
    const v = await this.redis.get(this.k(sessionId, 'view'));
    return v === 'board' || v === 'quran' || v === 'code' ? v : 'video';
  }

  // ---------- Room colour scheme (instructor-driven) ----------

  async setTheme(sessionId: string, scheme: RoomScheme) {
    await this.redis.set(
      this.k(sessionId, 'theme'),
      scheme,
      'EX',
      RoomStateService.TTL,
    );
  }

  async getTheme(sessionId: string): Promise<RoomScheme> {
    const v = await this.redis.get(this.k(sessionId, 'theme'));
    return (ROOM_SCHEMES as readonly string[]).includes(v ?? '')
      ? (v as RoomScheme)
      : 'teal';
  }

  // ---------- Shared mushaf position (instructor-driven) ----------

  async setQuranPos(sessionId: string, pos: QuranPosition) {
    await this.redis.set(
      this.k(sessionId, 'quran'),
      JSON.stringify(pos),
      'EX',
      RoomStateService.TTL,
    );
  }

  /** Current mushaf position, defaulting to Al-Fatihah 1 for a fresh room. */
  async getQuranPos(sessionId: string): Promise<QuranPosition> {
    const raw = await this.redis.get(this.k(sessionId, 'quran'));
    return raw ? (JSON.parse(raw) as QuranPosition) : { surah: 1, ayah: 1 };
  }

  /** True once the mushaf has a stored position — so we only seed a fresh room
   *  from the last recitation once, and never stomp the instructor's live page. */
  async hasQuranPos(sessionId: string): Promise<boolean> {
    return (await this.redis.exists(this.k(sessionId, 'quran'))) === 1;
  }

  // ---------- Live Tajweed annotations (instructor-driven, never persisted) ----------

  /** A ceiling on live annotations per session, so a runaway client cannot
   *  grow the hash — and every join payload — without bound. */
  private static readonly TAJWEED_LIVE_MAX = 50;

  /** Show or replace one live annotation. False when the session is already at
   *  the ceiling and this would be a new one. */
  async setTajweedTemporary(
    sessionId: string,
    annotation: TajweedTemporaryAnnotation,
  ): Promise<boolean> {
    const key = this.k(sessionId, 'tajweed');
    const exists = await this.redis.hexists(key, annotation.id);
    if (!exists && (await this.redis.hlen(key)) >= RoomStateService.TAJWEED_LIVE_MAX) {
      return false;
    }
    await this.redis.hset(key, annotation.id, JSON.stringify(annotation));
    await this.redis.expire(key, RoomStateService.TTL);
    return true;
  }

  /** Clear one live annotation, or every one when no id is given. */
  async clearTajweedTemporary(sessionId: string, id?: string) {
    const key = this.k(sessionId, 'tajweed');
    if (id) await this.redis.hdel(key, id);
    else await this.redis.del(key);
  }

  // ---------- What the instructor is pointing at ----------

  /**
   * The parts the instructor has picked but not yet marked.
   *
   * The class sees these outlined while the teacher decides, which is what
   * makes marking a shared act rather than a result landing on the page. It is
   * a selection, not a mark: an empty list is how it goes away, and like every
   * live annotation it never reaches the database.
   */
  async setTajweedPointing(sessionId: string, parts: TajweedPart[]) {
    const key = this.k(sessionId, 'tajweed-point');
    if (!parts.length) {
      await this.redis.del(key);
      return;
    }
    await this.redis.set(
      key,
      JSON.stringify(parts),
      'EX',
      RoomStateService.TTL,
    );
  }

  /** What is pointed at right now; empty when nothing is. */
  async getTajweedPointing(sessionId: string): Promise<TajweedPart[]> {
    const raw = await this.redis.get(this.k(sessionId, 'tajweed-point'));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as TajweedPart[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Nothing readable is nothing pointed at, rather than a broken room.
      return [];
    }
  }

  /**
   * The session's live annotations, minus any that have run out.
   *
   * Expiry is judged when the list is read rather than by a timer, so it holds
   * with any number of gateway instances and survives a restart. Clients hide
   * an annotation at its expiresAt on their own; this is what keeps a late
   * joiner from being sent one that has already gone.
   */
  async listTajweedTemporary(sessionId: string): Promise<TajweedTemporaryAnnotation[]> {
    const key = this.k(sessionId, 'tajweed');
    const raw = await this.redis.hgetall(key);
    const now = Date.now();
    const live: TajweedTemporaryAnnotation[] = [];
    const expired: string[] = [];
    for (const [id, json] of Object.entries(raw)) {
      const annotation = JSON.parse(json) as TajweedTemporaryAnnotation;
      if (annotation.expiresAt && Date.parse(annotation.expiresAt) <= now) {
        expired.push(id);
      } else {
        live.push(annotation);
      }
    }
    if (expired.length) await this.redis.hdel(key, ...expired);
    return live;
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

  // ---------- Mic speakers (students the instructor has granted the mic) ----------

  async grantMic(sessionId: string, userId: string) {
    const key = this.k(sessionId, 'speakers');
    await this.redis.sadd(key, userId);
    await this.redis.expire(key, RoomStateService.TTL);
  }

  async revokeMic(sessionId: string, userId: string) {
    await this.redis.srem(this.k(sessionId, 'speakers'), userId);
  }

  async listSpeakers(sessionId: string): Promise<string[]> {
    return this.redis.smembers(this.k(sessionId, 'speakers'));
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
