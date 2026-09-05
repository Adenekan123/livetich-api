import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuditAction, AuditService, clientIp } from '../observability/audit.service';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { AdminReauthDto } from './dto/admin-reauth.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterOrganizationDto } from './dto/register-organization.dto';
import { SwitchWorkspaceDto } from './dto/switch-workspace.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { AllowUnverified, Public } from './jwt-auth.guard';
import type { JwtPayload } from './jwt-payload';

// Auth is the most-attacked surface — cap it well below the global limit.
@Throttle({ default: { limit: 20, ttl: 60_000 } })
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Public()
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  /** Company signup: creates the org + its first admin. */
  @Public()
  @Post('register-organization')
  async registerOrganization(
    @Body() dto: RegisterOrganizationDto,
    @Req() req: Request,
  ) {
    const result = await this.auth.registerOrganization(dto);
    this.audit.record({
      action: AuditAction.ORG_CREATED,
      actorId: result.user.id,
      actorEmail: result.user.email,
      actorRole: result.user.role,
      orgId: result.user.organizationId,
      targetType: 'organization',
      targetId: result.user.organizationId,
      metadata: { organizationName: dto.organizationName },
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return result;
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const ip = clientIp(req);
    const userAgent = req.headers['user-agent'] ?? null;
    try {
      const result = await this.auth.login(dto);
      this.audit.record({
        action: AuditAction.AUTH_LOGIN_SUCCESS,
        actorId: result.user.id,
        actorEmail: result.user.email,
        actorRole: result.user.role,
        orgId: result.user.organizationId,
        ip,
        userAgent,
      });
      return result;
    } catch (err) {
      // Record the attempt (email only — no account is confirmed to exist).
      this.audit.record({
        action: AuditAction.AUTH_LOGIN_FAILURE,
        actorEmail: dto.email,
        metadata: { reason: (err as Error)?.message ?? 'failed' },
        ip,
        userAgent,
      });
      throw err;
    }
  }

  @Public()
  @Throttle({ default: { limit: 4, ttl: 60_000 } }) // email send — anti-bombing
  @HttpCode(200)
  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.requestPasswordReset(dto.email);
    this.audit.record({
      action: AuditAction.AUTH_PASSWORD_RESET_REQUEST,
      actorEmail: dto.email,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    return { ok: true };
  }

  @Public()
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto.token, dto.newPassword);
    return { ok: true };
  }

  @AllowUnverified()
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return user;
  }

  /** Workspaces this account can act in — for the workspace switcher. */
  @Get('workspaces')
  workspaces(@CurrentUser() user: JwtPayload) {
    return this.auth.listWorkspaces(user.sub);
  }

  /** Switch the active workspace; returns a fresh token scoped to it. */
  @HttpCode(200)
  @Post('switch-workspace')
  switchWorkspace(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SwitchWorkspaceDto,
  ) {
    return this.auth.switchWorkspace(user.sub, dto.organizationId);
  }

  /** Short-lived token for realtime clients (see AuthService.mintRealtimeToken).
   *  Fetched on every socket (re)connect, so it gets a looser limit. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Post('realtime-token')
  realtimeToken(@CurrentUser() user: JwtPayload) {
    return this.auth.mintRealtimeToken(user);
  }

  /** Sends (or resends) the 6-digit verification code to the current user. */
  @AllowUnverified()
  @Throttle({ default: { limit: 4, ttl: 60_000 } }) // email send — anti-bombing
  @HttpCode(200)
  @Post('send-verification')
  async sendVerification(@CurrentUser() user: JwtPayload) {
    await this.auth.sendVerificationOtp(user.sub);
    return { ok: true };
  }

  /** Confirms the code and returns a fresh session token (now verified). */
  @AllowUnverified()
  @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@CurrentUser() user: JwtPayload, @Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(user.sub, dto.code);
  }

  /** Step-up re-auth for the platform admin console — see AuthService.adminReauth. */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('admin-reauth')
  adminReauth(@CurrentUser() user: JwtPayload, @Body() dto: AdminReauthDto) {
    return this.auth.adminReauth(user.sub, dto.password);
  }

  @HttpCode(200)
  @Post('change-password')
  changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.auth.changePassword(user.sub, dto.currentPassword, dto.newPassword);
  }
}
