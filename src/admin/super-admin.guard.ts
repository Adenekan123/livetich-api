import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtPayload } from '../auth/jwt-payload';

/**
 * Gates the platform /admin surface to super-admins. The global JwtAuthGuard has
 * already authenticated the request and set `req.user`; this guard confirms the
 * flag against the DATABASE (not just the token) so a revoked super-admin loses
 * access immediately, even while holding a still-valid 7-day token. Admin traffic
 * is tiny, so the extra query per request is negligible.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>();
    const userId = req.user?.sub;
    if (!userId) throw new ForbiddenException('Not authorized');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isSuperAdmin: true },
    });
    if (!user?.isSuperAdmin) {
      throw new ForbiddenException('Platform admin access required');
    }
    return true;
  }
}
