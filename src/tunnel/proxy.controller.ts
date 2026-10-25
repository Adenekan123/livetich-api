import {
  All,
  Controller,
  Logger,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { Role, SessionStatus, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthCacheService } from '../auth/auth-cache.service';
import { Public } from '../auth/jwt-auth.guard';
import type { JwtPayload } from '../auth/jwt-payload';
import { TunnelGateway } from './tunnel.gateway';
import { TunnelService } from './tunnel.service';

function parseCookie(cookieHeader?: string): Record<string, string> {
  if (!cookieHeader) return {};
  const res: Record<string, string> = {};
  for (const c of cookieHeader.split(';')) {
    const [k, ...v] = c.trim().split('=');
    if (k) res[k] = decodeURIComponent(v.join('='));
  }
  return res;
}

/**
 * Localhost Port-Forwarding Reverse Proxy.
 * Intercepts requests to `/proxy/:sessionId/:port/*` and streams them through the
 * WebSocket tunnel connected to the host's VS Code extension.
 */
@SkipThrottle()
@Controller('proxy')
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);

  constructor(
    private readonly tunnelService: TunnelService,
    private readonly tunnelGateway: TunnelGateway,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly authCache: AuthCacheService,
  ) {}

  @Public()
  @All(':sessionId/:port')
  async proxyRoot(
    @Param('sessionId') sessionId: string,
    @Param('port') portStr: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // If accessing root without trailing slash on GET, redirect to trailing slash
    // so relative assets (e.g. "./main.js") resolve relative to the port proxy root.
    // Ignore the query string: preview URLs carry an auth token there.
    const pathname = req.originalUrl.split('?')[0];
    if (req.method === 'GET' && !pathname.endsWith('/')) {
      const queryIdx = req.originalUrl.indexOf('?');
      const query = queryIdx !== -1 ? req.originalUrl.slice(queryIdx) : '';
      return res.redirect(307, `/proxy/${sessionId}/${portStr}/${query}`);
    }
    return this.forward(sessionId, portStr, '/', req, res);
  }

  @Public()
  @All(':sessionId/:port/*')
  async proxySubpath(
    @Param('sessionId') sessionId: string,
    @Param('port') portStr: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const wildcardParams = req.params as Record<string, string | string[]>;
    // Nest 11/path-to-regexp returns named wildcard segments as an array.
    // Keep the numeric key fallback for adapters with the legacy shape.
    const rawWildcard = wildcardParams.path ?? wildcardParams[0] ?? '';
    const wildcard = Array.isArray(rawWildcard) ? rawWildcard.join('/') : rawWildcard;
    const subpath = '/' + wildcard;
    return this.forward(sessionId, portStr, subpath, req, res);
  }

  private async forward(
    sessionId: string,
    portStr: string,
    subpath: string,
    req: Request,
    res: Response,
  ) {
    // This session-authorized endpoint is intentionally loaded by the web app
    // inside an iframe; Helmetâ€™s API-wide anti-frame headers block that use.
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return res.status(400).send('Invalid port number');
    }

    // 1. Authenticate user via query param, Authorization header, or cookie
    const cookies = parseCookie(req.headers.cookie);
    const token =
      (req.query.token as string | undefined) ??
      req.headers.authorization?.split(' ')[1] ??
      cookies['livetich_proxy_token'];

    if (!token) {
      return res.status(401).send('Missing session authorization token');
    }

    let user: JwtPayload;
    try {
      user = this.jwt.verify<JwtPayload>(token);
    } catch {
      return res.status(401).send('Invalid or expired authorization token');
    }

    // This route accepts the short-lived realtime token in a query parameter
    // or cookie because browser iframes cannot set Authorization headers.
    // Mirror the global guard's account checks here and reject recorder tokens.
    if (user.recorder) {
      return res.status(401).send('Recorder tokens cannot access forwarded ports');
    }
    const account = await this.authCache.getState(user.sub);
    if (!account || account.status === UserStatus.DISABLED) {
      return res.status(401).send('This account is not permitted');
    }
    if (!account.emailVerified) {
      return res.status(403).send('Email not verified');
    }

    // A preview origin is unique to this session/port, so scope its auth cookie
    // to `/`; the legacy path proxy keeps its narrower cookie path.
    const previewDomain = process.env.PREVIEW_DOMAIN?.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    const hostname = req.hostname.toLowerCase();
    const isHostPreview = hostname.endsWith('.localhost') ||
      Boolean(previewDomain && hostname.endsWith(`.${previewDomain}`));
    res.cookie('livetich_proxy_token', token, {
      httpOnly: true,
      sameSite: isHostPreview ? 'none' : 'lax',
      // Browsers must allow the preview iframe's cookie in a cross-origin
      // classroom embed; HTTPS is used in production and localhost is a secure
      // context in modern browsers during local development.
      secure: isHostPreview || req.secure,
      maxAge: 4 * 60 * 60 * 1000,
      path: isHostPreview ? '/' : `/proxy/${sessionId}/${port}/`,
    });

    // 2. Validate session & user enrollment
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: {
        course: {
          select: { id: true, instructorId: true, organizationId: true },
        },
      },
    });

    if (!session || session.status === SessionStatus.ENDED) {
      return res.status(404).send('Session not found or ended');
    }

    if (user.role === Role.INSTRUCTOR) {
      if (session.course.instructorId !== user.sub) {
        return res.status(403).send('Not your session');
      }
    } else if (user.role === Role.ORG_ADMIN) {
      if (!user.organizationId || session.course.organizationId !== user.organizationId) {
        return res.status(403).send('Not your organisation session');
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
      if (!enrolled) return res.status(403).send('Not enrolled in course');
    }

    // 3. Find active host socket for this port
    const hostSocketId = this.tunnelService.getHostSocketForPort(
      sessionId,
      port,
    );
    if (!hostSocketId) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(502).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>Port ${port} Not Forwarded</title>
          <style>
            body { background: #09090b; color: #f4f4f5; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: #14141a; border: 1px solid rgba(255,255,255,0.08); border-radius: 14px; padding: 32px; max-width: 440px; text-align: center; }
            h2 { color: #f87171; margin-top: 0; font-size: 18px; }
            p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin-bottom: 0; }
            .badge { display: inline-block; background: rgba(248,113,113,0.15); color: #f87171; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: 600; margin-bottom: 12px; }
          </style>
        </head>
        <body>
          <div class="card">
            <span class="badge">Tunnel Inactive</span>
            <h2>Localhost Port ${port} is not online</h2>
            <p>The instructor has not forwarded port <code>${port}</code> from their VS Code workspace, or the local dev server is stopped.</p>
          </div>
        </body>
        </html>
      `);
    }

    // 4. Generate unique request id
    const reqId =
      'req_' +
      Math.random().toString(36).substring(2, 9) +
      Date.now().toString(36);

    // Read incoming request body if present
    let bodyBase64: string | undefined;
    if (req.body) {
      if (Buffer.isBuffer(req.body)) {
        bodyBase64 = req.body.toString('base64');
      } else if (typeof req.body === 'object') {
        bodyBase64 = Buffer.from(JSON.stringify(req.body)).toString('base64');
      } else if (typeof req.body === 'string') {
        bodyBase64 = Buffer.from(req.body).toString('base64');
      }
    }

    // Prepare headers for the host
    const forwardedHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) {
        forwardedHeaders[k] = v;
      }
    }
    forwardedHeaders['x-forwarded-for'] = req.ip ?? '127.0.0.1';
    forwardedHeaders['x-forwarded-proto'] = req.protocol;
    if (!isHostPreview) {
      forwardedHeaders['x-forwarded-prefix'] = `/proxy/${sessionId}/${port}`;
    }
    forwardedHeaders['host'] = `localhost:${port}`;

    // Clean query param
    const queryCopy = { ...req.query };
    delete queryCopy.token; // do not leak token downstream to local server

    // 5. Register pending request in tunnel service
    this.tunnelService.registerPendingRequest(reqId, res, () => {
      this.tunnelGateway.sendAbort(hostSocketId, reqId);
    });

    // Abort if client disconnects before completion
    req.on('close', () => {
      this.tunnelService.abortRequest(reqId);
      this.tunnelGateway.sendAbort(hostSocketId, reqId);
    });

    // 6. Send request frame to host extension
    this.tunnelGateway.sendHttpRequest(hostSocketId, {
      reqId,
      port,
      method: req.method,
      path: subpath,
      query: queryCopy as Record<string, string | string[]>,
      headers: forwardedHeaders,
      body: bodyBase64,
      isBase64: Boolean(bodyBase64),
    });
  }
}
