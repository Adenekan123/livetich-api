import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from '../auth/jwt-payload';

export const STEP_UP_MAX_AGE = 'stepUpMaxAge';
/** Require the step-up to be no older than N seconds for this route. */
export const StepUpMaxAge = (seconds: number) =>
  SetMetadata(STEP_UP_MAX_AGE, seconds);

/** Default freshness for admin routes: 30 minutes. */
const DEFAULT_MAX_AGE = 30 * 60;

interface StepUpClaims {
  su: string;
  purpose: string;
  iat?: number;
}

/**
 * Requires a valid, fresh step-up token (from POST /auth/admin-reauth) on the
 * `x-admin-step-up` header — proving the operator re-entered their password
 * recently. So a stolen 7-day session token alone can't open the console or run
 * destructive actions; the attacker also needs the password. The most dangerous
 * routes demand a fresher token via @StepUpMaxAge. Runs after SuperAdminGuard.
 *
 * The sentinel message STEP_UP_REQUIRED lets the web redirect to the unlock page.
 */
@Injectable()
export class AdminStepUpGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: JwtPayload }>();

    const header = req.headers['x-admin-step-up'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token) throw new UnauthorizedException('STEP_UP_REQUIRED');

    let claims: StepUpClaims;
    try {
      claims = await this.jwt.verifyAsync<StepUpClaims>(token);
    } catch {
      throw new UnauthorizedException('STEP_UP_REQUIRED');
    }
    if (claims.purpose !== 'admin-stepup' || claims.su !== req.user?.sub) {
      throw new UnauthorizedException('STEP_UP_REQUIRED');
    }

    const maxAge =
      this.reflector.getAllAndOverride<number>(STEP_UP_MAX_AGE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_MAX_AGE;
    const ageSec = Math.floor(Date.now() / 1000) - (claims.iat ?? 0);
    if (ageSec > maxAge) throw new UnauthorizedException('STEP_UP_REQUIRED');

    return true;
  }
}
