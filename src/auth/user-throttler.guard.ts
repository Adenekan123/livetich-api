import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
} from '@nestjs/throttler';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';

/**
 * Rate-limit authenticated requests per user, not per IP. Whole schools and
 * offices sit behind a single NAT/public IP, so a plain per-IP limit would let
 * one busy classroom collectively trip the limit and 429 everyone. We verify
 * the bearer token here (rather than trusting a request field or guard order)
 * so a caller can't forge a `sub` to mint themselves a fresh bucket. Requests
 * without a valid token — login, register, anonymous catalog reads — still key
 * by IP, preserving brute-force protection on the unauthenticated surface.
 */
@Injectable()
export class UserOrIpThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const header = req.headers?.authorization as string | undefined;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<{ sub?: string }>(token);
        if (payload?.sub) return `user:${payload.sub}`;
      } catch {
        // Invalid/expired token — fall through to per-IP tracking.
      }
    }
    return `ip:${(req.ip as string) ?? 'unknown'}`;
  }
}
