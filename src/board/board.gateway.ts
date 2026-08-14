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
      await this.docs.release(sessionId);
    }
  }

  @SubscribeMessage('board:join')
  async onJoin(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!(await client.data.authReady)) return;
    const user = client.data.user;
    if (client.data.sessionIds.has(p.sessionId)) return;

    const session = await this.prisma.liveSession.findUnique({
      where: { id: p.sessionId },
      include: { course: { select: { id: true, instructorId: true } } },
    });
    if (!session || session.status === SessionStatus.ENDED) {
      return this.fail(client, 'NOT_JOINABLE', 'Session not found or ended');
    }
    if (user.role === Role.INSTRUCTOR) {
      if (session.course.instructorId !== user.sub) {
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
  }

  @SubscribeMessage('board:leave')
  async onLeave(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!client.data.sessionIds.delete(p.sessionId)) return;
    await client.leave(p.sessionId);
    await this.docs.release(p.sessionId);
  }

  @SubscribeMessage('board:update')
  onUpdate(
    @ConnectedSocket() client: BoardSocket,
    @MessageBody() p: { sessionId: string; update: BoardBinary },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    // Join already proved ownership for instructors, so role alone gates writes.
    if (client.data.user.role !== Role.INSTRUCTOR) {
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

  private fail(client: BoardSocket, code: string, message: string) {
    client.emit('error', { code, message });
  }
}
