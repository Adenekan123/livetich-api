import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Invite, Role, UserStatus } from '@prisma/client';
import { hash as bcryptHash, verify as bcryptVerify } from '@node-rs/bcrypt';
import { createHash, randomBytes, randomInt } from 'crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthCacheService } from './auth-cache.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RegisterOrganizationDto } from './dto/register-organization.dto';
import { JwtPayload } from './jwt-payload';

const BCRYPT_ROUNDS = 12;

export interface AuthResult {
  accessToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: Role;
    organizationId: string | null;
    emailVerified: boolean;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
    private readonly authCache: AuthCacheService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Emails a password-reset link. Always resolves the same way whether or not
   * the address exists (and disabled accounts are skipped) so responses can't
   * be used to enumerate accounts.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status === UserStatus.DISABLED) return;

    const token = randomBytes(32).toString('base64url');
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: this.hashToken(token),
        resetTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min
      },
    });

    const base =
      this.config.get<string>('WEB_URL') ?? 'http://localhost:3001';
    const url = `${base}/reset-password?token=${token}`;
    await this.mail.sendPasswordReset(user.email, user.name, url);
  }

  /** Consumes a valid, unexpired reset token and sets the new password. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { resetTokenHash: this.hashToken(token) },
    });
    if (
      !user ||
      !user.resetTokenExpiresAt ||
      user.resetTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('This reset link is invalid or has expired');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcryptHash(newPassword, BCRYPT_ROUNDS),
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        // Resetting via the emailed link proves the user controls this address,
        // so mark the account verified. Without this an unverified user is
        // bounced to the verification page right after resetting — with no code
        // sent — and can't get in. Clear any pending OTP while we're here.
        emailVerified: true,
        verifyOtpHash: null,
        verifyOtpExpiresAt: null,
      },
    });
    // Drop any cached (status, emailVerified) so the guard sees the change on
    // the very next request rather than after the cache TTL.
    await this.authCache.invalidate(user.id);
  }

  /** Student/instructor signup, gated by an org invite link. */
  async register(dto: RegisterDto): Promise<AuthResult> {
    await this.assertEmailFree(dto.email);
    const passwordHash = await bcryptHash(dto.password, BCRYPT_ROUNDS);

    // Validate + consume the invite atomically so maxUses can't be raced.
    const user = await this.prisma.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({
        where: { token: dto.inviteToken },
      });
      this.assertInviteUsable(invite);
      const created = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          passwordHash,
          role: invite!.role,
          organizationId: invite!.organizationId,
        },
      });
      // Multi-workspace source of truth: mirror the join as a Membership so new
      // accounts are consistent with the model (legacy columns above stay too).
      await tx.membership.create({
        data: {
          userId: created.id,
          organizationId: invite!.organizationId,
          role: invite!.role,
          status: UserStatus.ACTIVE,
        },
      });
      await tx.invite.update({
        where: { id: invite!.id },
        data: { uses: { increment: 1 } },
      });
      // Course-scoped link: land the new user straight in that program. A
      // student is enrolled; an instructor is assigned to teach it.
      if (invite!.courseId) {
        if (invite!.role === Role.STUDENT) {
          await tx.enrollment.create({
            data: { courseId: invite!.courseId, studentId: created.id },
          });
        } else if (invite!.role === Role.INSTRUCTOR) {
          await tx.course.update({
            where: { id: invite!.courseId },
            data: { instructorId: created.id },
          });
        }
      }
      return created;
    });

    await this.sendVerificationOtp(user.id);
    return this.toAuthResult(user);
  }

  /** Company signup — creates the Organization and its first ORG_ADMIN. */
  async registerOrganization(dto: RegisterOrganizationDto): Promise<AuthResult> {
    await this.assertEmailFree(dto.email);
    const passwordHash = await bcryptHash(dto.password, BCRYPT_ROUNDS);
    const slug = await this.uniqueSlug(dto.organizationName);

    const user = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: dto.organizationName,
          slug,
          tagline: dto.tagline,
          primaryColor: dto.primaryColor,
          accentColor: dto.accentColor,
          logoUrl: dto.logoUrl,
        },
      });
      const created = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          passwordHash,
          role: Role.ORG_ADMIN,
          organizationId: org.id,
        },
      });
      await tx.membership.create({
        data: {
          userId: created.id,
          organizationId: org.id,
          role: Role.ORG_ADMIN,
          status: UserStatus.ACTIVE,
        },
      });
      return created;
    });

    await this.sendVerificationOtp(user.id);
    return this.toAuthResult(user);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Not signed in');
    const ok = await bcryptVerify(currentPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Current password is incorrect');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcryptHash(newPassword, BCRYPT_ROUNDS) },
    });
    return { ok: true };
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    // Compare against a constant hash when the user is missing so response
    // timing doesn't reveal which emails exist.
    const hash =
      user?.passwordHash ??
      '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7ZBpDLbIRasWM3zL8XoJv1LZv1B1O2y';
    const ok = await bcryptVerify(dto.password, hash);
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');
    if (user.status === UserStatus.DISABLED) {
      throw new ForbiddenException('This account has been disabled');
    }
    return this.toAuthResult(user);
  }

  /**
   * Step-up re-authentication for the platform admin console. Verifies the
   * operator's password again and mints a short-lived "step-up" token proving a
   * fresh password check. The admin API requires this (fresher still for the
   * most destructive actions), so a stolen session token alone can't open /admin
   * or impersonate — the attacker also needs the password.
   */
  async adminReauth(
    userId: string,
    password: string,
  ): Promise<{ stepUpToken: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isSuperAdmin) {
      throw new ForbiddenException('Platform admin access required');
    }
    const ok = await bcryptVerify(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Incorrect password');
    const stepUpToken = this.jwt.sign(
      { su: userId, purpose: 'admin-stepup' },
      { expiresIn: '30m' },
    );
    return { stepUpToken };
  }

  // ---------- helpers ----------

  private async assertEmailFree(email: string): Promise<void> {
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) throw new ConflictException('Email already registered');
  }

  /** Throws unless the invite exists and is still open for a student/instructor. */
  private assertInviteUsable(invite: Invite | null): asserts invite is Invite {
    if (!invite || invite.revokedAt) {
      throw new BadRequestException('This invite link is not valid');
    }
    if (invite.role === Role.ORG_ADMIN) {
      throw new BadRequestException('This invite link is not valid');
    }
    if (invite.expiresAt && invite.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This invite link has expired');
    }
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
      throw new BadRequestException('This invite link has been used up');
    }
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'org';
    for (let i = 0; i < 50; i++) {
      const slug = i === 0 ? base : `${base}-${i + 1}`;
      const taken = await this.prisma.organization.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!taken) return slug;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  private toAuthResult(user: {
    id: string;
    name: string;
    email: string;
    role: Role;
    organizationId: string | null;
    emailVerified: boolean;
    isSuperAdmin: boolean;
  }): AuthResult {
    const payload: JwtPayload = {
      sub: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      organizationId: user.organizationId,
      emailVerified: user.emailVerified,
      isSuperAdmin: user.isSuperAdmin,
    };
    return {
      accessToken: this.jwt.sign(payload),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
        emailVerified: user.emailVerified,
      },
    };
  }

  /**
   * The workspaces this identity can currently act in (its active memberships),
   * for the workspace switcher. One account can belong to several orgs.
   */
  async listWorkspaces(userId: string): Promise<
    { organizationId: string; organizationName: string; role: Role }[]
  > {
    const memberships = await this.prisma.membership.findMany({
      where: { userId, status: UserStatus.ACTIVE },
      include: { organization: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      organizationId: m.organizationId,
      organizationName: m.organization.name,
      role: m.role,
    }));
  }

  /**
   * Re-mint the session scoped to a different workspace. The caller must hold an
   * ACTIVE membership there; the new token's organizationId + role become that
   * workspace's, so every downstream org-scoped query follows the switch.
   */
  async switchWorkspace(
    userId: string,
    organizationId: string,
  ): Promise<AuthResult> {
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (!membership || membership.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('You are not a member of that workspace');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerified: true,
        isSuperAdmin: true,
      },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    return this.toAuthResult({
      ...user,
      role: membership.role,
      organizationId: membership.organizationId,
    });
  }

  /**
   * An existing, authenticated account joins ANOTHER org via an invite link —
   * adds a Membership instead of forcing a second account (the core of the
   * multi-workspace fix). Returns a session scoped to the joined workspace so
   * the client lands in it. Idempotent: already a member -> just switches in.
   */
  async joinWorkspace(userId: string, inviteToken: string): Promise<AuthResult> {
    const { orgId, role } = await this.prisma.$transaction(async (tx) => {
      const invite = await tx.invite.findUnique({ where: { token: inviteToken } });
      this.assertInviteUsable(invite);
      const organizationId = invite!.organizationId;
      const existing = await tx.membership.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
      });
      if (existing) return { orgId: organizationId, role: existing.role };

      await tx.membership.create({
        data: { userId, organizationId, role: invite!.role, status: UserStatus.ACTIVE },
      });
      await tx.invite.update({
        where: { id: invite!.id },
        data: { uses: { increment: 1 } },
      });
      // Course-scoped link: enrol the student / assign the instructor.
      if (invite!.courseId) {
        if (invite!.role === Role.STUDENT) {
          await tx.enrollment.upsert({
            where: { courseId_studentId: { courseId: invite!.courseId, studentId: userId } },
            create: { courseId: invite!.courseId, studentId: userId },
            update: {},
          });
        } else if (invite!.role === Role.INSTRUCTOR) {
          await tx.course.update({
            where: { id: invite!.courseId },
            data: { instructorId: userId },
          });
        }
      }
      return { orgId: organizationId, role: invite!.role };
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, emailVerified: true, isSuperAdmin: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    return this.toAuthResult({ ...user, role, organizationId: orgId });
  }

  /**
   * An existing, authenticated account creates a NEW teaching space and becomes
   * its admin — no second account. Returns a session scoped to the new org.
   */
  async createWorkspace(
    userId: string,
    dto: CreateWorkspaceDto,
  ): Promise<AuthResult> {
    const slug = await this.uniqueSlug(dto.organizationName);
    const orgId = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: dto.organizationName,
          slug,
          tagline: dto.tagline,
          primaryColor: dto.primaryColor,
        },
      });
      await tx.membership.create({
        data: {
          userId,
          organizationId: org.id,
          role: Role.ORG_ADMIN,
          status: UserStatus.ACTIVE,
        },
      });
      return org.id;
    });

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, emailVerified: true, isSuperAdmin: true },
    });
    if (!user) throw new UnauthorizedException('Account not found');
    return this.toAuthResult({ ...user, role: Role.ORG_ADMIN, organizationId: orgId });
  }

  /**
   * A short-lived token for realtime clients (Socket.IO + LiveKit). The web
   * hands this to browser JS instead of the 7-day session cookie, so an XSS
   * (if one ever slips past) steals a token that expires in minutes, not days.
   * Sockets re-fetch it on every (re)connect, so the short TTL is transparent.
   */
  mintRealtimeToken(user: JwtPayload): { token: string } {
    const payload: JwtPayload = {
      sub: user.sub,
      role: user.role,
      name: user.name,
      email: user.email,
      organizationId: user.organizationId,
      emailVerified: user.emailVerified,
      isSuperAdmin: user.isSuperAdmin,
    };
    return { token: this.jwt.sign(payload, { expiresIn: '15m' }) };
  }

  // ---------- Email verification (6-digit OTP) ----------

  /** Emails a fresh 6-digit code (10-min expiry) to the user's address. */
  async sendVerificationOtp(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.emailVerified) return;

    // crypto.randomInt (CSPRNG) — a predictable RNG would weaken the OTP.
    const code = String(randomInt(100000, 1000000));
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        verifyOtpHash: this.hashToken(code),
        verifyOtpExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });
    await this.mail.sendVerificationOtp(user.email, user.name, code);
  }

  /** Checks the OTP, marks the account verified, and returns a fresh session. */
  async verifyEmail(userId: string, code: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Account not found');
    if (user.emailVerified) return this.toAuthResult(user);
    if (
      !user.verifyOtpHash ||
      !user.verifyOtpExpiresAt ||
      user.verifyOtpExpiresAt.getTime() < Date.now() ||
      user.verifyOtpHash !== this.hashToken(code)
    ) {
      throw new BadRequestException('That code is invalid or has expired');
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        emailVerified: true,
        verifyOtpHash: null,
        verifyOtpExpiresAt: null,
      },
    });
    await this.authCache.invalidate(userId);
    return this.toAuthResult(updated);
  }
}
