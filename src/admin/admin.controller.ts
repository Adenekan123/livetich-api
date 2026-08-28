import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import type { Request } from 'express';
import type { JwtPayload } from '../auth/jwt-payload';
import { clientIp } from '../observability/audit.service';
import { AdminService, ActorCtx } from './admin.service';
import { AdminStepUpGuard, StepUpMaxAge } from './admin-step-up.guard';
import { SetRoleDto, SetStatusDto, SetSuperAdminDto } from './dto/admin.dto';
import { SuperAdminGuard } from './super-admin.guard';

/** Fresh-password window (seconds) required for the most destructive actions. */
const DESTRUCTIVE_MAX_AGE = 5 * 60;

/**
 * Platform-operator console. Every route is gated by SuperAdminGuard (which
 * re-checks the DB flag), on top of the global JWT auth. All mutating actions
 * are written to the audit trail by AdminService.
 */
@UseGuards(SuperAdminGuard, AdminStepUpGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  private ctx(req: Request & { user?: JwtPayload }): ActorCtx {
    return {
      actor: req.user!,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    };
  }

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  // ------------------------------------------------------------------ Users
  @Get('users')
  users(
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
    @Query('orgId') orgId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.admin.listUsers({
      q: q?.trim() || undefined,
      role: role && role in Role ? (role as Role) : undefined,
      status: status && status in UserStatus ? (status as UserStatus) : undefined,
      orgId: orgId || undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post('users/:id/status')
  setStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
  ) {
    return this.admin.setUserStatus(this.ctx(req), id, dto.status);
  }

  @StepUpMaxAge(DESTRUCTIVE_MAX_AGE)
  @Post('users/:id/role')
  setRole(@Req() req: Request, @Param('id') id: string, @Body() dto: SetRoleDto) {
    return this.admin.setUserRole(this.ctx(req), id, dto.role);
  }

  @StepUpMaxAge(DESTRUCTIVE_MAX_AGE)
  @Post('users/:id/super-admin')
  setSuperAdmin(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: SetSuperAdminDto,
  ) {
    return this.admin.setSuperAdmin(this.ctx(req), id, dto.value);
  }

  @Post('users/:id/reset-link')
  resetLink(@Req() req: Request, @Param('id') id: string) {
    return this.admin.sendResetLink(this.ctx(req), id);
  }

  @Post('users/:id/verify-email')
  verifyEmail(@Req() req: Request, @Param('id') id: string) {
    return this.admin.verifyUserEmail(this.ctx(req), id);
  }

  @StepUpMaxAge(DESTRUCTIVE_MAX_AGE)
  @Post('users/:id/impersonate')
  impersonate(@Req() req: Request, @Param('id') id: string) {
    return this.admin.impersonate(this.ctx(req), id);
  }

  // ------------------------------------------------------------------- Orgs
  @Get('orgs')
  orgs() {
    return this.admin.listOrgs();
  }

  // ------------------------------------------------------------------ Audit
  @Get('audit')
  audit(
    @Query('action') action?: string,
    @Query('actorId') actorId?: string,
    @Query('orgId') orgId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.admin.listAudit({
      action: action?.trim() || undefined,
      actorId: actorId || undefined,
      orgId: orgId || undefined,
      from: from || undefined,
      to: to || undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  // --------------------------------------------------------------- AI usage
  @Get('ai-usage')
  aiUsage(@Query('from') from?: string, @Query('to') to?: string) {
    return this.admin.aiUsage({ from: from || undefined, to: to || undefined });
  }
}
