import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as Y from 'yjs';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';

import { Role } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import type {
  CodeFileTreeNode,
  CodeFocusPayload,
  CodePermissionPayload,
} from '../shared';

interface CodeEntry {
  doc: Y.Doc;
  dirty: boolean;
  clients: number;
  permission: CodePermissionPayload;
  tree?: CodeFileTreeNode[];
  focus?: CodeFocusPayload;
  expandedFolders?: string[];
}

const codeKey = (sessionId: string) => `codeboards/${sessionId}.bin`;

/**
 * Server-side Yjs document per session for the shared code editor.
 * Manages Yjs buffers, active workspace file trees, follow cursor focus,
 * and live co-editing permissions (Duckly-like multi-file pairing).
 * Docs live in memory while clients are connected and are flushed to storage
 * every FLUSH_MS and automatically evicted when the last client leaves.
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

  /** Count a client out; the last one flushes and evicts the doc and state. */
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

  setPermission(sessionId: string, payload: CodePermissionPayload): void {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return;
    entry.permission = payload;
  }

  getPermission(sessionId: string): CodePermissionPayload {
    const entry = this.docsBySession.get(sessionId);
    return (
      entry?.permission ?? {
        sessionId,
        mode: 'INSTRUCTOR_ONLY',
      }
    );
  }

  canWrite(sessionId: string, user: JwtPayload): boolean {
    if (user.role === Role.INSTRUCTOR || user.role === Role.ORG_ADMIN) {
      return true;
    }
    const perm = this.getPermission(sessionId);
    if (perm.mode === 'OPEN') {
      return true;
    }
    if (perm.mode === 'DELEGATED' && perm.delegatedUserIds?.includes(user.sub)) {
      return true;
    }
    return false;
  }

  setFileContent(sessionId: string, path: string, content: string): void {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return;
    const yText = entry.doc.getText(`file:${path}`);
    if (yText.toString() !== content) {
      entry.doc.transact(() => {
        yText.delete(0, yText.length);
        yText.insert(0, content);
      });
      entry.dirty = true;
    }
  }

  setTree(sessionId: string, tree: CodeFileTreeNode[]): void {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return;
    entry.tree = tree;
  }

  getTree(sessionId: string): CodeFileTreeNode[] | undefined {
    return this.docsBySession.get(sessionId)?.tree;
  }

  setFocus(sessionId: string, focus: CodeFocusPayload): void {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return;
    entry.focus = focus;
  }

  getFocus(sessionId: string): CodeFocusPayload | undefined {
    return this.docsBySession.get(sessionId)?.focus;
  }

  setFoldersState(sessionId: string, expanded: string[]): void {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return;
    entry.expandedFolders = expanded;
  }

  getFoldersState(sessionId: string): string[] | undefined {
    return this.docsBySession.get(sessionId)?.expandedFolders;
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
        const entry: CodeEntry = {
          doc,
          dirty: false,
          clients: 0,
          permission: { sessionId, mode: 'INSTRUCTOR_ONLY' },
        };
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
