import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as Y from 'yjs';
import { OBJECT_STORAGE } from '../storage/object-storage';
import type { ObjectStorage } from '../storage/object-storage';

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
const MAX_CODE_FILES = 500;
const MAX_CODE_FILE_BYTES = 1024 * 1024;
const MAX_CODE_TEXT_BYTES = 20 * 1024 * 1024;
// Yjs retains deleted structs while clients are connected, so serialized state
// can be much larger than the visible source text until the room is compacted.
const MAX_CODE_DOC_BYTES = 128 * 1024 * 1024;

function isSafeDocumentPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  return normalized.length > 0 && normalized.length <= 512 &&
    !normalized.startsWith('/') && !/^[a-z]:/i.test(normalized) &&
    !normalized.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isProtectedCodePath(value: string): boolean {
  const segments = value.replace(/\\/g, '/').toLowerCase().split('/');
  if (segments.some((segment) => ['.aws', '.ssh', '.secrets', '.docker', 'secrets'].includes(segment))) return true;
  const fileName = segments[segments.length - 1] ?? '';
  if (fileName === '.env.example' || fileName === '.env.sample' || fileName === '.env.template') return false;
  return (
    fileName === '.env' ||
    fileName.startsWith('.env.') ||
    fileName === '.npmrc' ||
    fileName === '.netrc' ||
    fileName === 'credentials' ||
    fileName === 'credentials.json' ||
    fileName === 'secrets.json' ||
    fileName.endsWith('.pem') ||
    fileName.endsWith('.key') ||
    fileName.endsWith('.p12') ||
    fileName.endsWith('.pfx') ||
    fileName.startsWith('id_rsa') ||
    fileName.startsWith('id_ed25519')
  );
}

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
    const compacted = this.sanitizeProtectedBuffers(entry.doc, true);
    entry.doc = compacted.doc;
    if (compacted.changed) entry.dirty = true;
    await this.flush(sessionId, entry);
    entry.doc.destroy();
    this.docsBySession.delete(sessionId);
  }

  applyUpdate(sessionId: string, update: Uint8Array): boolean {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return false;
    // Validate on an isolated candidate so a rejected update cannot mutate the live room doc.
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(entry.doc));
      Y.applyUpdate(candidate, update);
      let fileCount = 0;
      let totalFileBytes = 0;
      // Y.applyUpdate creates generic AbstractType roots. Materialize each root
      // with the schema's expected Yjs type before validating it.
      for (const name of candidate.share.keys()) {
        if (name === 'meta' || name === 'file:initialized') {
          candidate.getMap(name);
        } else if (name.startsWith('file:')) {
          candidate.getText(name);
        }
      }
      for (const [name, shared] of candidate.share) {
        if (name === 'meta') {
          if (!(shared instanceof Y.Map) || shared.size > 8) throw new Error('Invalid code metadata type');
          let metadataBytes = 0;
          shared.forEach((value, key) => {
            if (key !== 'lang' || typeof value !== 'string' || value.length > 32) throw new Error('Invalid code metadata');
            metadataBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8');
          });
          if (metadataBytes > 256) throw new Error('Code metadata quota exceeded');
          continue;
        }
        if (name === 'file:initialized') {
          if (!(shared instanceof Y.Map) || shared.size > MAX_CODE_FILES) throw new Error('Invalid file metadata type');
          shared.forEach((value, path) => {
            if (!isSafeDocumentPath(path) || isProtectedCodePath(path) || value !== true) {
              throw new Error('Invalid file metadata');
            }
          });
          continue;
        }
        if (!name.startsWith('file:')) throw new Error('Unsupported shared document type');
        const path = name.slice('file:'.length);
        // The browser editor can instantiate `file:` while no workspace file is
        // selected. It is an empty placeholder root, not a file to synchronize.
        if (path === '' && shared instanceof Y.Text && shared.length === 0) continue;
        if (!isSafeDocumentPath(path)) throw new Error('Invalid file path');
        if (isProtectedCodePath(path)) throw new Error('Protected file path');
        if (!(shared instanceof Y.Text)) throw new Error('Invalid file buffer type');
        fileCount += 1;
        const fileBytes = Buffer.byteLength(shared.toString(), 'utf8');
        totalFileBytes += fileBytes;
        if (fileCount > MAX_CODE_FILES || fileBytes > MAX_CODE_FILE_BYTES || totalFileBytes > MAX_CODE_TEXT_BYTES) {
          throw new Error('Shared code document quota exceeded');
        }
      }
      if (Y.encodeStateAsUpdate(candidate).byteLength > MAX_CODE_DOC_BYTES) {
        throw new Error('Shared code document quota exceeded');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown validation error';
      this.logger.warn(`Rejected code update for session ${sessionId}: ${reason}`);
      candidate.destroy();
      return false;
    }
    entry.doc.destroy();
    entry.doc = candidate;
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
    const perm = this.getPermission(sessionId);
    if (perm.mode === 'OPEN') {
      return true;
    }
    if (perm.mode === 'DELEGATED' && perm.delegatedUserIds?.includes(user.sub)) {
      return true;
    }
    return false;
  }

  seedFileContent(sessionId: string, path: string, content: string): Uint8Array | null {
    const entry = this.docsBySession.get(sessionId);
    if (!entry) return null;
    if (!isSafeDocumentPath(path) || isProtectedCodePath(path) || Buffer.byteLength(content, 'utf8') > MAX_CODE_FILE_BYTES) return null;

    const candidate = new Y.Doc();
    let update: Uint8Array;
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(entry.doc));
      const stateVector = Y.encodeStateVector(candidate);
      const initialized = candidate.getMap<boolean>('file:initialized');
      if (initialized.get(path)) return null;
      const yText = candidate.getText(`file:${path}`);
      candidate.transact(() => {
        if (yText.length === 0 && content.length > 0) yText.insert(0, content);
        initialized.set(path, true);
      }, 'file-seed');
      update = Y.encodeStateAsUpdate(candidate, stateVector);
    } catch {
      return null;
    } finally {
      candidate.destroy();
    }
    if (!update.length || !this.applyUpdate(sessionId, update)) return null;
    return update;
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
        let doc = new Y.Doc();
        const snapshot = await this.storage.get(codeKey(sessionId));
        if (snapshot) Y.applyUpdate(doc, snapshot);
        // No clients are attached yet, so compact old Yjs tombstones and sanitize
        // snapshots before the initial state is sent to a joining editor.
        const sanitized = this.sanitizeProtectedBuffers(doc, true);
        doc = sanitized.doc;
        const entry: CodeEntry = {
          doc,
          dirty: sanitized.changed,
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

  private sanitizeProtectedBuffers(doc: Y.Doc, forceCompact = false): { doc: Y.Doc; changed: boolean } {
    const protectedPaths = new Set<string>();
    let changed = false;
    let fileCount = 0;
    let totalFileBytes = 0;
    // Persisted Yjs updates also decode named roots as AbstractType until the
    // corresponding typed getter is called.
    for (const name of doc.share.keys()) {
      if (name === 'meta' || name === 'file:initialized') {
        doc.getMap(name);
      } else if (name.startsWith('file:')) {
        doc.getText(name);
      }
    }
    for (const [name, shared] of doc.share) {
      if (name === 'meta') {
        if (!(shared instanceof Y.Map)) changed = true;
        else shared.forEach((value, key) => {
          if (key !== 'lang' || typeof value !== 'string' || value.length > 32) changed = true;
        });
      } else if (name === 'file:initialized') {
        if (!(shared instanceof Y.Map)) changed = true;
        else shared.forEach((value, key) => {
          if (!isSafeDocumentPath(key) || isProtectedCodePath(key) || value !== true) {
            protectedPaths.add(key);
            changed = true;
          }
        });
      } else if (name.startsWith('file:')) {
        const filePath = name.slice('file:'.length);
        if (!isSafeDocumentPath(filePath) || isProtectedCodePath(filePath) || !(shared instanceof Y.Text)) {
          protectedPaths.add(filePath);
          changed = true;
          continue;
        }
        fileCount += 1;
        const fileBytes = Buffer.byteLength(shared.toString(), 'utf8');
        totalFileBytes += fileBytes;
        if (fileCount > MAX_CODE_FILES || fileBytes > MAX_CODE_FILE_BYTES || totalFileBytes > MAX_CODE_TEXT_BYTES) {
          protectedPaths.add(filePath);
          changed = true;
        }
      } else {
        changed = true;
      }
    }
    if (protectedPaths.size === 0 && !changed && !forceCompact) return { doc, changed: false };

    const compacted = new Y.Doc();
    for (const [name, shared] of doc.share) {
      if (name.startsWith('file:') && name !== 'file:initialized') {
        const filePath = name.slice('file:'.length);
        if (protectedPaths.has(filePath) || !(shared instanceof Y.Text)) continue;
        const content = shared.toString();
        if (content) compacted.getText(name).insert(0, content);
      } else if (name === 'meta' && shared instanceof Y.Map) {
        const target = compacted.getMap<unknown>(name);
        shared.forEach((value, key) => {
          if (key === 'lang' && typeof value === 'string' && value.length <= 32) {
            target.set(key, value);
          }
        });
      } else if (name === 'file:initialized' && shared instanceof Y.Map) {
        const target = compacted.getMap<boolean>(name);
        shared.forEach((value, key) => {
          if (!protectedPaths.has(key) && isSafeDocumentPath(key) && value === true) target.set(key, true);
        });
      }
    }
    doc.destroy();
    return { doc: compacted, changed: true };
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
