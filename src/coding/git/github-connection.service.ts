import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GitHubConnectionStatus, Prisma, Role } from '@prisma/client';
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
      select: { id: true, parentCourseId: true, title: true },
    });
    if (!course) throw new NotFoundException('Program not found');
    if (course.parentCourseId) {
      throw new BadRequestException(
        'Configure coding on the program itself — every intake of it inherits this',
      );
    }

    const connection =
      await this.prisma.gitHubOrganizationConnection.findUnique({
        where: { organizationId: orgId },
      });
    if (!connection || connection.status !== GitHubConnectionStatus.ACTIVE) {
      throw new BadRequestException('Connect a GitHub organisation first');
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
      configured: Boolean(p.gitConfig),
      connected: p.organizationId ? (live.get(p.organizationId) ?? false) : false,
    }));
  }
}
