import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import type { JwtPayload } from '../auth/jwt-payload';

/**
 * Stable audit action slugs. Dotted `domain.thing.verb` so the admin UI can
 * group/filter. Add new ones here rather than sprinkling string literals.
 */
export const AuditAction = {
  AUTH_LOGIN_SUCCESS: 'auth.login.success',
  AUTH_LOGIN_FAILURE: 'auth.login.failure',
  AUTH_PASSWORD_RESET_REQUEST: 'auth.password.reset_request',
  AUTH_PASSWORD_RESET_COMPLETE: 'auth.password.reset_complete',
  ORG_CREATED: 'org.created',
  ADMIN_USER_STATUS_CHANGED: 'admin.user.status_changed',
  ADMIN_USER_ROLE_CHANGED: 'admin.user.role_changed',
  ADMIN_USER_SUPERADMIN_CHANGED: 'admin.user.superadmin_changed',
  ADMIN_USER_RESET_LINK_SENT: 'admin.user.reset_link_sent',
  ADMIN_USER_EMAIL_VERIFIED: 'admin.user.email_verified',
  ADMIN_USER_IMPERSONATED: 'admin.user.impersonated',
} as const;

export type AuditActionValue =
  (typeof AuditAction)[keyof typeof AuditAction];

/** Actions that trigger a real-time security email to the operator. */
const SENSITIVE_ACTIONS = new Set<string>([
  AuditAction.ADMIN_USER_SUPERADMIN_CHANGED,
  AuditAction.ADMIN_USER_IMPERSONATED,
]);

export interface AuditEntry {
  action: AuditActionValue | string;
  actorId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  orgId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Writes the immutable audit trail. Recording is best-effort and never allowed
 * to break the action being audited: every write is fire-and-forget with its
 * own error handling, so a logging failure can't fail a login or an admin edit.
 */
@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  /** Record one audit entry (fire-and-forget; failures are logged, not thrown). */
  record(entry: AuditEntry): void {
    void this.prisma.auditLog
      .create({
        data: {
          action: entry.action,
          actorId: entry.actorId ?? null,
          actorEmail: entry.actorEmail ?? null,
          actorRole: entry.actorRole ?? null,
          orgId: entry.orgId ?? null,
          targetType: entry.targetType ?? null,
          targetId: entry.targetId ?? null,
          metadata: (entry.metadata ?? undefined) as never,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent ?? null,
        },
      })
      .catch((err) =>
        this.log.error(`audit write failed (${entry.action}): ${String(err)}`),
      );

    if (SENSITIVE_ACTIONS.has(entry.action)) this.alert(entry);
  }

  /** Email the operator on a sensitive event (best-effort, never throws). */
  private alert(entry: AuditEntry): void {
    const to = this.config.get<string>('SECURITY_ALERT_EMAIL');
    if (!to) return;
    const title =
      entry.action === AuditAction.ADMIN_USER_SUPERADMIN_CHANGED
        ? 'Platform-admin access changed'
        : 'A user was impersonated';
    const meta = entry.metadata ?? {};
    const lines = [
      `Actor: ${entry.actorEmail ?? 'unknown'}${entry.actorRole ? ` (${entry.actorRole})` : ''}`,
      `Target: ${String((meta as Record<string, unknown>).targetEmail ?? entry.targetId ?? 'unknown')}`,
      `IP: ${entry.ip ?? 'unknown'}`,
      `When: ${new Date().toISOString()}`,
    ];
    void this.mail
      .sendSecurityAlert(to, title, lines)
      .catch((err) => this.log.error(`security alert failed: ${String(err)}`));
  }

  /**
   * Record with actor + client context pulled from the request. Use from
   * controllers where `req.user` and headers are available.
   */
  recordFromRequest(
    req: Request & { user?: JwtPayload },
    entry: Omit<AuditEntry, 'actorId' | 'actorEmail' | 'actorRole' | 'ip' | 'userAgent'>,
  ): void {
    this.record({
      ...entry,
      actorId: req.user?.sub ?? null,
      actorEmail: req.user?.email ?? null,
      actorRole: req.user?.role ?? null,
      orgId: entry.orgId ?? req.user?.organizationId ?? null,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}

/** Best-effort client IP, honoring a single proxy hop (Caddy sets x-forwarded-for). */
export function clientIp(req: Request): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? null;
}
