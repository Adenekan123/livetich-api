import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, Role, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthCacheService } from '../auth/auth-cache.service';
import { AuthService } from '../auth/auth.service';
import type { JwtPayload } from '../auth/jwt-payload';
import { AuditAction, AuditService } from '../observability/audit.service';

/** Who did an admin action + client context, for the audit trail. */
export interface ActorCtx {
  actor: JwtPayload;
  ip: string | null;
  userAgent: string | null;
}

const DAY = 24 * 60 * 60 * 1000;
const num = (d: Prisma.Decimal | number | null | undefined): number =>
  d == null ? 0 : typeof d === 'number' ? d : d.toNumber();

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly authCache: AuthCacheService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  // ---------------------------------------------------------------- Overview
  async overview() {
    const now = Date.now();
    const since30 = new Date(now - 30 * DAY);
    const startToday = new Date(new Date().setHours(0, 0, 0, 0));

    const [
      orgs,
      users,
      active,
      instructors,
      students,
      admins,
      courses,
      liveSessions,
      submissions30,
      aiToday,
      ai30,
    ] = await Promise.all([
      this.prisma.organization.count(),
      this.prisma.user.count(),
      this.prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
      this.prisma.user.count({ where: { role: Role.INSTRUCTOR } }),
      this.prisma.user.count({ where: { role: Role.STUDENT } }),
      this.prisma.user.count({ where: { role: Role.ORG_ADMIN } }),
      this.prisma.course.count(),
      this.prisma.liveSession.count({ where: { status: 'LIVE' } }),
      this.prisma.codingSubmission.count({
        where: { submittedAt: { gte: since30 } },
      }),
      this.prisma.aiUsage.aggregate({
        where: { at: { gte: startToday } },
        _sum: { estCostUsd: true, totalTokens: true },
        _count: true,
      }),
      this.prisma.aiUsage.aggregate({
        where: { at: { gte: since30 } },
        _sum: { estCostUsd: true, totalTokens: true },
        _count: true,
      }),
    ]);

    return {
      orgs,
      users: {
        total: users,
        active,
        disabled: users - active,
        instructors,
        students,
        admins,
      },
      courses,
      liveSessions,
      submissions30d: submissions30,
      ai: {
        today: {
          calls: aiToday._count,
          costUsd: num(aiToday._sum.estCostUsd),
          tokens: aiToday._sum.totalTokens ?? 0,
        },
        last30d: {
          calls: ai30._count,
          costUsd: num(ai30._sum.estCostUsd),
          tokens: ai30._sum.totalTokens ?? 0,
        },
      },
    };
  }

  // ------------------------------------------------------------------- Users
  async listUsers(params: {
    q?: string;
    role?: Role;
    status?: UserStatus;
    orgId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 25));
    const where: Prisma.UserWhereInput = {
      ...(params.role ? { role: params.role } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.orgId ? { organizationId: params.orgId } : {}),
      ...(params.q
        ? {
            OR: [
              { name: { contains: params.q } },
              { email: { contains: params.q } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          status: true,
          isSuperAdmin: true,
          emailVerified: true,
          createdAt: true,
          organization: { select: { id: true, name: true } },
        },
      }),
    ]);

    return { total, page, pageSize, rows };
  }

  private async getUserOr404(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async setUserStatus(ctx: ActorCtx, userId: string, status: UserStatus) {
    const user = await this.getUserOr404(userId);
    if (user.id === ctx.actor.sub) {
      throw new BadRequestException('You cannot change your own account status');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { status } });
    await this.authCache.invalidate(userId); // end any live session immediately
    this.logAction(ctx, AuditAction.ADMIN_USER_STATUS_CHANGED, user, {
      from: user.status,
      to: status,
    });
    return { id: userId, status };
  }

  async setUserRole(ctx: ActorCtx, userId: string, role: Role) {
    const user = await this.getUserOr404(userId);
    await this.prisma.user.update({ where: { id: userId }, data: { role } });
    this.logAction(ctx, AuditAction.ADMIN_USER_ROLE_CHANGED, user, {
      from: user.role,
      to: role,
    });
    return { id: userId, role };
  }

  async setSuperAdmin(ctx: ActorCtx, userId: string, value: boolean) {
    const user = await this.getUserOr404(userId);
    if (user.id === ctx.actor.sub && !value) {
      throw new BadRequestException(
        'You cannot revoke your own platform-admin access',
      );
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { isSuperAdmin: value },
    });
    this.logAction(ctx, AuditAction.ADMIN_USER_SUPERADMIN_CHANGED, user, {
      to: value,
    });
    return { id: userId, isSuperAdmin: value };
  }

  async sendResetLink(ctx: ActorCtx, userId: string) {
    const user = await this.getUserOr404(userId);
    await this.auth.requestPasswordReset(user.email); // emails the user a link
    this.logAction(ctx, AuditAction.ADMIN_USER_RESET_LINK_SENT, user, null);
    return { ok: true };
  }

  async verifyUserEmail(ctx: ActorCtx, userId: string) {
    const user = await this.getUserOr404(userId);
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true, verifyOtpHash: null, verifyOtpExpiresAt: null },
    });
    await this.authCache.invalidate(userId);
    this.logAction(ctx, AuditAction.ADMIN_USER_EMAIL_VERIFIED, user, null);
    return { id: userId, emailVerified: true };
  }

  /**
   * Mint a short-lived token that logs the operator in AS the target user, for
   * support/debugging. Cannot target another super-admin (no lateral takeover),
   * cannot target a disabled account, and is fully audit-logged.
   */
  async impersonate(ctx: ActorCtx, userId: string) {
    const user = await this.getUserOr404(userId);
    if (user.isSuperAdmin && user.id !== ctx.actor.sub) {
      throw new ForbiddenException('Cannot impersonate another platform admin');
    }
    if (user.status === UserStatus.DISABLED) {
      throw new BadRequestException('Cannot impersonate a disabled account');
    }
    const payload: JwtPayload & { impersonatedBy: string } = {
      sub: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      organizationId: user.organizationId,
      emailVerified: user.emailVerified,
      isSuperAdmin: user.isSuperAdmin,
      impersonatedBy: ctx.actor.sub,
    };
    const token = this.jwt.sign(payload, { expiresIn: '30m' });
    this.logAction(ctx, AuditAction.ADMIN_USER_IMPERSONATED, user, {
      expiresInMinutes: 30,
    });
    return {
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    };
  }

  // ------------------------------------------------------------------- Orgs
  async listOrgs() {
    const orgs = await this.prisma.organization.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        createdAt: true,
        _count: { select: { users: true, courses: true } },
      },
    });
    return orgs.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      createdAt: o.createdAt,
      users: o._count.users,
      courses: o._count.courses,
    }));
  }

  // ------------------------------------------------------------------ Audit
  async listAudit(params: {
    action?: string;
    actorId?: string;
    orgId?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 50));
    const where: Prisma.AuditLogWhereInput = {
      ...(params.action ? { action: { startsWith: params.action } } : {}),
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.orgId ? { orgId: params.orgId } : {}),
      ...(params.from || params.to
        ? {
            at: {
              ...(params.from ? { gte: new Date(params.from) } : {}),
              ...(params.to ? { lte: new Date(params.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { at: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { total, page, pageSize, rows };
  }

  // --------------------------------------------------------------- AI usage
  async aiUsage(params: { from?: string; to?: string }) {
    const to = params.to ? new Date(params.to) : new Date();
    const from = params.from
      ? new Date(params.from)
      : new Date(to.getTime() - 30 * DAY);
    const where: Prisma.AiUsageWhereInput = { at: { gte: from, lte: to } };

    const [totals, byModel, byFeature, byOrgRaw, daily] = await Promise.all([
      this.prisma.aiUsage.aggregate({
        where,
        _sum: { estCostUsd: true, totalTokens: true, promptTokens: true, outputTokens: true },
        _count: true,
      }),
      this.prisma.aiUsage.groupBy({
        by: ['model'],
        where,
        _sum: { estCostUsd: true, totalTokens: true },
        _count: true,
      }),
      this.prisma.aiUsage.groupBy({
        by: ['feature'],
        where,
        _sum: { estCostUsd: true, totalTokens: true },
        _count: true,
      }),
      this.prisma.aiUsage.groupBy({
        by: ['orgId'],
        where,
        _sum: { estCostUsd: true, totalTokens: true },
        _count: true,
      }),
      this.dailyUsage(from, to),
    ]);

    // Resolve org names for the by-org breakdown.
    const orgIds = byOrgRaw
      .map((r) => r.orgId)
      .filter((id): id is string => Boolean(id));
    const orgs = orgIds.length
      ? await this.prisma.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        })
      : [];
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));

    return {
      range: { from, to },
      totals: {
        calls: totals._count,
        costUsd: num(totals._sum.estCostUsd),
        totalTokens: totals._sum.totalTokens ?? 0,
        promptTokens: totals._sum.promptTokens ?? 0,
        outputTokens: totals._sum.outputTokens ?? 0,
      },
      byModel: byModel
        .map((r) => ({
          model: r.model,
          calls: r._count,
          costUsd: num(r._sum.estCostUsd),
          tokens: r._sum.totalTokens ?? 0,
        }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byFeature: byFeature.map((r) => ({
        feature: r.feature,
        calls: r._count,
        costUsd: num(r._sum.estCostUsd),
        tokens: r._sum.totalTokens ?? 0,
      })),
      byOrg: byOrgRaw
        .map((r) => ({
          orgId: r.orgId,
          orgName: r.orgId ? orgName.get(r.orgId) ?? 'Unknown' : '(none)',
          calls: r._count,
          costUsd: num(r._sum.estCostUsd),
          tokens: r._sum.totalTokens ?? 0,
        }))
        .sort((a, b) => b.costUsd - a.costUsd),
      daily,
    };
  }

  /** Daily cost/token trend via raw SQL (MySQL DATE() bucket). */
  private async dailyUsage(from: Date, to: Date) {
    const rows = await this.prisma.$queryRaw<
      { day: Date; cost: Prisma.Decimal | number; tokens: bigint | number; calls: bigint | number }[]
    >`
      SELECT DATE(at) AS day,
             SUM(estCostUsd) AS cost,
             SUM(totalTokens) AS tokens,
             COUNT(*) AS calls
      FROM AiUsage
      WHERE at >= ${from} AND at <= ${to}
      GROUP BY DATE(at)
      ORDER BY day ASC
    `;
    return rows.map((r) => ({
      day:
        r.day instanceof Date
          ? r.day.toISOString().slice(0, 10)
          : String(r.day).slice(0, 10),
      costUsd: num(r.cost as Prisma.Decimal),
      tokens: Number(r.tokens),
      calls: Number(r.calls),
    }));
  }

  // --------------------------------------------------------------- internal
  private logAction(
    ctx: ActorCtx,
    action: string,
    target: { id: string; email: string; organizationId: string | null },
    metadata: Record<string, unknown> | null,
  ) {
    this.audit.record({
      action,
      actorId: ctx.actor.sub,
      actorEmail: ctx.actor.email,
      actorRole: ctx.actor.role,
      orgId: target.organizationId,
      targetType: 'user',
      targetId: target.id,
      metadata: { targetEmail: target.email, ...(metadata ?? {}) },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
