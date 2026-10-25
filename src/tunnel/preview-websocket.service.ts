import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role, SessionStatus, UserStatus } from '@prisma/client';
import type { IncomingMessage, Server as HttpServer } from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import { AuthCacheService } from '../auth/auth-cache.service';
import type { JwtPayload } from '../auth/jwt-payload';
import { PrismaService } from '../prisma/prisma.service';
import { TunnelGateway } from './tunnel.gateway';
import { TunnelService } from './tunnel.service';

@Injectable()
export class PreviewWebSocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PreviewWebSocketService.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  private httpServer?: HttpServer;

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly authCache: AuthCacheService,
    private readonly tunnel: TunnelService,
    private readonly gateway: TunnelGateway,
  ) {}

  onModuleInit() {
    this.httpServer = this.adapterHost.httpAdapter.getHttpServer() as HttpServer;
    this.httpServer.on('upgrade', this.handleUpgrade);
  }

  onModuleDestroy() {
    this.httpServer?.off('upgrade', this.handleUpgrade);
    this.wss.close();
  }

  private readonly handleUpgrade = (req: IncomingMessage, socket: import('net').Socket, head: Buffer) => {
    void this.acceptUpgrade(req, socket, head).catch((error: unknown) => {
      this.logger.warn(`Preview WebSocket rejected: ${String(error)}`);
      this.reject(socket, 502, 'Preview WebSocket failed');
    });
  };

  private async acceptUpgrade(req: IncomingMessage, socket: import('net').Socket, head: Buffer) {
    const hostname = (req.headers.host ?? '').split(':')[0].toLowerCase();
    const previewDomain = process.env.PREVIEW_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    let subdomain: string | undefined;
    if (previewDomain && hostname.endsWith(`.${previewDomain}`)) {
      subdomain = hostname.slice(0, -(previewDomain.length + 1));
    } else if (process.env.NODE_ENV !== 'production' && hostname.endsWith('.localhost')) {
      subdomain = hostname.slice(0, -'.localhost'.length);
    }
    const match = subdomain?.match(/^(.+)-(\d{1,5})$/);
    if (!match) return; // Let Socket.IO or other upgrade handlers handle this request.
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).hostname.toLowerCase() !== hostname) {
          return this.reject(socket, 403, 'Preview origin mismatch');
        }
      } catch {
        return this.reject(socket, 403, 'Invalid preview origin');
      }
    }
    const sessionId = match[1];
    const port = Number(match[2]);
    if (port < 1 || port > 65535) return this.reject(socket, 400, 'Invalid preview port');

    const url = new URL(req.url ?? '/', `http://${hostname}`);
    const token = url.searchParams.get('token') ?? this.cookieToken(req.headers.cookie);
    url.searchParams.delete('token');
    let user: JwtPayload;
    try {
      user = this.jwt.verify<JwtPayload>(token ?? '');
    } catch {
      return this.reject(socket, 401, 'Preview authorization expired');
    }
    if (user.preview && (user.preview.sessionId !== sessionId || user.preview.port !== port)) {
      return this.reject(socket, 403, 'Preview token scope mismatch');
    }
    if (user.recorder) return this.reject(socket, 401, 'Recorder token not allowed');
    const account = await this.authCache.getState(user.sub);
    if (!account || account.status === UserStatus.DISABLED || !account.emailVerified) {
      return this.reject(socket, 403, 'Account is not permitted');
    }

    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: { course: { select: { id: true, instructorId: true, organizationId: true } } },
    });
    if (!session || session.status === SessionStatus.ENDED) return this.reject(socket, 404, 'Session not found');
    if (user.role === Role.INSTRUCTOR) {
      if (session.course.instructorId !== user.sub) return this.reject(socket, 403, 'Not your session');
    } else if (user.role === Role.ORG_ADMIN) {
      if (!user.organizationId || session.course.organizationId !== user.organizationId) {
        return this.reject(socket, 403, 'Not your organisation session');
      }
    } else {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: { courseId_studentId: { courseId: session.course.id, studentId: user.sub } },
        select: { id: true },
      });
      if (!enrollment) return this.reject(socket, 403, 'Not enrolled in course');
    }

    const hostSocketId = this.tunnel.getHostSocketForPort(sessionId, port);
    if (!hostSocketId) return this.reject(socket, 502, 'Instructor preview is offline');
    const path = `${url.pathname}${url.search}`;
    const bridgeId = randomUUID();
    this.wss.handleUpgrade(req, socket, head, (previewSocket) => {
      this.gateway.connectPreviewWebSocket(hostSocketId, bridgeId, port, path, previewSocket);
    });
  }

  private cookieToken(cookieHeader?: string): string | undefined {
    for (const item of cookieHeader?.split(';') ?? []) {
      const [name, ...value] = item.trim().split('=');
      if (name === 'livetich_proxy_token') return decodeURIComponent(value.join('='));
    }
    return undefined;
  }

  private reject(socket: import('net').Socket, status: number, message: string) {
    if (socket.destroyed) return;
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }
}
