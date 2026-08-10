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
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthCacheService } from './auth-cache.service';
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
        passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
        resetTokenHash: null,
        resetTokenExpiresAt: null,
      },
    });
  }

  /** Student/instructor signup, gated by an org invite link. */
  async register(dto: RegisterDto): Promise<AuthResult> {
    await this.assertEmailFree(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

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
      await tx.invite.update({
        where: { id: invite!.id },
        data: { uses: { increment: 1 } },
      });
      return created;
    });

    await this.sendVerificationOtp(user.id);
    return this.toAuthResult(user);
  }

  /** Company signup — creates the Organization and its first ORG_ADMIN. */
  async registerOrganization(dto: RegisterOrganizationDto): Promise<AuthResult> {
    await this.assertEmailFree(dto.email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
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
      return tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          passwordHash,
          role: Role.ORG_ADMIN,
          organizationId: org.id,
        },
      });
    });

    await this.sendVerificationOtp(user.id);
    return this.toAuthResult(user);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Not signed in');
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Current password is incorrect');
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS) },
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
    const ok = await bcrypt.compare(dto.password, hash);
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');
    if (user.status === UserStatus.DISABLED) {
      throw new ForbiddenException('This account has been disabled');
    }
    return this.toAuthResult(user);
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
  }): AuthResult {
    const payload: JwtPayload = {
      sub: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      organizationId: user.organizationId,
      emailVerified: user.emailVerified,
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

  // ---------- Email verification (6-digit OTP) ----------

  /** Emails a fresh 6-digit code (10-min expiry) to the user's address. */
  async sendVerificationOtp(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.emailVerified) return;

    const code = String(Math.floor(100000 + Math.random() * 900000));
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
