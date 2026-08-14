import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import type { Request } from 'express';
import { AuthCacheService } from './auth-cache.service';
import { JwtPayload } from './jwt-payload';

export const IS_PUBLIC_KEY = 'isPublic';
/** Marks a route as accessible without a token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ALLOW_UNVERIFIED_KEY = 'allowUnverified';
/** Marks a route reachable by a logged-in user whose email isn't verified yet
 *  (the verification endpoints themselves, and /auth/me). */
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED_KEY, true);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly authCache: AuthCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only HTTP requests carry a bearer header this guard can read. WebSocket
    // gateways authenticate the socket in their own handleConnection lifecycle
    // (the handshake token), so this global guard must not run on their message
    // handlers — reading `req.headers` off a non-HTTP context throws and would
    // 500 every socket message (room:join, chat, …).
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const [scheme, token] = req.headers.authorization?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException('Missing bearer token');
    }
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    // The token is stateless (7d), so a disabled/deleted account must be
    // rejected here — not just at login — to end any active session. Cached in
    // Redis (invalidated on disable/verify) so this isn't a per-request DB hit.
    const account = await this.authCache.getState(payload.sub);
    if (!account || account.status === UserStatus.DISABLED) {
      throw new UnauthorizedException('This account has been disabled');
    }

    // Hard email-verification gate: unverified users can only reach the
    // verification endpoints (and /auth/me) until they confirm their address.
    const allowUnverified = this.reflector.getAllAndOverride<boolean>(
      ALLOW_UNVERIFIED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!account.emailVerified && !allowUnverified) {
      throw new ForbiddenException('Email not verified');
    }

    (req as Request & { user: JwtPayload }).user = {
      ...payload,
      emailVerified: account.emailVerified,
    };
    return true;
  }
}
