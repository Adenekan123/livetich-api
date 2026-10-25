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
  TerminalClientToServerEvents,
  TerminalServerToClientEvents,
  TerminalSessionInfo,
  TerminalWritableMode,
} from '../shared';
import { TerminalService } from './terminal.service';

interface SocketData {
  user: JwtPayload;
  sessionIds: Set<string>;
  authReady: Promise<boolean>;
}

type TerminalServer = Server<
  TerminalClientToServerEvents,
  TerminalServerToClientEvents,
  never,
  SocketData
>;
type TerminalSocket = Socket<
  TerminalClientToServerEvents,
  TerminalServerToClientEvents,
  never,
  SocketData
>;

/**
 * Real-time terminal streaming gateway (Duckly-like).
 * Streams ANSI terminal output from VS Code or web hosts to all students,
 * handles terminal resizing, permission control, and interactive keystroke input.
 */
@SkipThrottle()
@WebSocketGateway({ namespace: '/terminal', cors: { origin: true } })
export class TerminalGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: TerminalServer;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly terminalService: TerminalService,
    private readonly authCache: AuthCacheService,
    private readonly plugins: PluginsService,
  ) {}

  async handleConnection(client: TerminalSocket) {
    client.data.authReady = this.authenticate(client).catch(() => {
      client.disconnect(true);
      return false;
    });
    await client.data.authReady;
  }

  private async authenticate(client: TerminalSocket): Promise<boolean> {
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
    if (user.preview) {
      client.emit('error', { code: 'UNAUTHORIZED', message: 'Preview token cannot join classroom sockets' });
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
      if (packetCount > 150) {
        return; // Drop excessive packets
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

  async handleDisconnect(client: TerminalSocket) {
    const closed = this.terminalService.cleanupSocket(client.id);
    for (const c of closed) {
      this.server.to(c.sessionId).emit('term:closed', {
        sessionId: c.sessionId,
        terminalId: c.terminalId,
      });
    }
  }

  @SubscribeMessage('term:join')
  async onJoin(
    @ConnectedSocket() client: TerminalSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!(await client.data.authReady)) return;
    const user = client.data.user;
    if (client.data.sessionIds.has(p.sessionId)) return;

    const session = await this.prisma.liveSession.findUnique({
      where: { id: p.sessionId },
      include: {
        course: {
          select: { id: true, instructorId: true, organizationId: true, pluginKeys: true },
        },
      },
    });
    if (!session || session.status === SessionStatus.ENDED) {
      return this.fail(client, 'NOT_JOINABLE', 'Session not found or ended');
    }

    if (!(await this.plugins.isEnabledForCourse(session.course, PLUGIN_CODE_INSTRUCTION))) {
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

    await client.join(p.sessionId);
    client.data.sessionIds.add(p.sessionId);

    // Send active terminals with current screen backlog
    const terminals = this.terminalService.getTerminalsForSession(p.sessionId);
    client.emit('term:state', {
      sessionId: p.sessionId,
      terminals,
    });
  }

  @SubscribeMessage('term:leave')
  async onLeave(
    @ConnectedSocket() client: TerminalSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!client.data.sessionIds.delete(p.sessionId)) return;
    await client.leave(p.sessionId);
  }

  @SubscribeMessage('term:open')
  onOpen(
    @ConnectedSocket() client: TerminalSocket,
    @MessageBody() p: { sessionId: string; terminal: TerminalSessionInfo },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    const user = client.data.user;
    if (user.role !== Role.INSTRUCTOR && user.role !== Role.ORG_ADMIN) {
      return this.fail(client, 'FORBIDDEN', 'Only hosts can open a terminal stream');
    }

    this.terminalService.openTerminal(
      p.sessionId,
      p.terminal,
      client.id,
      user.sub,
    );
    client.to(p.sessionId).emit('term:opened', p);
  }

  @SubscribeMessage('term:data')
  onData(
    @ConnectedSocket() client: TerminalSocket,
    @MessageBody()
    p: {
      sessionId: string;
      terminalId: string;
      data: string | Uint8Array;
    },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!this.isTerminalHost(client, p.sessionId, p.terminalId)) return;
    this.terminalService.appendData(p.sessionId, p.terminalId, p.data);
    client.to(p.sessionId).emit('term:data', p);
  }

  @SubscribeMessage('term:resize')
  onResize(
    @ConnectedSocket() client: TerminalSocket,
    @MessageBody()
    p: {
      sessionId: string;
      terminalId: string;
      cols: number;
      rows: number;
    },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!this.isTerminalHost(client, p.sessionId, p.terminalId)) return;
    this.terminalService.resizeTerminal(
      p.sessionId,
      p.terminalId,
      p.cols,
      p.rows,
    );
    client.to(p.sessionId).emit('term:resize', p);
  }

  @SubscribeMessage('term:permission')
  onPermission(
    @ConnectedSocket() client: TerminalSocket,
    @MessageBody()
    p: {
      sessionId: string;
      terminalId: string;
      writableBy: TerminalWritableMode;
      delegatedUserIds?: string[];
    },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!this.isTerminalHost(client, p.sessionId, p.terminalId)) return;
    if (!['INSTRUCTOR_ONLY', 'OPEN', 'DELEGATED'].includes(p.writableBy)) {
      return this.fail(client, 'INVALID_INPUT', 'Unknown terminal permission mode');
    }
    if (p.delegatedUserIds && (p.delegatedUserIds.length > 100 || p.delegatedUserIds.some((id) => typeof id !== 'string' || id.length > 128))) {
      return this.fail(client, 'INVALID_INPUT', 'Terminal delegation list is invalid');
    }
    const user = client.data.user;
    if (user.role !== Role.INSTRUCTOR && user.role !== Role.ORG_ADMIN) {
      return this.fail(client, 'FORBIDDEN', 'Only instructors can change terminal permissions');
    }

    if (!this.terminalService.isSandboxed(p.sessionId, p.terminalId) && p.writableBy !== 'INSTRUCTOR_ONLY') {
      return this.fail(
        client,
        'FORBIDDEN',
        'Shared terminal input is disabled until isolated code execution is available',
      );
    }

    this.terminalService.updatePermission(
      p.sessionId,
      p.terminalId,
      p.writableBy,
      p.delegatedUserIds,
    );
    this.server.to(p.sessionId).emit('term:permission', p);
  }

  @SubscribeMessage('term:stdin')
  onStdin(
    @ConnectedSocket() client: TerminalSocket,
    @MessageBody()
    p: {
      sessionId: string;
      terminalId: string;
      data: string;
    },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (typeof p.data !== 'string' || p.data.length > 4096) {
      return this.fail(client, 'INVALID_INPUT', 'Terminal input must be 4 KB or smaller');
    }
    const user = client.data.user;
    if (!this.terminalService.canSendStdin(p.sessionId, p.terminalId, user, client.id)) {
      return this.fail(client, 'FORBIDDEN', 'Terminal input is currently locked for you');
    }

    const hostSocketId = this.terminalService.getHostSocketId(
      p.sessionId,
      p.terminalId,
    );
    if (hostSocketId) {
      this.server.to(hostSocketId).emit('term:stdin', {
        sessionId: p.sessionId,
        terminalId: p.terminalId,
        data: p.data,
        fromUserId: user.sub,
      });
    }
  }

  @SubscribeMessage('term:close')
  onClose(
    @ConnectedSocket() client: TerminalSocket,
    @MessageBody() p: { sessionId: string; terminalId: string },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    if (!this.isTerminalHost(client, p.sessionId, p.terminalId)) return;
    this.terminalService.closeTerminal(p.sessionId, p.terminalId);
    this.server.to(p.sessionId).emit('term:closed', p);
  }

  private inRoom(client: TerminalSocket, sessionId: string): boolean {
    if (client.data.sessionIds?.has(sessionId)) return true;
    this.fail(client, 'NOT_IN_ROOM', 'Join the terminal room first');
    return false;
  }

  private isTerminalHost(
    client: TerminalSocket,
    sessionId: string,
    terminalId: string,
  ): boolean {
    if (this.terminalService.isHostSocket(sessionId, terminalId, client.id)) return true;
    this.fail(client, 'FORBIDDEN', 'Only the terminal host can publish, resize, change permissions, or close this terminal');
    return false;
  }

  private fail(client: TerminalSocket, code: string, message: string) {
    client.emit('error', { code, message });
  }
}
