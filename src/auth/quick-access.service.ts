import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { hash as bcryptHash, verify as bcryptVerify } from '@node-rs/bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The student's fast lane: a shortcut they can keep on their home screen, and a
 * passcode instead of an email and password every time.
 *
 * The shape of it matters more than the code. The URL carries only an opaque
 * slug — it names nobody, and on its own it opens nothing. The passcode is what
 * authenticates, and it is what a shared screenshot or a synced browser history
 * does not contain. Redeeming the two together mints the *same session a
 * password login mints*, so this adds no new authenticated state to the system;
 * it is a second door into the one that already exists.
 */
@Injectable()
export class QuickAccessService {
  private readonly logger = new Logger(QuickAccessService.name);

  /** Matching the password hashing already used for accounts. */
  private static readonly BCRYPT_ROUNDS = 12;
  /** Six digits, not four: the slug may be shared, so the code carries the weight. */
  private static readonly CODE_LENGTH = 6;
  /** Wrong codes before the shortcut is frozen. */
  private static readonly MAX_ATTEMPTS = 5;
  /** How long it stays frozen. Long enough to make guessing pointless, short
   *  enough that a student who fumbled it is not locked out of their lesson. */
  private static readonly LOCK_MINUTES = 15;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Codes a person picks when told "choose six digits". Rejected outright
   * rather than scored, because a warning that can be clicked past is, in
   * practice, no rule at all.
   */
  private static readonly BLOCKLIST = new Set([
    '000000',
    '111111',
    '222222',
    '333333',
    '444444',
    '555555',
    '666666',
    '777777',
    '888888',
    '999999',
    '123456',
    '654321',
    '121212',
    '112233',
    '123123',
    '789456',
    '159753',
    '147258',
    '696969',
    '101010',
    '202020',
    '123321',
    '456456',
    '789789',
    '012345',
    '543210',
    '111222',
    '222111',
  ]);

  /** Every ascending or descending run of the required length, e.g. 345678. */
  private static isSequential(code: string): boolean {
    let up = true;
    let down = true;
    for (let i = 1; i < code.length; i++) {
      const step = code.charCodeAt(i) - code.charCodeAt(i - 1);
      if (step !== 1) up = false;
      if (step !== -1) down = false;
    }
    return up || down;
  }

  private assertUsableCode(code: string): void {
    if (!new RegExp(`^\\d{${QuickAccessService.CODE_LENGTH}}$`).test(code)) {
      throw new BadRequestException(
        `Your code must be exactly ${QuickAccessService.CODE_LENGTH} digits.`,
      );
    }
    if (QuickAccessService.BLOCKLIST.has(code)) {
      throw new BadRequestException(
        'That code is too easy to guess. Pick something less obvious.',
      );
    }
    if (QuickAccessService.isSequential(code)) {
      throw new BadRequestException(
        'Codes that run straight up or down are too easy to guess.',
      );
    }
    if (new Set(code).size === 1) {
      throw new BadRequestException(
        'A code of one repeated digit is too easy to guess.',
      );
    }
    // A year is the other thing everybody reaches for.
    if (/^(19|20)\d{2}(19|20)\d{2}$/.test(code)) {
      throw new BadRequestException('Pick something that is not a year.');
    }
  }

  /** Opaque, URL-safe, and long enough that slugs are not worth enumerating. */
  private async mintSlug(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const slug = randomBytes(9).toString('base64url'); // 12 chars
      const clash = await this.prisma.quickAccess.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!clash) return slug;
    }
    throw new Error('Could not allocate a quick-access slug');
  }

  /**
   * Create or replace this student's shortcut for a workspace.
   *
   * Replacing rotates the slug as well as the code: a student resetting this
   * has usually lost control of the old link, and leaving it live would defeat
   * the point of resetting.
   */
  async setPasscode(
    userId: string,
    organizationId: string,
    passcode: string,
  ): Promise<{ slug: string }> {
    this.assertUsableCode(passcode);
    const membership = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { id: true },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of this workspace');
    }

    const slug = await this.mintSlug();
    const passcodeHash = await bcryptHash(
      passcode,
      QuickAccessService.BCRYPT_ROUNDS,
    );
    await this.prisma.quickAccess.upsert({
      where: { userId_organizationId: { userId, organizationId } },
      create: { userId, organizationId, slug, passcodeHash },
      update: {
        slug,
        passcodeHash,
        failedAttempts: 0,
        lockedUntil: null,
        revokedAt: null,
      },
    });
    return { slug };
  }

  /** What the student sees for this workspace, if anything. */
  async current(
    userId: string,
    organizationId: string,
  ): Promise<{ slug: string; lastUsedAt: Date | null } | null> {
    const row = await this.prisma.quickAccess.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { slug: true, lastUsedAt: true, revokedAt: true },
    });
    if (!row || row.revokedAt) return null;
    return { slug: row.slug, lastUsedAt: row.lastUsedAt };
  }

  /** Turn the shortcut off. The row stays so its slug is never reissued. */
  async revoke(userId: string, organizationId: string): Promise<void> {
    await this.prisma.quickAccess.updateMany({
      where: { userId, organizationId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * What the passcode screen may show before anyone has proved anything.
   *
   * Deliberately only the workspace: its name and its branding. Not the
   * student's name, not their email, not their classes — anyone who finds the
   * link would otherwise learn who it belongs to, which is a privacy leak that
   * costs nothing to avoid.
   */
  async describe(slug: string): Promise<{
    workspaceName: string;
    logoUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    organizationId: string;
  }> {
    const row = await this.prisma.quickAccess.findUnique({
      where: { slug },
      select: {
        revokedAt: true,
        organizationId: true,
        organization: {
          select: {
            name: true,
            logoUrl: true,
            primaryColor: true,
            accentColor: true,
          },
        },
      },
    });
    if (!row || row.revokedAt) throw new NotFoundException('Unknown shortcut');
    return {
      workspaceName: row.organization.name,
      logoUrl: row.organization.logoUrl,
      primaryColor: row.organization.primaryColor,
      accentColor: row.organization.accentColor,
      // Which workspace this shortcut belongs to, so a session from a different
      // one is never shown this workspace's branding. It identifies the
      // organisation, never the student.
      organizationId: row.organizationId,
    };
  }

  /**
   * Check the code and hand back the user to sign in as.
   *
   * Returns the user rather than a token: minting sessions belongs to
   * AuthService, and keeping it there is what guarantees a quick-access session
   * is indistinguishable from any other.
   */
  async redeem(slug: string, passcode: string): Promise<{ userId: string }> {
    const row = await this.prisma.quickAccess.findUnique({
      where: { slug },
      select: {
        id: true,
        userId: true,
        passcodeHash: true,
        failedAttempts: true,
        lockedUntil: true,
        revokedAt: true,
        user: { select: { status: true } },
      },
    });
    // One message for every failure below, so probing cannot tell an unknown
    // slug from a known one with the wrong code.
    const refuse = () =>
      new UnauthorizedException('That code is not right for this shortcut.');
    if (!row || row.revokedAt) throw refuse();

    if (row.lockedUntil && row.lockedUntil > new Date()) {
      const mins = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new UnauthorizedException(
        `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}, ` +
          `or sign in with your email and password.`,
      );
    }

    const ok = await bcryptVerify(passcode, row.passcodeHash);
    if (!ok) {
      const attempts = row.failedAttempts + 1;
      const lock = attempts >= QuickAccessService.MAX_ATTEMPTS;
      await this.prisma.quickAccess.update({
        where: { id: row.id },
        data: {
          failedAttempts: lock ? 0 : attempts,
          lockedUntil: lock
            ? new Date(Date.now() + QuickAccessService.LOCK_MINUTES * 60_000)
            : null,
        },
      });
      if (lock) {
        this.logger.warn(`Quick access ${slug} locked after repeated failures`);
      }
      throw refuse();
    }

    // A disabled account must not have a second way in.
    if (row.user.status === UserStatus.DISABLED) {
      throw new ForbiddenException('This account has been disabled');
    }

    await this.prisma.quickAccess.update({
      where: { id: row.id },
      data: { failedAttempts: 0, lockedUntil: null, lastUsedAt: new Date() },
    });
    return { userId: row.userId };
  }
}
