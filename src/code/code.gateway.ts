import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { SkipThrottle } from '@nestjs/throttler';
import { Role, SessionStatus, UserStatus } from '@prisma/client';
import type { Server, Socket } from 'socket.io';
import { AuthCacheService } from '../auth/auth-cache.service';
import type { JwtPayload } from '../auth/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import { PLUGIN_CODE_INSTRUCTION } from '../plugins/catalog';
import { PluginsService } from '../plugins/plugins.service';
import type {
  BoardBinary,
  CodeClientToServerEvents,
  CodeCursorPayload,
  CodeFileTreeNode,
  CodeFocusPayload,
  CodePermissionPayload,
  CodePointerPayload,
  CodeSpotlightPayload,
  CodeServerToClientEvents,
} from '../shared';
import { CodeDocService } from './code-doc.service';

const MAX_CODE_UPDATE_BYTES = 2 * 1024 * 1024;
const MAX_CODE_AWARENESS_BYTES = 64 * 1024;
const MAX_CODE_AWARENESS_EVENTS_PER_SECOND = 25;

function isSafeSeedPath(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) return false;
  const segments = normalized.toLowerCase().split('/');
  if (segments.some((segment) => ['.aws', '.ssh', '.secrets', '.docker', 'secrets'].includes(segment))) return false;
  const fileName = segments[segments.length - 1] ?? '';
  if (fileName === '.env.example' || fileName === '.env.sample' || fileName === '.env.template') return true;
  return !(
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

function isSafeCodePosition(value: unknown): value is { line: number; ch: number } {
  if (typeof value !== 'object' || value === null) return false;
  const position = value as { line?: unknown; ch?: unknown };
  return Number.isSafeInteger(position.line) && Number(position.line) >= 0 && Number(position.line) <= 100_000 &&
    Number.isSafeInteger(position.ch) && Number(position.ch) >= 0 && Number(position.ch) <= 100_000;
}

interface SocketData {
  user: JwtPayload;
  sessionIds: Set<string>;
  controlledSessionIds: Set<string>;
  authReady: Promise<boolean>;
  pointerWindowStartedAt: number;
  pointerEventCount: number;
  cursorWindowStartedAt: number;
  cursorEventCount: number;
  awarenessWindowStartedAt: number;
  awarenessEventCount: number;
  sourceSequences: Map<string, number>;
}

type CodeServer = Server<
  CodeClientToServerEvents,
  CodeServerToClientEvents,
  never,
  SocketData
>;
type CodeSocket = Socket<
  CodeClientToServerEvents,
  CodeServerToClientEvents,
  never,
  SocketData
>;

/**
 * Yjs shared-code-editor & multi-file live collaboration gateway (Duckly-like).
 * Synchronizes collaborative multi-file Yjs documents, active workspace trees,
 * cursor focus for follow-mode, and permission controls across the classroom.
 */
@SkipThrottle()
@WebSocketGateway({ namespace: '/code', cors: { origin: true } })
export class CodeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: CodeServer;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly docs: CodeDocService,
    private readonly authCache: AuthCacheService,
    private readonly plugins: PluginsService,
  ) {}

  async handleConnection(client: CodeSocket) {
    client.data.authReady = this.authenticate(client).catch(() => {
      client.disconnect(true);
      return false;
    });
    await client.data.authReady;
  }

  private async authenticate(client: CodeSocket): Promise<boolean> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      client.handshake.headers.authorization?.split(' ')[1];
    let user: JwtPayload;
    try {
      user = this.jwt.verify<JwtPayload>(token ?? '');
    } catch {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Invalid token' });
      client.disconnect(true);
      return false;
    }
    client.data.user = user;
    client.data.sessionIds = new Set();
    client.data.controlledSessionIds = new Set();
    client.data.pointerWindowStartedAt = Date.now();
    client.data.pointerEventCount = 0;
    client.data.cursorWindowStartedAt = Date.now();
    client.data.cursorEventCount = 0;
    client.data.awarenessWindowStartedAt = Date.now();
    client.data.awarenessEventCount = 0;
    client.data.sourceSequences = new Map();

    let packetCount = 0;
    let windowReset = Date.now();
    client.use((_packet, next) => {
      const now = Date.now();
      if (now - windowReset > 1000) {
        packetCount = 0;
        windowReset = now;
      }
      packetCount++;
      if (packetCount > 100) {
        return; // Drop excess packets silently
      }
      return next();
    });

    const account = await this.authCache.getState(user.sub);
    if (!account || account.status === UserStatus.DISABLED || !account.emailVerified) {
      client.emit('error', { code: 'FORBIDDEN', message: 'Account not permitted' });
      client.disconnect(true);
      return false;
    }
    return true;
  }

  async handleDisconnect(client: CodeSocket) {
    for (const sessionId of client.data.sessionIds ?? []) {
      await this.docs.release(sessionId);
    }
  }

  @SubscribeMessage('code:join')
  async onJoin(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!(await client.data.authReady)) return;
    const user = client.data.user;
    if (client.data.sessionIds.has(p.sessionId)) return;

    const session = await this.prisma.liveSession.findUnique({
      where: { id: p.sessionId },
      include: {
        course: {
          select: { id: true, instructorId: true, organizationId: true },
        },
      },
    });
    if (!session || session.status === SessionStatus.ENDED) {
      return this.fail(client, 'NOT_JOINABLE', 'Session not found or ended');
    }

    if (
      !(await this.plugins.isEnabled(
        session.course.organizationId,
        PLUGIN_CODE_INSTRUCTION,
      ))
    ) {
      return this.fail(client, 'FORBIDDEN', 'Code Instruction is not enabled');
    }

    const isAdmin =
      user.role === Role.ORG_ADMIN || (user.role as string) === 'SUPER_ADMIN';
    if (isAdmin) {
      if (
        session.course.organizationId !== user.organizationId &&
        (user.role as string) !== 'SUPER_ADMIN'
      ) {
        return this.fail(client, 'FORBIDDEN', 'Not your organization');
      }
    } else if (user.role === Role.INSTRUCTOR) {
      if (
        session.course.instructorId !== user.sub &&
        session.course.organizationId !== user.organizationId
      ) {
        return this.fail(client, 'FORBIDDEN', 'Not your session');
      }
    } else {
      const enrolled = await this.prisma.enrollment.findUnique({
        where: {
          courseId_studentId: {
            courseId: session.course.id,
            studentId: user.sub,
          },
        },
        select: { id: true },
      });
      if (!enrolled) return this.fail(client, 'FORBIDDEN', 'Not enrolled');
    }

    await this.docs.retain(p.sessionId);
    await client.join(p.sessionId);
    client.data.sessionIds.add(p.sessionId);
    if (
      session.course.instructorId === user.sub ||
      user.role === Role.ORG_ADMIN ||
      (user.role as string) === 'SUPER_ADMIN'
    ) {
      client.data.controlledSessionIds.add(p.sessionId);
    }

    // Send initial state snapshots to the joining client
    const state = this.docs.encodeState(p.sessionId);
    if (state) {
      client.emit('code:state', {
        sessionId: p.sessionId,
        update: Buffer.from(state),
      });
    }

    client.emit('code:permission', this.docs.getPermission(p.sessionId));

    const tree = this.docs.getTree(p.sessionId);
    if (tree) {
      client.emit('code:tree', { sessionId: p.sessionId, tree });
    }

    const focus = this.docs.getFocus(p.sessionId);
    if (focus) {
      client.emit('code:focus', { ...focus, isSnapshot: true });
    }

    const expanded = this.docs.getFoldersState(p.sessionId);
    if (expanded) {
      client.emit('code:folders-state', { sessionId: p.sessionId, expanded });
    }
    client.emit('code:joined', { sessionId: p.sessionId });
  }

  @SubscribeMessage('code:leave')
  async onLeave(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!client.data.sessionIds.delete(p.sessionId)) return;
    client.data.controlledSessionIds.delete(p.sessionId);
    await client.leave(p.sessionId);
    await this.docs.release(p.sessionId);
  }

  @SubscribeMessage('code:update')
  onUpdate(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; update: BoardBinary },
  ) {
    if (!p || typeof p !== 'object') return;
    if (!this.inRoom(client, p.sessionId)) return;
    if (
      !client.data.controlledSessionIds.has(p.sessionId) &&
      !this.docs.canWrite(p.sessionId, client.data.user)
    ) {
      return this.fail(
        client,
        'FORBIDDEN',
        'The code editor is currently read-only for you',
      );
    }
    const update = this.toBytes(p.update);
    if (!update?.length || update.byteLength > MAX_CODE_UPDATE_BYTES) return;
    if (!this.docs.applyUpdate(p.sessionId, update)) {
      return this.fail(client, 'INVALID_CODE_UPDATE', 'The update contains an invalid or oversized code document');
    }
    client.to(p.sessionId).emit('code:update', {
      sessionId: p.sessionId,
      update: Buffer.from(update),
    });
  }

  @SubscribeMessage('code:awareness')
  onAwareness(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; update: BoardBinary },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    const update = this.toBytes(p.update);
    if (!update?.length || update.byteLength > MAX_CODE_AWARENESS_BYTES) return;
    const now = Date.now();
    if (now - client.data.awarenessWindowStartedAt >= 1000) {
      client.data.awarenessWindowStartedAt = now;
      client.data.awarenessEventCount = 0;
    }
    if (client.data.awarenessEventCount >= MAX_CODE_AWARENESS_EVENTS_PER_SECOND) return;
    client.data.awarenessEventCount += 1;
    client.to(p.sessionId).emit('code:awareness', {
      sessionId: p.sessionId,
      update: Buffer.from(update),
    });
  }

  @SubscribeMessage('code:tree')
  onTree(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; tree: CodeFileTreeNode[] },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) {
      return this.fail(
        client,
        'FORBIDDEN',
        'Only the session instructor can modify the workspace tree',
      );
    }
    this.docs.setTree(p.sessionId, p.tree);
    client.to(p.sessionId).emit('code:tree', p);
  }

  @SubscribeMessage('code:focus')
  onFocus(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: CodeFocusPayload,
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) {
      return this.fail(
        client,
        'FORBIDDEN',
        'Only the session instructor can control mirrored focus',
      );
    }
    if (
      typeof p.path !== 'string' || p.path.length > 512 ||
      (p.path !== '' && !isSafeSeedPath(p.path)) ||
      (p.openFiles !== undefined && (!Array.isArray(p.openFiles) || p.openFiles.length > 1000 || p.openFiles.some((file) => typeof file !== 'string' || !isSafeSeedPath(file)))) ||
      (p.cursor !== undefined && !isSafeCodePosition(p.cursor)) ||
      (p.selection !== undefined && (!p.selection || !isSafeCodePosition(p.selection.anchor) || !isSafeCodePosition(p.selection.active)))
    ) return;
    const focus = {
      ...p,
      controllerUserId: client.data.user.sub,
      isSnapshot: false,
    };
    this.docs.setFocus(p.sessionId, focus);
    client.to(p.sessionId).emit('code:focus', focus);
  }

  @SubscribeMessage('code:cursor')
  onCursor(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: CodeCursorPayload,
  ) {
    if (!p || typeof p !== 'object' || !this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) return;
    if (
      typeof p.path !== 'string' || !isSafeSeedPath(p.path) ||
      typeof p.sourceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(p.sourceId) ||
      !Number.isSafeInteger(p.sequence) || p.sequence < 1 ||
      !isSafeCodePosition(p) ||
      (p.selection !== undefined && (!p.selection || !isSafeCodePosition(p.selection.anchor) || !isSafeCodePosition(p.selection.active)))
    ) return;
    if (!this.acceptSourceSequence(client, p.sourceId, p.sequence)) return;
    const now = Date.now();
    if (now - client.data.cursorWindowStartedAt >= 1000) {
      client.data.cursorWindowStartedAt = now;
      client.data.cursorEventCount = 0;
    }
    if (client.data.cursorEventCount >= 25) return;
    client.data.cursorEventCount += 1;
    client.to(p.sessionId).emit('code:cursor', {
      ...p,
      controllerUserId: client.data.user.sub,
    });
  }

  @SubscribeMessage('code:edit')
  onEdit(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody()
    p: {
      sessionId: string;
      path: string;
      content: string;
      cursor?: { line: number; ch: number };
    },
  ) {
    if (!p || typeof p !== 'object') return;
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) {
      return this.fail(client, 'FORBIDDEN', 'The code editor is currently read-only for you');
    }
    if (
      typeof p.path !== 'string' ||
      !isSafeSeedPath(p.path) ||
      typeof p.content !== 'string' ||
      Buffer.byteLength(p.content, 'utf8') > 1024 * 1024
    ) return;
    const update = this.docs.seedFileContent(p.sessionId, p.path, p.content);
    if (update?.length) {
      this.server.to(p.sessionId).emit('code:update', {
        sessionId: p.sessionId,
        update: Buffer.from(update),
      });
    }
  }

  @SubscribeMessage('code:scroll')
  onScroll(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; path: string; line: number },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) return;
    client.to(p.sessionId).emit('code:scroll', p);
  }

  @SubscribeMessage('code:folder-toggle')
  onFolderToggle(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; path: string; collapsed: boolean },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) return;
    client.to(p.sessionId).emit('code:folder-toggle', p);
  }

  @SubscribeMessage('code:collapse-all')
  onCollapseAll(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; collapsed: boolean },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) return;
    client.to(p.sessionId).emit('code:collapse-all', p);
  }

  @SubscribeMessage('code:folders-state')
  onFoldersState(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; expanded: string[] },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) return;
    this.docs.setFoldersState(p.sessionId, p.expanded);
    client.to(p.sessionId).emit('code:folders-state', p);
  }

  @SubscribeMessage('code:pointer')
  onPointer(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: CodePointerPayload,
  ) {
    if (!p || typeof p !== 'object' || !this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) return;
    if (p.surface === 'editor') {
      if (
        typeof p.path !== 'string' || !isSafeSeedPath(p.path) ||
        typeof p.sourceId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(p.sourceId) ||
        !Number.isSafeInteger(p.sequence) || (p.sequence ?? 0) < 1 ||
        !isSafeCodePosition(p) ||
        (p.kind !== 'move' && p.kind !== 'click')
      ) return;
      if (!this.acceptSourceSequence(client, p.sourceId!, p.sequence!)) return;
      const now = Date.now();
      if (now - client.data.pointerWindowStartedAt >= 1000) {
        client.data.pointerWindowStartedAt = now;
        client.data.pointerEventCount = 0;
      }
      if (p.kind === 'move' && client.data.pointerEventCount >= 25) return;
      client.data.pointerEventCount += 1;
      client.to(p.sessionId).emit('code:pointer', {
        sessionId: p.sessionId,
        controllerUserId: client.data.user.sub,
        sourceId: p.sourceId,
        sequence: p.sequence,
        path: p.path,
        surface: 'editor',
        kind: p.kind,
        line: p.line,
        ch: p.ch,
        isClick: p.kind === 'click',
      });
      return;
    }
    if (p.surface !== 'sidebar' || typeof p.target !== 'string' || p.target.length > 512 || !isSafeSeedPath(p.target)) return;
    client.to(p.sessionId).emit('code:pointer', {
      sessionId: p.sessionId,
      controllerUserId: client.data.user.sub,
      target: p.target,
      isFolder: Boolean(p.isFolder),
      surface: 'sidebar',
      isClick: Boolean(p.isClick),
    });
  }

  @SubscribeMessage('code:spotlight')
  onSpotlight(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: CodeSpotlightPayload,
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) return;
    client.to(p.sessionId).emit('code:spotlight', p);
  }

  @SubscribeMessage('code:permission')
  onPermission(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: CodePermissionPayload,
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) {
      return this.fail(
        client,
        'FORBIDDEN',
        'Only the session instructor can change editing permissions',
      );
    }
    this.docs.setPermission(p.sessionId, p);
    this.server.to(p.sessionId).emit('code:permission', p);
  }

  @SubscribeMessage('code:tab-close')
  onTabClose(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody()
    p: {
      sessionId: string;
      path?: string;
      nextActive?: string;
      openFiles?: string[];
      requestId?: string;
      all?: boolean;
    },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) {
      return this.fail(
        client,
        'FORBIDDEN',
        'Only the session instructor can control mirrored tabs',
      );
    }
    if (
      (p.openFiles !== undefined &&
        (!Array.isArray(p.openFiles) || p.openFiles.length > 1000 || p.openFiles.some((file) => typeof file !== 'string' || file.length > 512))) ||
      (p.requestId !== undefined && (typeof p.requestId !== 'string' || p.requestId.length > 128))
    ) return;
    const payload = { ...p, controllerUserId: client.data.user.sub };
    this.docs.setFocus(p.sessionId, {
      sessionId: p.sessionId,
      path: p.nextActive ?? '',
      openFiles: p.openFiles ?? [],
      controllerUserId: client.data.user.sub,
    });
    client.to(p.sessionId).emit('code:tab-close', payload);
  }

  @SubscribeMessage('code:tab-close-result')
  onTabCloseResult(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody()
    p: { sessionId: string; requestId: string; activePath: string; openFiles: string[] },
  ) {
    if (typeof p?.sessionId !== 'string' || p.sessionId.length > 128) return;
    if (!this.inRoom(client, p.sessionId)) return;
    if (!client.data.controlledSessionIds.has(p.sessionId)) return;
    if (
      typeof p.requestId !== 'string' ||
      p.requestId.length > 128 ||
      typeof p.activePath !== 'string' ||
      p.activePath.length > 512 ||
      !Array.isArray(p.openFiles) ||
      p.openFiles.length > 1000 ||
      p.openFiles.some((file) => typeof file !== 'string' || file.length > 512)
    ) return;
    client.to(p.sessionId).emit('code:tab-close-result', {
      sessionId: p.sessionId,
      requestId: p.requestId,
      activePath: p.activePath,
      openFiles: p.openFiles,
      controllerUserId: client.data.user.sub,
    });
  }

  private toBytes(data: BoardBinary): Uint8Array | null {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    const d = data as unknown;
    if (ArrayBuffer.isView(d)) {
      const view = d as ArrayBufferView;
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (Array.isArray(d)) return Uint8Array.from(d as number[]);
    if (
      typeof d === 'object' &&
      d !== null &&
      Array.isArray((d as { data?: unknown }).data)
    ) {
      return Uint8Array.from((d as { data: number[] }).data);
    }
    return null;
  }

  private inRoom(client: CodeSocket, sessionId: string): boolean {
    if (client.data.sessionIds?.has(sessionId)) return true;
    this.fail(client, 'NOT_IN_ROOM', 'Join the code editor first');
    return false;
  }

  private acceptSourceSequence(client: CodeSocket, sourceId: string, sequence: number): boolean {
    const previous = client.data.sourceSequences.get(sourceId) ?? 0;
    if (sequence <= previous) return false;
    if (previous === 0 && client.data.sourceSequences.size >= 16) return false;
    client.data.sourceSequences.set(sourceId, sequence);
    return true;
  }

  private fail(client: CodeSocket, code: string, message: string) {
    client.emit('error', { code, message });
  }
}

