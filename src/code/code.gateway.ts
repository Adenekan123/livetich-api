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
  CodeFileTreeNode,
  CodeFocusPayload,
  CodePermissionPayload,
  CodePointerPayload,
  CodeSpotlightPayload,
  CodeServerToClientEvents,
} from '../shared';
import { CodeDocService } from './code-doc.service';

interface SocketData {
  user: JwtPayload;
  sessionIds: Set<string>;
  authReady: Promise<boolean>;
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
      client.emit('code:focus', focus);
    }

    const expanded = this.docs.getFoldersState(p.sessionId);
    if (expanded) {
      client.emit('code:folders-state', { sessionId: p.sessionId, expanded });
    }
  }

  @SubscribeMessage('code:leave')
  async onLeave(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!client.data.sessionIds.delete(p.sessionId)) return;
    await client.leave(p.sessionId);
    await this.docs.release(p.sessionId);
  }

  @SubscribeMessage('code:update')
  onUpdate(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; update: BoardBinary },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!this.docs.canWrite(p.sessionId, client.data.user)) {
      return this.fail(client, 'FORBIDDEN', 'The code editor is currently read-only for you');
    }
    const update = this.toBytes(p.update);
    if (!update?.length) return;
    this.docs.applyUpdate(p.sessionId, update);
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
    if (!update?.length) return;
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
    if (!this.docs.canWrite(p.sessionId, client.data.user)) {
      return this.fail(client, 'FORBIDDEN', 'Unauthorized to modify workspace tree');
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
    this.docs.setFocus(p.sessionId, p);
    client.to(p.sessionId).emit('code:focus', p);
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
    if (!this.inRoom(client, p.sessionId)) return;
    if (!this.docs.canWrite(p.sessionId, client.data.user)) {
      return this.fail(client, 'FORBIDDEN', 'The code editor is currently read-only for you');
    }
    this.docs.setFileContent(p.sessionId, p.path, p.content);
    client.to(p.sessionId).emit('code:edit', p);
  }

  @SubscribeMessage('code:scroll')
  onScroll(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; path: string; line: number },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    client.to(p.sessionId).emit('code:scroll', p);
  }

  @SubscribeMessage('code:folder-toggle')
  onFolderToggle(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; path: string; collapsed: boolean },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    client.to(p.sessionId).emit('code:folder-toggle', p);
  }

  @SubscribeMessage('code:collapse-all')
  onCollapseAll(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; collapsed: boolean },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    client.to(p.sessionId).emit('code:collapse-all', p);
  }

  @SubscribeMessage('code:folders-state')
  onFoldersState(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: { sessionId: string; expanded: string[] },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    this.docs.setFoldersState(p.sessionId, p.expanded);
    client.to(p.sessionId).emit('code:folders-state', p);
  }

  @SubscribeMessage('code:pointer')
  onPointer(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: CodePointerPayload,
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    client.to(p.sessionId).emit('code:pointer', p);
  }

  @SubscribeMessage('code:spotlight')
  onSpotlight(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: CodeSpotlightPayload,
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    client.to(p.sessionId).emit('code:spotlight', p);
  }

  @SubscribeMessage('code:permission')
  onPermission(
    @ConnectedSocket() client: CodeSocket,
    @MessageBody() p: CodePermissionPayload,
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    const user = client.data.user;
    if (user.role !== Role.INSTRUCTOR && user.role !== Role.ORG_ADMIN) {
      return this.fail(client, 'FORBIDDEN', 'Only instructors can change editing permissions');
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
      all?: boolean;
    },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    client.to(p.sessionId).emit('code:tab-close', p);
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

  private fail(client: CodeSocket, code: string, message: string) {
    client.emit('error', { code, message });
  }
}

