import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as Y from 'yjs';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';

interface CodeEntry {
  doc: Y.Doc;
  dirty: boolean;
  clients: number;
}

const codeKey = (sessionId: string) => `codeboards/${sessionId}.bin`;

/**
 * Server-side Yjs document per session for the shared code editor — the exact
 * same model as {@link BoardDocService}, just a different object-storage key.
 * The doc holds a Y.Text (the buffer) and a Y.Map (the language); both persist
 * in the one snapshot. Docs live in memory while clients are connected and are
 * flushed to storage every FLUSH_MS and when the last client leaves.
 *
 * Doc authority is per-process: fine while writes are instructor-only (the
 * gateway rejects student writes). Revisit (y-redis) if that changes.
 */
@Injectable()
export class CodeDocService implements OnModuleDestroy {
  private static readonly FLUSH_MS = 15_000;

  private readonly logger = new Logger(CodeDocService.name);
  private readonly docsBySession = new Map<string, CodeEntry>();
  private readonly loading = new Map<string, Promise<CodeEntry>>();
  private readonly flushTimer: NodeJS.Timeout;

  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {
    this.flushTimer = setInterval(
      () => void this.flushDirty(),
      CodeDocService.FLUSH_MS,
    );
    this.flushTimer.unref();
  }

  /** Load (or create) the doc and count the client in. */
  async retain(sessionId: string): Promise<Y.Doc> {
    const entry =
      this.docsBySession.get(sessionId) ?? (await this.load(sessionId));
    entry.clients += 1;
    return entry.doc;
  }

  /** Count a client out; the last one flushes and evicts the doc. */
  async release(sessionId: string): Promise<void> {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return;
    entry.clients -= 1;
    if (entry.clients > 0) return;
    await this.flush(sessionId, entry);
    entry.doc.destroy();
    this.docsBySession.delete(sessionId);
  }

  applyUpdate(sessionId: string, update: Uint8Array): boolean {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return false;
    Y.applyUpdate(entry.doc, update);
    entry.dirty = true;
    return true;
  }

  encodeState(sessionId: string): Uint8Array | null {
    const entry = this.docsBySession.get(sessionId);
    return entry ? Y.encodeStateAsUpdate(entry.doc) : null;
  }

  async onModuleDestroy() {
    clearInterval(this.flushTimer);
    await this.flushDirty();
  }

  private load(sessionId: string): Promise<CodeEntry> {
    // Concurrent joins share one load so the doc is only created once.
    let pending = this.loading.get(sessionId);
    if (!pending) {
      pending = (async () => {
        const doc = new Y.Doc();
        const snapshot = await this.storage.get(codeKey(sessionId));
        if (snapshot) Y.applyUpdate(doc, snapshot);
        const entry: CodeEntry = { doc, dirty: false, clients: 0 };
        this.docsBySession.set(sessionId, entry);
        return entry;
      })().finally(() => this.loading.delete(sessionId));
      this.loading.set(sessionId, pending);
    }
    return pending;
  }

  private async flushDirty() {
    for (const [sessionId, entry] of this.docsBySession) {
      if (entry.dirty) await this.flush(sessionId, entry);
    }
  }

  private async flush(sessionId: string, entry: CodeEntry) {
    try {
      await this.storage.put(
        codeKey(sessionId),
        Buffer.from(Y.encodeStateAsUpdate(entry.doc)),
        'application/octet-stream',
      );
      entry.dirty = false;
    } catch (e) {
      this.logger.error(`Code flush failed for ${sessionId}: ${String(e)}`);
    }
  }
}
