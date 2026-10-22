import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SessionStatus } from '@prisma/client';
import Redis from 'ioredis';
import * as Y from 'yjs';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS } from '../redis/redis.module';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';

const assetKey = (id: string) => `board-asset/${id}`;
const typeKey = (id: string) => `board-asset/${id}.ct`;
const sessionKey = (id: string) => `board-asset/${id}.session`;
const boardKey = (sessionId: string) => `boards/${sessionId}.bin`;
const BOARD_FILES_KEY = 'excalidraw-files';

/** Removes imported chalkboard files one year after a class ends. */
@Injectable()
export class BoardAssetRetentionService {
  private readonly logger = new Logger(BoardAssetRetentionService.name);
  private static readonly CURSOR_KEY = 'board:asset-cleanup:last-session-id';
  private static readonly RETRY_SET = 'board:asset-cleanup:retry-sessions';

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  @Cron('0 4 * * *')
  async removeExpiredAssets(): Promise<void> {
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const retries = await this.redis.smembers(
      BoardAssetRetentionService.RETRY_SET,
    );
    for (const sessionId of retries.slice(0, 100)) {
      if (await this.removeSessionAssets(sessionId)) {
        await this.redis.srem(BoardAssetRetentionService.RETRY_SET, sessionId);
      }
    }

    let cursor = await this.redis.get(BoardAssetRetentionService.CURSOR_KEY);
    let sessions = await this.prisma.liveSession.findMany({
      where: {
        status: SessionStatus.ENDED,
        endedAt: { lt: cutoff },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true },
      take: 100,
      orderBy: { id: 'asc' },
    });
    if (!sessions.length && cursor) {
      cursor = null;
      await this.redis.del(BoardAssetRetentionService.CURSOR_KEY);
      sessions = await this.prisma.liveSession.findMany({
        where: { status: SessionStatus.ENDED, endedAt: { lt: cutoff } },
        select: { id: true },
        take: 100,
        orderBy: { id: 'asc' },
      });
    }

    for (const { id } of sessions) {
      if (!(await this.removeSessionAssets(id))) {
        await this.redis.sadd(BoardAssetRetentionService.RETRY_SET, id);
      }
    }
    if (sessions.length) {
      await this.redis.set(
        BoardAssetRetentionService.CURSOR_KEY,
        sessions[sessions.length - 1].id,
      );
    }
  }

  private async removeSessionAssets(sessionId: string): Promise<boolean> {
    const index = `board:assets:${sessionId}`;
    const ids = new Set(await this.redis.smembers(index));
    try {
      const snapshot = await this.storage.get(boardKey(sessionId));
      if (snapshot) {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, snapshot);
          for (const value of doc.getMap<unknown>(BOARD_FILES_KEY).values()) {
            if (!value || typeof value !== 'object') continue;
            const url = (value as { url?: unknown }).url;
            if (typeof url !== 'string') continue;
            try {
              const path = new URL(url, 'https://assets.invalid').pathname;
              const match = path.match(/\/board-asset\/(?:[^/]+\/)?([^/]+)$/);
              const id = match?.[1] ? decodeURIComponent(match[1]) : '';
              if (
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                  id,
                )
              ) {
                ids.add(id);
              }
            } catch {
              // Ignore malformed or external asset URLs in legacy snapshots.
            }
          }
        } finally {
          doc.destroy();
        }
      }
    } catch (error) {
      this.logger.warn(
        `Could not read expired board ${sessionId}: ${String(error)}`,
      );
      return false;
    }

    let complete = true;
    for (const id of ids) {
      try {
        await Promise.all([
          this.storage.delete(assetKey(id)),
          this.storage.delete(typeKey(id)),
          this.storage.delete(sessionKey(id)),
        ]);
        await this.redis.srem(index, id);
      } catch (error) {
        complete = false;
        this.logger.warn(
          `Could not remove expired board asset ${id}: ${String(error)}`,
        );
      }
    }
    if (!complete || (await this.redis.scard(index)) > 0) return false;
    try {
      await this.storage.delete(boardKey(sessionId));
    } catch (error) {
      this.logger.warn(
        `Could not remove expired board ${sessionId}: ${String(error)}`,
      );
      return false;
    }
    await this.redis.del(
      index,
      `board:asset-count:${sessionId}`,
      `board:asset-bytes:${sessionId}`,
    );
    return true;
  }
}
