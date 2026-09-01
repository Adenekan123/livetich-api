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
import type {
  BoardBinary,
  BoardClientToServerEvents,
  BoardServerToClientEvents,
} from '../shared';
import { BoardDocService } from './board-doc.service';

interface SocketData {
  user: JwtPayload;
  sessionIds: Set<string>;
  /** An org admin who joined in teach-mode (solo teacher): treated as the
   *  presenter (writer) rather than a read-only observer. Mirrors RoomGateway. */
  teaching?: boolean;
  /** Resolves once the account gate has run (see RoomGateway). board:join awaits
   *  this so a message racing the async check can't slip past. */
  authReady: Promise<boolean>;
}

type BoardServer = Server<
  BoardClientToServerEvents,
  BoardServerToClientEvents,
  never,
  SocketData
>;
type BoardSocket = Socket<
  BoardClientToServerEvents,
  BoardServerToClientEvents,
  never,
  SocketData
>;

/**
 * Yjs chalkboard sync. Separate namespace so binary doc traffic stays off
 * the main room socket. The instructor is the only writer; students receive
 * the doc read-only (feature: chalkboard view).
 */
// See RoomGateway: the HTTP ThrottlerGuard 500s on socket messages, so skip it.
@SkipThrottle()
@WebSocketGateway({ namespace: '/board', cors: { origin: true } })
export class BoardGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: BoardServer;

  /** Sessions where the instructor has opened the board for students to draw. */
  private readonly writable = new Set<string>();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly docs: BoardDocService,
    private readonly authCache: AuthCacheService,
  ) {}

  async handleConnection(client: BoardSocket) {
    // See RoomGateway: verify synchronously (identity ready before the first
    // await) and stash the account-gate promise so board:join can await it.
    client.data.authReady = this.authenticate(client).catch(() => {
      client.disconnect(true);
      return false;
    });
    await client.data.authReady;
  }

  private async authenticate(client: BoardSocket): Promise<boolean> {
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

    const account = await this.authCache.getState(user.sub);
    if (!account || account.status === UserStatus.DISABLED || !account.emailVerified) {
      client.emit('error', { code: 'FORBIDDEN', message: 'Account not permitted' });
      client.disconnect(true);
      return false;
    }
    return true;
  }

  async handleDisconnect(client: BoardSocket) {
    for (const sessionId of client.data.sessionIds ?? []) {
      // When the last client leaves, drop the "students may draw" flag too, so
      // it can't leak into a later class on the same session (or grow forever).
      if (await this.docs.release(sessionId)) this.writable.delete(sessionId);
    }
  }

  @SubscribeMessage('board:join')
  async onJoin(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody() p: { sessionId: string; as?: 'teach' },
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
    // A teach-mode admin presents like the instructor; a plain admin observes
    // read-only. Everyone else is an instructor-owner or an enrolled student.
    const isAdmin = user.role === Role.ORG_ADMIN;
    const teaching = isAdmin && p.as === 'teach';
    client.data.teaching = teaching;
    if (user.role === Role.INSTRUCTOR) {
      if (session.course.instructorId !== user.sub) {
        return this.fail(client, 'FORBIDDEN', 'Not your session');
      }
    } else if (isAdmin) {
      if (session.course.organizationId !== user.organizationId) {
        return this.fail(client, 'FORBIDDEN', 'Not your session');
      }
    } else {
      // Enrolled students may attach to a scheduled session's board (read-only)
      // and stay synced when it goes live — see RoomGateway.onJoin.
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

    const state = this.docs.encodeState(p.sessionId);
    if (state) {
      client.emit('board:state', {
        sessionId: p.sessionId,
        update: Buffer.from(state),
      });
    }
    // Tell the joiner whether students may currently draw.
    client.emit('board:writable', {
      sessionId: p.sessionId,
      open: this.writable.has(p.sessionId),
    });
  }

  /** Instructor opens/closes the board for student drawing ("come to the
   *  board"). Broadcast so every client flips its editor read-only state. */
  @SubscribeMessage('board:writable')
  onWritable(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody() p: { sessionId: string; open: boolean },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!this.canPresent(client)) return;
    if (p.open) this.writable.add(p.sessionId);
    else this.writable.delete(p.sessionId);
    this.server
      .to(p.sessionId)
      .emit('board:writable', { sessionId: p.sessionId, open: p.open });
  }

  @SubscribeMessage('board:leave')
  async onLeave(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!client.data.sessionIds.delete(p.sessionId)) return;
    await client.leave(p.sessionId);
    if (await this.docs.release(p.sessionId)) this.writable.delete(p.sessionId);
  }

  @SubscribeMessage('board:update')
  onUpdate(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody() p: { sessionId: string; update: BoardBinary },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    // Presenter (instructor / teach-mode admin) always writes; students only
    // while the board is opened.
    if (!this.canPresent(client) && !this.writable.has(p.sessionId)) {
      return this.fail(client, 'FORBIDDEN', 'The board is read-only');
    }
    const update = this.toBytes(p.update);
    if (!update?.length) return;
    this.docs.applyUpdate(p.sessionId, update);
    client.to(p.sessionId).emit('board:update', {
      sessionId: p.sessionId,
      update: Buffer.from(update),
    });
  }

  /** Presenter tools: the instructor's live camera + pointer, relayed to the
   *  room so students can follow the view and see the laser. Ephemeral — never
   *  persisted to the board doc. Only the instructor broadcasts. */
  @SubscribeMessage('board:presenter')
  onPresenter(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody()
    p: {
      sessionId: string;
      camera: { x: number; y: number; z: number };
      cursor: { x: number; y: number } | null;
      page?: string;
      bounds?: { x: number; y: number; w: number; h: number };
    },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!this.canPresent(client)) return;
    client.to(p.sessionId).emit('board:presenter', {
      sessionId: p.sessionId,
      camera: p.camera,
      cursor: p.cursor,
      page: p.page,
      bounds: p.bounds,
    });
  }

  @SubscribeMessage('board:awareness')
  onAwareness(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody() p: { sessionId: string; update: BoardBinary },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    const update = this.toBytes(p.update);
    if (!update?.length) return;
    client.to(p.sessionId).emit('board:awareness', {
      sessionId: p.sessionId,
      update: Buffer.from(update),
    });
  }

  private toBytes(data: BoardBinary): Uint8Array | null {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return null;
  }

  private inRoom(client: BoardSocket, sessionId: string): boolean {
    if (client.data.sessionIds?.has(sessionId)) return true;
    this.fail(client, 'NOT_IN_ROOM', 'Join the board first');
    return false;
  }

  /** Whether this socket may drive the board (write shapes, open it for students,
   *  broadcast the presenter view): the owning instructor or a teach-mode admin.
   *  A plain (shadow) admin and un-invited students stay read-only. */
  private canPresent(client: BoardSocket): boolean {
    return (
      client.data.user.role === Role.INSTRUCTOR ||
      client.data.teaching === true
    );
  }

  private fail(client: BoardSocket, code: string, message: string) {
    client.emit('error', { code, message });
  }
}
