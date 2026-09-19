import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CodingSubmissionMode,
  GitHubConnectionStatus,
  Prisma,
  Role,
} from '@prisma/client';
import type { JwtPayload } from '../../auth/jwt-payload';
import { PrismaService } from '../../prisma/prisma.service';
import { CoursesService } from '../../courses/courses.service';
import { GitHubApiService } from '../../github/github-api.service';
import { GitHubAppService } from '../../github/github-app.service';
import { AuditAction, AuditService } from '../../observability/audit.service';
import {
  ConfigureProgramGitDto,
  ConnectGitHubDto,
} from './dto/github-connection.dto';

/**
 * Connecting an institution's GitHub organisation, and configuring which of
 * its programs provision student repositories.
 *
 * This is the half of provisioning an administrator does once. Until a
 * connection exists and a program is configured, "Start Coding Workspace"
 * can only tell the student that their instructor has not finished setting up.
 */

export interface ConnectionStatus {
  connected: boolean;
  organizationLogin: string | null;
  status: GitHubConnectionStatus | null;
  /** Where to send an owner to install the app. Null if the server has no app. */
  installUrl: string | null;
  /** False when the server has no GitHub App configured at all. */
  available: boolean;
}

@Injectable()
export class GitHubConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly app: GitHubAppService,
    private readonly github: GitHubApiService,
    private readonly audit: AuditService,
  ) {}

  /** What this workspace's GitHub connection looks like right now. */
  async status(orgId: string): Promise<ConnectionStatus> {
    const connection =
      await this.prisma.gitHubOrganizationConnection.findUnique({
        where: { organizationId: orgId },
      });
    return {
      connected: connection?.status === GitHubConnectionStatus.ACTIVE,
      organizationLogin: connection?.githubOrganizationLogin ?? null,
      status: connection?.status ?? null,
      installUrl: this.app.installUrl(),
      available: this.app.isConfigured(),
    };
  }

  /**
   * Bind an installation to this workspace.
   *
   * Idempotent by organisation: re-running with the same installation — or a
   * new one after reinstalling — updates the single row rather than adding a
   * second. Re-connecting is also how a SUSPENDED or REVOKED connection is
   * brought back, which is why status is always written, not just on create.
   */
  async connect(
    user: JwtPayload,
    orgId: string,
    dto: ConnectGitHubDto,
  ): Promise<ConnectionStatus> {
    // Resolve the claim before trusting any part of it.
    const installation = await this.app.getInstallation(dto.installationId);
    if (!installation) {
      throw new BadRequestException(
        'That GitHub installation could not be found — try installing the app again',
      );
    }
    if (installation.suspended) {
      throw new BadRequestException(
        'That installation is suspended on GitHub — an owner needs to re-enable it',
      );
    }
    // Student repositories are owned by the institution, never by a person, so
    // a personal account cannot host them (§7).
    if (
      installation.accountType &&
      installation.accountType !== 'Organization'
    ) {
      throw new BadRequestException(
        'Install Livetich on a GitHub organisation, not a personal account',
      );
    }

    // One installation belongs to one workspace. Without this, two tenants
    // could bind the same organisation and each provision into the other's
    // repositories.
    const claimedElsewhere =
      await this.prisma.gitHubOrganizationConnection.findFirst({
        where: {
          githubInstallationId: installation.id,
          organizationId: { not: orgId },
        },
        select: { id: true },
      });
    if (claimedElsewhere) {
      throw new ForbiddenException(
        'That GitHub organisation is already connected to another workspace',
      );
    }

    const saved = await this.prisma.gitHubOrganizationConnection.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        githubInstallationId: installation.id,
        githubOrganizationId: installation.accountId,
        githubOrganizationLogin: installation.accountLogin,
        status: GitHubConnectionStatus.ACTIVE,
        connectedById: user.sub,
      },
      update: {
        githubInstallationId: installation.id,
        githubOrganizationId: installation.accountId,
        githubOrganizationLogin: installation.accountLogin,
        status: GitHubConnectionStatus.ACTIVE,
        connectedById: user.sub,
      },
    });

    this.audit.record({
      action: AuditAction.GITHUB_ORG_CONNECTED,
      actorId: user.sub,
      actorEmail: user.email,
      actorRole: user.role,
      orgId,
      targetType: 'GitHubOrganizationConnection',
      targetId: saved.id,
      metadata: {
        githubOrganization: installation.accountLogin,
        installationId: installation.id,
      },
    });

    return this.status(orgId);
  }

  /**
   * Stop using the connection, without erasing it.
   *
   * Marked REVOKED rather than deleted: programs and workspaces reference it,
   * and the record of which organisation held a student's code is part of the
   * grading trail (§34). Repositories on GitHub are untouched — disconnecting
   * here must never destroy a student's work.
   */
  async disconnect(user: JwtPayload, orgId: string): Promise<ConnectionStatus> {
    const connection =
      await this.prisma.gitHubOrganizationConnection.findUnique({
        where: { organizationId: orgId },
      });
    if (!connection)
      throw new NotFoundException('No GitHub connection to remove');

    await this.prisma.gitHubOrganizationConnection.update({
      where: { id: connection.id },
      data: { status: GitHubConnectionStatus.REVOKED },
    });
    this.app.forget(connection.githubInstallationId);

    this.audit.record({
      action: AuditAction.GITHUB_ORG_DISCONNECTED,
      actorId: user.sub,
      actorEmail: user.email,
      actorRole: user.role,
      orgId,
      targetType: 'GitHubOrganizationConnection',
      targetId: connection.id,
      metadata: { githubOrganization: connection.githubOrganizationLogin },
    });

    return this.status(orgId);
  }

  // ---- Per-program configuration -----------------------------------------

  /**
   * Mark a program as coding-enabled, and optionally give it a template.
   *
   * Configured on the *program*, not on each intake: every cohort of Frontend
   * Development provisions the same way, and asking an instructor to repeat
   * this each term is how half the cohorts end up misconfigured.
   */
  async configureProgram(
    user: JwtPayload,
    orgId: string,
    courseId: string,
    dto: ConfigureProgramGitDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        parentCourseId: true,
        title: true,
        codingSubmissionMode: true,
      },
    });
    if (!course) throw new NotFoundException('Program not found');
    if (course.parentCourseId) {
      throw new BadRequestException(
        'Configure coding on the program itself — every intake of it inherits this',
      );
    }

    // The mode is written first, and deliberately before the connection check:
    // UPLOAD exists so that a workshop needs no GitHub at all, and demanding a
    // connection in order to say "this program needs no connection" would be
    // the setting refusing to let itself be set.
    if (dto.submissionMode) {
      await this.prisma.course.update({
        where: { id: courseId },
        data: { codingSubmissionMode: dto.submissionMode },
      });
    }

    // An upload program has no repositories, so there is nothing further to
    // configure and nothing to connect. Returning the program's own row keeps
    // the caller's shape honest: there is no git config, because there is no
    // git.
    if (dto.submissionMode === 'UPLOAD') {
      return this.prisma.codingProgramGitConfig.findUnique({
        where: { courseId },
      });
    }

    const connection =
      await this.prisma.gitHubOrganizationConnection.findUnique({
        where: { organizationId: orgId },
      });
    if (!connection || connection.status !== GitHubConnectionStatus.ACTIVE) {
      throw new BadRequestException('Connect a GitHub organisation first');
    }

    // Reaching here means this program provisions repositories, whether the
    // caller said so explicitly or is configuring one that already did.
    if (!dto.submissionMode && course.codingSubmissionMode === null) {
      await this.prisma.course.update({
        where: { id: courseId },
        data: { codingSubmissionMode: CodingSubmissionMode.GIT },
      });
    }

    // A template that does not exist would fail at the worst moment — when a
    // student presses Start — so it is checked now, while an admin is watching.
    let templateRepositoryId: string | null = null;
    if (dto.templateRepositoryName) {
      const template = await this.github.getRepo(
        connection.githubInstallationId,
        {
          owner: connection.githubOrganizationLogin,
          repo: dto.templateRepositoryName,
        },
      );
      if (!template) {
        throw new BadRequestException(
          `No repository called "${dto.templateRepositoryName}" in ${connection.githubOrganizationLogin}`,
        );
      }
      templateRepositoryId = template.id;
    }

    return this.prisma.codingProgramGitConfig.upsert({
      where: { courseId },
      create: {
        courseId,
        connectionId: connection.id,
        templateRepositoryName: dto.templateRepositoryName ?? null,
        templateRepositoryId,
        defaultBranch: dto.defaultBranch ?? 'main',
      },
      update: {
        connectionId: connection.id,
        templateRepositoryName: dto.templateRepositoryName ?? null,
        templateRepositoryId,
        ...(dto.defaultBranch ? { defaultBranch: dto.defaultBranch } : {}),
      },
    });
  }

  /** The program's coding configuration, or null when it has none. */
  /**
   * Is this starter repository actually usable, and if not, which step failed?
   *
   * Setting starting code means getting three separate things right on
   * github.com — the repository exists, it is marked as a template, and the
   * Livetich app can see it. Miss the third and the error is "no repository
   * called fe-starter", which reads like a typo and is not one. This reports
   * each step rather than making somebody guess which of the three they missed.
   *
   * One limit is honest rather than engineered around: GitHub answers 404 both
   * for a repository that does not exist and for one the app cannot see. From
   * outside they are indistinguishable, so the message names both causes.
   */
  async checkTemplate(user: JwtPayload, courseId: string, name: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    const connection = await this.activeConnection(courseId);
    if (!connection) {
      return {
        ok: false,
        found: false,
        isTemplate: false,
        htmlUrl: null,
        message:
          'This workspace has no live GitHub connection, so nothing can be checked yet.',
      };
    }

    const repo = await this.github.getRepo(connection.githubInstallationId, {
      owner: connection.githubOrganizationLogin,
      repo: name,
    });

    if (!repo) {
      return {
        ok: false,
        found: false,
        isTemplate: false,
        htmlUrl: null,
        message:
          `No repository called "${name}" is visible in ${connection.githubOrganizationLogin}. ` +
          'Either it does not exist, or the Livetich app has not been given access to it — ' +
          'if the app was installed on selected repositories only, a new one is not included automatically.',
      };
    }

    if (!repo.isTemplate) {
      return {
        ok: false,
        found: true,
        isTemplate: false,
        htmlUrl: repo.htmlUrl,
        message:
          `"${name}" exists, but is not marked as a template repository, so student ` +
          'repositories cannot be created from it. Turn on "Template repository" in its GitHub settings.',
      };
    }

    return {
      ok: true,
      found: true,
      isTemplate: true,
      htmlUrl: repo.htmlUrl,
      message: `"${name}" is ready — students will start from it.`,
    };
  }

  /**
   * Create the starter repository, mark it as a template, and point the program
   * at it.
   *
   * The instructor was previously expected to do three things on github.com and
   * then type the name back here, with no feedback until a student pressed
   * Start. Creating it through the app removes all three: it lands in the right
   * organisation, it is a template, and the app can obviously see it because
   * the app made it.
   *
   * It is created empty. Generating a working project server-side is a much
   * larger job, and it is not the part that was hard — the instructor was
   * always going to write their own starting code.
   */
  async createStarter(user: JwtPayload, courseId: string, name: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    const connection = await this.activeConnection(courseId);
    if (!connection) {
      throw new BadRequestException(
        'Connect this workspace to GitHub before creating a starter repository.',
      );
    }

    const owner = connection.githubOrganizationLogin;
    const installationId = connection.githubInstallationId;

    // Idempotent on purpose: a second press must not fail, and must never make
    // a second repository beside the first.
    const existing = await this.github.getRepo(installationId, {
      owner,
      repo: name,
    });
    const repo =
      existing ??
      (await this.github.createRepo(installationId, {
        org: owner,
        name,
        description: 'Starting code for Livetich students',
      }));

    if (!repo.isTemplate) {
      await this.github.markTemplate(installationId, { owner, repo: name });
    }

    await this.configureProgram(user, connection.organizationId, courseId, {
      templateRepositoryName: name,
    });

    return {
      created: !existing,
      fullName: repo.fullName,
      htmlUrl: repo.htmlUrl,
      defaultBranch: repo.defaultBranch,
    };
  }

  /** The workspace's live connection for a program, or null. */
  private async activeConnection(courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { organizationId: true },
    });
    if (!course?.organizationId) return null;
    const connection =
      await this.prisma.gitHubOrganizationConnection.findUnique({
        where: { organizationId: course.organizationId },
      });
    if (!connection || connection.status !== GitHubConnectionStatus.ACTIVE) {
      return null;
    }
    return connection;
  }

  async programConfig(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    return this.prisma.codingProgramGitConfig.findUnique({
      where: { courseId },
    });
  }

  /**
   * The coding programs this person can configure, with their starting code.
   *
   * Needed because nothing else could reach a program. Tasks hang off batches,
   * so the teaching list and the authoring list both return batch ids, while
   * the git config is keyed on the program above them. Without this, setting
   * starting code meant knowing a course id and calling the API by hand.
   *
   * The visibility rule is the one `authoringContext` already uses — an org
   * admin sees their organisation, anyone else sees the courses assigned to
   * them — narrowed to parentless courses, which is what a program is.
   */
  async listPrograms(user: JwtPayload) {
    const scope: Prisma.CourseWhereInput =
      user.role === Role.ORG_ADMIN
        ? user.organizationId
          ? { organizationId: user.organizationId }
          : { id: '__none__' }
        : { instructorId: user.sub };

    const programs = await this.prisma.course.findMany({
      where: { ...scope, parentCourseId: null },
      select: {
        id: true,
        title: true,
        code: true,
        organizationId: true,
        codingSubmissionMode: true,
        gitConfig: {
          select: { templateRepositoryName: true, defaultBranch: true },
        },
      },
      orderBy: { title: 'asc' },
    });
    if (programs.length === 0) return [];

    // One lookup rather than one per program: they are all in the same
    // organisation in every case that matters, and a lapsed connection is the
    // difference between "not set up" and "set up but needs reconnecting".
    // A course's organisation is nullable in the schema, so the nulls are
    // dropped before the query rather than sent to it. A program without an
    // organisation has no connection by definition, and falls out as
    // `connected: false` below.
    const orgIds = [
      ...new Set(
        programs
          .map((p) => p.organizationId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const connections = orgIds.length
      ? await this.prisma.gitHubOrganizationConnection.findMany({
          where: { organizationId: { in: orgIds } },
          select: { organizationId: true, status: true },
        })
      : [];
    const live = new Map(
      connections.map((c) => [
        c.organizationId,
        c.status === GitHubConnectionStatus.ACTIVE,
      ]),
    );

    return programs.map((p) => ({
      courseId: p.id,
      title: p.title,
      code: p.code,
      templateRepositoryName: p.gitConfig?.templateRepositoryName ?? null,
      defaultBranch: p.gitConfig?.defaultBranch ?? 'main',
      submissionMode: p.codingSubmissionMode,
      configured: Boolean(p.gitConfig),
      connected: p.organizationId ? (live.get(p.organizationId) ?? false) : false,
    }));
  }
}
