import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as Y from 'yjs';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';

interface BoardEntry {
  doc: Y.Doc;
  dirty: boolean;
  clients: number;
}

const boardKey = (sessionId: string) => `boards/${sessionId}.bin`;

/**
 * Server-side Yjs document per session. Docs live in memory while clients
 * are connected; snapshots go to object storage (local disk or R2) every
 * FLUSH_MS and when the last client leaves.
 *
 * Doc authority is per-process: with multiple gateway instances the Redis
 * adapter still fans updates out to clients everywhere, but only the
 * instance the instructor is connected to mutates and persists the doc.
 * Fine while writes are instructor-only; revisit (y-redis) if that changes.
 */
@Injectable()
export class BoardDocService implements OnModuleDestroy {
  private static readonly FLUSH_MS = 15_000;

  private readonly logger = new Logger(BoardDocService.name);
  private readonly boards = new Map<string, BoardEntry>();
  private readonly loading = new Map<string, Promise<BoardEntry>>();
  private readonly flushTimer: NodeJS.Timeout;

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    this.flushTimer = setInterval(
      () => void this.flushDirty(),
      BoardDocService.FLUSH_MS,
    );
    this.flushTimer.unref();
  }

  /** Load (or create) the doc and count the client in. */
  async retain(sessionId: string): Promise<Y.Doc> {
    const entry = this.boards.get(sessionId) ?? (await this.load(sessionId));
    entry.clients += 1;
    return entry.doc;
  }

  /** Count a client out; the last one flushes and evicts the doc. Returns
   *  true when this was the last client (the room is now empty), so callers
   *  can drop any per-session state they keep alongside the doc. */
  async release(sessionId: string): Promise<boolean> {
    const entry = this.boards.get(sessionId);
    if (!entry) return false;
    entry.clients -= 1;
    if (entry.clients > 0) return false;
    await this.flush(sessionId, entry);
    entry.doc.destroy();
    this.boards.delete(sessionId);
    return true;
  }

  applyUpdate(sessionId: string, update: Uint8Array): boolean {
    const entry = this.boards.get(sessionId);
    if (!entry) return false;
    Y.applyUpdate(entry.doc, update);
    entry.dirty = true;
    return true;
  }

  encodeState(sessionId: string): Uint8Array | null {
    const entry = this.boards.get(sessionId);
    return entry ? Y.encodeStateAsUpdate(entry.doc) : null;
  }

  async onModuleDestroy() {
    clearInterval(this.flushTimer);
    await this.flushDirty();
  }

  private load(sessionId: string): Promise<BoardEntry> {
    // Concurrent joins share one load so the doc is only created once.
    let pending = this.loading.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const doc = new Y.Doc();
        const snapshot = await this.storage.get(boardKey(sessionId));
        if (snapshot) Y.applyUpdate(doc, snapshot);
        const entry: BoardEntry = { doc, dirty: false, clients: 0 };
        this.boards.set(sessionId, entry);
        return entry;
      })().finally(() => this.loading.delete(sessionId));
      this.loading.set(sessionId, pending);
    }
    return pending;
  }

  private async flushDirty() {
    for (const [sessionId, entry] of this.boards) {
      if (entry.dirty) await this.flush(sessionId, entry);
    }
  }

  private async flush(sessionId: string, entry: BoardEntry) {
    try {
      await this.storage.put(
        boardKey(sessionId),
        Buffer.from(Y.encodeStateAsUpdate(entry.doc)),
        'application/octet-stream',
      );
      entry.dirty = false;
    } catch (e) {
      this.logger.error(`Board flush failed for ${sessionId}: ${String(e)}`);
    }
  }
}
