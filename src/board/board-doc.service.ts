import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as Y from 'yjs';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';

interface BoardEntry {
  doc: Y.Doc;
  dirty: boolean;
  clients: number;
  revision: number;
}

const boardKey = (sessionId: string) => `boards/${sessionId}.bin`;

/**
 * Server-side Yjs document per session. Docs live in memory while clients
 * are connected; snapshots go to object storage (local disk or R2) every
 * FLUSH_MS and when the last client leaves.
 *
 * Doc authority is per-process. The production Compose deployment deliberately
 * runs one API instance because students can also write while the instructor
 * opens the board. Do not remove that singleton guard before switching this
 * service to a shared Yjs provider.
 */
@Injectable()
export class BoardDocService implements OnModuleDestroy {
  private static readonly FLUSH_MS = 15_000;

  private readonly logger = new Logger(BoardDocService.name);
  private readonly boards = new Map<string, BoardEntry>();
  private readonly loading = new Map<string, Promise<BoardEntry>>();
  private readonly flushTimer: NodeJS.Timeout;

  constructor(@Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage) {
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
    entry.clients = Math.max(0, entry.clients - 1);
    if (entry.clients > 0) return false;
    // A failed final write must leave the dirty Y.Doc available to the periodic
    // retry. Destroying it here made a short object-store outage permanent data
    // loss for everything since the last successful snapshot.
    while (entry.dirty && entry.clients === 0) {
      // The gateway still needs to clear session-scoped UI state when the last
      // socket leaves, even though we keep the dirty document for retry.
      if (!(await this.flush(sessionId, entry))) return true;
    }
    // A participant can rejoin while the last-client snapshot flush is awaiting
    // object storage. In that window retain() revives this entry; do not destroy
    // the active document after the flush completes.
    if (entry.clients > 0) return false;
    entry.doc.destroy();
    this.boards.delete(sessionId);
    return true;
  }

  applyUpdate(sessionId: string, update: Uint8Array): boolean {
    const entry = this.boards.get(sessionId);
    if (!entry) return false;
    Y.applyUpdate(entry.doc, update);
    entry.dirty = true;
    entry.revision += 1;
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
        const entry: BoardEntry = {
          doc,
          dirty: false,
          clients: 0,
          revision: 0,
        };
        this.boards.set(sessionId, entry);
        return entry;
      })().finally(() => this.loading.delete(sessionId));
      this.loading.set(sessionId, pending);
    }
    return pending;
  }

  private async flushDirty() {
    for (const [sessionId, entry] of this.boards) {
      if (!entry.dirty) continue;
      const saved = await this.flush(sessionId, entry);
      if (saved && !entry.dirty && entry.clients === 0) {
        entry.doc.destroy();
        if (this.boards.get(sessionId) === entry) this.boards.delete(sessionId);
      }
    }
  }

  private async flush(sessionId: string, entry: BoardEntry): Promise<boolean> {
    const revision = entry.revision;
    try {
      await this.storage.put(
        boardKey(sessionId),
        Buffer.from(Y.encodeStateAsUpdate(entry.doc)),
        'application/octet-stream',
      );
      // Do not mark clean if new edits arrived while the storage write was in
      // flight; the next timer tick or final-release loop will save those too.
      if (entry.revision === revision) entry.dirty = false;
      return true;
    } catch (e) {
      this.logger.error(`Board flush failed for ${sessionId}: ${String(e)}`);
      return false;
    }
  }
}
