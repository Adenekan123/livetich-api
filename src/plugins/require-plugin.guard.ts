import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { JwtPayload } from '../auth/jwt-payload';
import { PluginsService } from './plugins.service';

export const REQUIRE_PLUGIN_KEY = 'require_plugin';

/**
 * Gates a route (or whole controller) on an add-on pack being enabled for the
 * caller's organization. Pair with `@UseGuards(RequirePluginGuard)`; it runs
 * after the global JwtAuthGuard, so `req.user` is populated. The entitlement
 * itself is resolved through {@link PluginsService.isEnabled} — the one seam
 * every pack gate goes through.
 */
export const RequirePlugin = (key: string) =>
  SetMetadata(REQUIRE_PLUGIN_KEY, key);

@Injectable()
export class RequirePluginGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly plugins: PluginsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Sockets carry no HTTP request; their gateways gate per-message. (In
    // practice the pack's HTTP endpoints are the data source, so a disabled
    // pack is already unreachable over the socket.)
    if (context.getType() !== 'http') return true;

    const key = this.reflector.getAllAndOverride<string>(REQUIRE_PLUGIN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!key) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>();
    const enabled = await this.plugins.isEnabled(
      req.user?.organizationId ?? null,
      key,
    );
    if (!enabled) {
      throw new ForbiddenException(`This feature requires the ${key} add-on`);
    }
    return true;
  }
}
