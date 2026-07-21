import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as Y from 'yjs';

interface BoardEntry {
  doc: Y.Doc;
  dirty: boolean;
  clients: number;
}

/**
 * Server-side Yjs document per session. Docs live in memory while clients
 * are connected; snapshots go to local disk (R2 later) every FLUSH_MS and
 * when the last client leaves.
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
  private readonly dir: string;
  private readonly boards = new Map<string, BoardEntry>();
  private readonly loading = new Map<string, Promise<BoardEntry>>();
  private readonly flushTimer: NodeJS.Timeout;

  constructor(config: ConfigService) {
    this.dir =
      config.get<string>('BOARD_STORAGE_DIR') ??
      join(process.cwd(), 'storage', 'boards');
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

  /** Count a client out; the last one flushes and evicts the doc. */
  async release(sessionId: string): Promise<void> {
    const entry = this.boards.get(sessionId);
    if (!entry) return;
    entry.clients -= 1;
    if (entry.clients > 0) return;
    await this.flush(sessionId, entry);
    entry.doc.destroy();
    this.boards.delete(sessionId);
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
        try {
          Y.applyUpdate(doc, await readFile(this.pathFor(sessionId)));
        } catch {
          // No snapshot yet — start blank.
        }
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
      await mkdir(this.dir, { recursive: true });
      await writeFile(
        this.pathFor(sessionId),
        Y.encodeStateAsUpdate(entry.doc),
      );
      entry.dirty = false;
    } catch (e) {
      this.logger.error(`Board flush failed for ${sessionId}: ${String(e)}`);
    }
  }

  private pathFor(sessionId: string) {
    return join(this.dir, `${sessionId}.bin`);
  }
}
