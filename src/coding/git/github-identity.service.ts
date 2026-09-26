import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { JwtPayload } from '../../auth/jwt-payload';
import { PrismaService } from '../../prisma/prisma.service';
import { GITHUB_API } from '../../github/github-app.service';
import { AuditAction, AuditService } from '../../observability/audit.service';
import { ConnectGitHubIdentityDto } from './dto/github-identity.dto';

/**
 * The student's own GitHub account, connected once (§9).
 *
 * This is the one place Livetich talks to GitHub *as a person* rather than as
 * an institution, which is why it does not live in GitHubApiService — every
 * method there takes an installation id and acts for an organisation, and
 * mixing a user token into that file would blur the only invariant it has.
 *
 * The token is used for exactly one call and then discarded. It is not stored,
 * not logged, and not reused: pushing code happens from the student's own
 * machine with their own credentials, so the server never needs to act as them.
 * What is kept is only the verified login — which is what repository access is
 * granted by, and therefore the one thing that must not be taken on trust from
 * the client (§44).
 */

export interface GitHubIdentity {
  connected: boolean;
  login: string | null;
  connectedAt: Date | null;
}

interface GitHubUser {
  login?: string;
  id?: number;
  type?: string;
}

@Injectable()
export class GitHubIdentityService {
  private readonly log = new Logger(GitHubIdentityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The caller's connected GitHub account, if any. */
  async current(user: JwtPayload): Promise<GitHubIdentity> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { githubLogin: true, githubConnectedAt: true },
    });
    return {
      connected: Boolean(row?.githubLogin),
      login: row?.githubLogin ?? null,
      connectedAt: row?.githubConnectedAt ?? null,
    };
  }

  /**
   * Verify a GitHub token and record whose account it is.
   *
   * Re-running is how a student switches accounts, so this overwrites rather
   * than refusing when they are already connected.
   */
  async connect(
    user: JwtPayload,
    dto: ConnectGitHubIdentityDto,
  ): Promise<GitHubIdentity> {
    const account = await this.resolveToken(dto.token);

    // One GitHub account, one Livetich student. Without this, a second student
    // could claim the first one's account and be granted push access to their
    // repository — the unique index would stop the write, but this says why.
    const claimedElsewhere = await this.prisma.user.findFirst({
      where: { githubUserId: account.id, id: { not: user.sub } },
      select: { id: true },
    });
    if (claimedElsewhere) {
      throw new ConflictException(
        `The GitHub account @${account.login} is already connected to another Livetich account`,
      );
    }

    const saved = await this.prisma.user.update({
      where: { id: user.sub },
      data: {
        githubLogin: account.login,
        githubUserId: account.id,
        githubConnectedAt: new Date(),
      },
      select: { githubLogin: true, githubConnectedAt: true },
    });

    this.audit.record({
      action: AuditAction.CODING_GITHUB_IDENTITY_CONNECTED,
      actorId: user.sub,
      actorEmail: user.email,
      actorRole: user.role,
      orgId: user.organizationId ?? null,
      targetType: 'User',
      targetId: user.sub,
      // The login, never the token.
      metadata: { githubLogin: account.login, githubUserId: account.id },
    });

    return {
      connected: true,
      login: saved.githubLogin,
      connectedAt: saved.githubConnectedAt,
    };
  }

  /**
   * Forget the connection.
   *
   * Repositories already granted are left alone: removing someone's access to
   * work they have already done is a separate, deliberate act, not a side
   * effect of unlinking an account.
   */
  async disconnect(user: JwtPayload): Promise<GitHubIdentity> {
    const before = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { githubLogin: true },
    });

    await this.prisma.user.update({
      where: { id: user.sub },
      data: { githubLogin: null, githubUserId: null, githubConnectedAt: null },
    });

    this.audit.record({
      action: AuditAction.CODING_GITHUB_IDENTITY_DISCONNECTED,
      actorId: user.sub,
      actorEmail: user.email,
      actorRole: user.role,
      orgId: user.organizationId ?? null,
      targetType: 'User',
      targetId: user.sub,
      metadata: { githubLogin: before?.githubLogin ?? null },
    });

    return { connected: false, login: null, connectedAt: null };
  }

  // ---- The single outbound call ------------------------------------------

  /** Ask GitHub who a token belongs to. The token goes no further than here. */
  private async resolveToken(
    token: string,
  ): Promise<{ login: string; id: string }> {
    let res: Response;
    try {
      res = await fetch(`${GITHUB_API}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (err) {
      // Deliberately does not include the caught error's message: it can echo
      // the request, and the request carries the token.
      this.log.error(`GitHub identity lookup failed: ${errName(err)}`);
      throw new BadRequestException('Could not reach GitHub — try again');
    }

    if (res.status === 401 || res.status === 403) {
      throw new BadRequestException(
        'GitHub refused that sign-in — try connecting again',
      );
    }
    if (!res.ok) {
      this.log.error(`GitHub identity lookup returned ${res.status}`);
      throw new BadRequestException('GitHub could not confirm that account');
    }

    const body = (await res.json()) as GitHubUser;
    if (!body?.login || body.id == null) {
      throw new BadRequestException('GitHub returned an account with no name');
    }
    return { login: body.login, id: String(body.id) };
  }
}

/** The error's class only — never its message, which may quote the request. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown error';
}
