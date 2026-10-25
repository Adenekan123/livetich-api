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
import { WebSocket } from 'ws';
import { AuthCacheService } from '../auth/auth-cache.service';
import type { JwtPayload } from '../auth/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import { PLUGIN_CODE_INSTRUCTION } from '../plugins/catalog';
import { PluginsService } from '../plugins/plugins.service';
import type {
  TunnelClientToServerEvents,
  TunnelServerToClientEvents,
} from '../shared';
import { TunnelService } from './tunnel.service';

interface SocketData {
  user: JwtPayload;
  sessionIds: Set<string>;
  authReady: Promise<boolean>;
}

type TunnelServer = Server<
  TunnelClientToServerEvents,
  TunnelServerToClientEvents,
  never,
  SocketData
>;
type TunnelSocket = Socket<
  TunnelClientToServerEvents,
  TunnelServerToClientEvents,
  never,
  SocketData
>;

/**
 * Tunnel Gateway for localhost port-forwarding (Duckly-like).
 * Maintains WebSocket bridge with host VS Code extensions running local dev servers.
 */
@SkipThrottle()
@WebSocketGateway({ namespace: '/tunnel', cors: { origin: true } })
export class TunnelGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly previewSockets = new Map<
    string,
    { socket: WebSocket; hostSocketId: string }
  >();

  @WebSocketServer()
  server!: TunnelServer;

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly tunnelService: TunnelService,
    private readonly authCache: AuthCacheService,
    private readonly plugins: PluginsService,
  ) {}

  async handleConnection(client: TunnelSocket) {
    client.data.authReady = this.authenticate(client).catch(() => {
      client.disconnect(true);
      return false;
    });
    await client.data.authReady;
  }

  private async authenticate(client: TunnelSocket): Promise<boolean> {
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

    const account = await this.authCache.getState(user.sub);
    if (!account || account.status === UserStatus.DISABLED || !account.emailVerified) {
      client.emit('error', { code: 'FORBIDDEN', message: 'Account not permitted' });
      client.disconnect(true);
      return false;
    }
    return true;
  }

  async handleDisconnect(client: TunnelSocket) {
    for (const [bridgeId, bridge] of this.previewSockets) {
      if (bridge.hostSocketId === client.id) {
        bridge.socket.close(1011, 'Instructor tunnel disconnected');
        this.previewSockets.delete(bridgeId);
      }
    }
    const removed = this.tunnelService.cleanupSocket(client.id);
    for (const r of removed) {
      const ports = this.tunnelService.getPortsForSession(r.sessionId);
      this.server.to(r.sessionId).emit('tunnel:ports', {
        sessionId: r.sessionId,
        ports,
      });
    }
  }

  @SubscribeMessage('tunnel:join')
  async onJoin(
    @ConnectedSocket() client: TunnelSocket,
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

    // Send active ports to joining client
    const ports = this.tunnelService.getPortsForSession(p.sessionId);
    client.emit('tunnel:ports', {
      sessionId: p.sessionId,
      ports,
    });
  }

  @SubscribeMessage('tunnel:leave')
  async onLeave(
    @ConnectedSocket() client: TunnelSocket,
    @MessageBody() p: { sessionId: string },
  ) {
    if (!client.data.sessionIds.delete(p.sessionId)) return;
    await client.leave(p.sessionId);
  }

  @SubscribeMessage('tunnel:register')
  onRegister(
    @ConnectedSocket() client: TunnelSocket,
    @MessageBody()
    p: {
      sessionId: string;
      port: number;
      label?: string;
    },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    const user = client.data.user;
    if (user.role !== Role.INSTRUCTOR && user.role !== Role.ORG_ADMIN) {
      return this.fail(client, 'FORBIDDEN', 'Only instructors can forward ports');
    }

    this.tunnelService.registerPort(
      p.sessionId,
      p.port,
      p.label,
      client.id,
      user.sub,
    );

    const ports = this.tunnelService.getPortsForSession(p.sessionId);
    this.server.to(p.sessionId).emit('tunnel:ports', {
      sessionId: p.sessionId,
      ports,
    });
  }

  @SubscribeMessage('tunnel:unregister')
  onUnregister(
    @ConnectedSocket() client: TunnelSocket,
    @MessageBody() p: { sessionId: string; port: number },
  ) {
    if (!this.inRoom(client, p.sessionId)) return;
    this.tunnelService.unregisterPort(p.sessionId, p.port);

    const ports = this.tunnelService.getPortsForSession(p.sessionId);
    this.server.to(p.sessionId).emit('tunnel:ports', {
      sessionId: p.sessionId,
      ports,
    });
  }

  @SubscribeMessage('tunnel:response:headers')
  onHeaders(
    @MessageBody()
    p: {
      reqId: string;
      statusCode: number;
      headers: Record<string, string | string[]>;
    },
  ) {
    this.tunnelService.handleResponseHeaders(p.reqId, p.statusCode, p.headers);
  }

  @SubscribeMessage('tunnel:response:chunk')
  onChunk(
    @MessageBody()
    p: {
      reqId: string;
      chunk: string;
      isBase64?: boolean;
    },
  ) {
    this.tunnelService.handleResponseChunk(p.reqId, p.chunk, p.isBase64);
  }

  @SubscribeMessage('tunnel:response:end')
  onEnd(@MessageBody() p: { reqId: string }) {
    this.tunnelService.handleResponseEnd(p.reqId);
  }

  @SubscribeMessage('tunnel:response:error')
  onError(@MessageBody() p: { reqId: string; message: string }) {
    this.tunnelService.handleResponseError(p.reqId, p.message);
  }

  @SubscribeMessage('tunnel:ws:ready')
  onPreviewWsReady(
    @ConnectedSocket() client: TunnelSocket,
    @MessageBody() p: { bridgeId: string; ok: boolean; message?: string },
  ) {
    const bridge = this.previewSockets.get(p.bridgeId);
    if (!bridge || bridge.hostSocketId !== client.id || p.ok) return;
    bridge.socket.close(1011, 'The instructor app could not open this WebSocket');
    this.previewSockets.delete(p.bridgeId);
  }

  @SubscribeMessage('tunnel:ws:message')
  onPreviewWsMessage(
    @ConnectedSocket() client: TunnelSocket,
    @MessageBody() p: { bridgeId: string; data: string; isBinary: boolean },
  ) {
    const bridge = this.previewSockets.get(p.bridgeId);
    if (!bridge || bridge.hostSocketId !== client.id || bridge.socket.readyState !== WebSocket.OPEN) return;
    if (bridge.socket.bufferedAmount > 1024 * 1024) {
      bridge.socket.close(1013, 'Preview is sending data too quickly');
      this.previewSockets.delete(p.bridgeId);
      return;
    }
    bridge.socket.send(Buffer.from(p.data, 'base64'), { binary: p.isBinary });
  }

  @SubscribeMessage('tunnel:ws:closed')
  onPreviewWsClosed(
    @ConnectedSocket() client: TunnelSocket,
    @MessageBody() p: { bridgeId: string; code: number; reason?: string },
  ) {
    const bridge = this.previewSockets.get(p.bridgeId);
    if (!bridge || bridge.hostSocketId !== client.id) return;
    this.previewSockets.delete(p.bridgeId);
    if (bridge.socket.readyState === WebSocket.OPEN) {
      bridge.socket.close(this.safeCloseCode(p.code), p.reason?.slice(0, 120));
    }
  }

  // --- Dispatching HTTP request to host extension ---

  sendHttpRequest(
    hostSocketId: string,
    reqPayload: {
      reqId: string;
      port: number;
      method: string;
      path: string;
      query: Record<string, string | string[]>;
      headers: Record<string, string | string[]>;
      body?: string;
      isBase64?: boolean;
    },
  ): void {
    this.server.to(hostSocketId).emit('tunnel:request', reqPayload);
  }

  sendAbort(hostSocketId: string, reqId: string): void {
    this.server.to(hostSocketId).emit('tunnel:abort', { reqId });
  }

  connectPreviewWebSocket(
    hostSocketId: string,
    bridgeId: string,
    port: number,
    path: string,
    socket: WebSocket,
  ): void {
    this.previewSockets.set(bridgeId, { socket, hostSocketId });
    this.server.to(hostSocketId).emit('tunnel:ws:connect', { bridgeId, port, path });
    socket.on('message', (data, isBinary) => {
      this.server.to(hostSocketId).emit('tunnel:ws:message', {
        bridgeId,
        data: Buffer.from(data as Buffer).toString('base64'),
        isBinary,
      });
    });
    socket.on('close', (code, reason) => {
      this.previewSockets.delete(bridgeId);
      this.server.to(hostSocketId).emit('tunnel:ws:close', {
        bridgeId,
        code: this.safeCloseCode(code),
        reason: reason.toString('utf8').slice(0, 120),
      });
    });
    socket.on('error', () => {
      if (socket.readyState === WebSocket.OPEN) socket.close(1011, 'Preview WebSocket failed');
    });
  }

  private inRoom(client: TunnelSocket, sessionId: string): boolean {
    if (client.data.sessionIds?.has(sessionId)) return true;
    this.fail(client, 'NOT_IN_ROOM', 'Join the tunnel room first');
    return false;
  }

  private safeCloseCode(code: number): number {
    return [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) ||
      (code >= 3000 && code <= 4999)
      ? code
      : 1000;
  }

  private fail(client: TunnelSocket, code: string, message: string) {
    client.emit('error', { code, message });
  }
}
