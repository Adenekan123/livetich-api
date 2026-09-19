import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CodingWorkspaceStatus,
  GitHubConnectionStatus,
  Prisma,
} from '@prisma/client';
import type { JwtPayload } from '../../auth/jwt-payload';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubApiService } from '../../github/github-api.service';
import { AuditAction, AuditService } from '../../observability/audit.service';
import { repositoryName } from './repo-name.util';

/**
 * Provisioning a student's coding workspace.
 *
 * One enrolment in one coding program gets one private repository, created the
 * first time the student opens their workspace rather than when they enrol —
 * most enrolments never write a line of code, and an organisation should not
 * accumulate hundreds of empty repositories to find that out (§4, §10).
 *
 * Everything here is written to be run twice. A student who clicks Start twice,
 * or retries after their connection dropped mid-create, must end up with the
 * one repository they already have — never `fe-sep26-enr1042-2` (§39). Three
 * things make that true: the workspace row is unique per enrolment, the status
 * is claimed with a conditional update before any call to GitHub, and the
 * repository name is derived rather than generated, so a second attempt asks
 * GitHub for the same name and finds what the first attempt left behind.
 */

/** One row in the editor's list of the student's coding programs. */
export interface WorkspaceSummary {
  enrollmentId: string;
  /** The cohort the student is actually on, e.g. "September 2026". */
  courseTitle: string;
  /** The program it is an intake of, e.g. "Frontend Development". */
  programTitle: string;
  status: CodingWorkspaceStatus;
  repositoryFullName: string | null;
}

/**
 * How long a workspace may sit in PROVISIONING before another Start may take
 * it over. Creating a repository takes a couple of seconds; anything still
 * claimed minutes later was abandoned by a crash or a restart.
 */
const STALE_PROVISIONING_MS = 5 * 60_000;

/** What the editor is told. Deliberately not the whole row. */
export interface WorkspaceView {
  status: CodingWorkspaceStatus;
  /** Clone URL, once there is something to clone. */
  cloneUrl: string | null;
  repositoryFullName: string | null;
  defaultBranch: string;
  /** What the student should be shown when this cannot proceed. */
  blockedReason: string | null;
  courseTitle: string;
  programTitle: string;
}

@Injectable()
export class CodingWorkspaceService {
  private readonly log = new Logger(CodingWorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubApiService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Start (or re-open) the workspace for one enrolment.
   *
   * Only ever the caller's own enrolment: a student id is never taken from the
   * request. The chain student -> enrolment -> program -> workspace is
   * re-derived here on every call (§44).
   */
  async start(user: JwtPayload, enrollmentId: string): Promise<WorkspaceView> {
    const ctx = await this.loadContext(user, enrollmentId);

    // Already provisioned: hand back what exists. This is the common path once
    // a student has started, and the answer to clicking Start a second time.
    if (
      ctx.workspace?.status === CodingWorkspaceStatus.ACTIVE &&
      ctx.workspace.githubRepositoryFullName
    ) {
      return this.view(ctx, ctx.workspace.status, null);
    }
    if (ctx.workspace?.status === CodingWorkspaceStatus.ARCHIVED) {
      return this.view(
        ctx,
        ctx.workspace.status,
        'This program has finished. Your code is kept, read-only.',
      );
    }
    if (ctx.workspace?.status === CodingWorkspaceStatus.WITHDRAWN) {
      return this.view(
        ctx,
        ctx.workspace.status,
        'You are no longer on this program.',
      );
    }

    const blocked = this.blockedReason(ctx);
    if (blocked)
      return this.view(
        ctx,
        ctx.workspace?.status ?? CodingWorkspaceStatus.NOT_CREATED,
        blocked,
      );

    // Claim the work before touching GitHub. A second concurrent Start loses
    // this race and is told it is already running, rather than both creating.
    const workspace = await this.claim(
      ctx.enrollment.id,
      ctx.enrollment.courseId,
      user.sub,
    );
    if (!workspace) {
      return this.view(ctx, CodingWorkspaceStatus.PROVISIONING, null);
    }

    try {
      const provisioned = await this.provision(ctx, workspace.id);
      return this.view(
        ctx,
        provisioned.status,
        null,
        provisioned.githubRepositoryFullName,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.prisma.codingEnrollmentWorkspace.update({
        where: { id: workspace.id },
        data: {
          status: CodingWorkspaceStatus.ERROR,
          lastError: reason.slice(0, 2000),
        },
      });
      this.audit.record({
        action: AuditAction.CODING_WORKSPACE_FAILED,
        actorId: user.sub,
        orgId: ctx.organizationId,
        targetType: 'CodingEnrollmentWorkspace',
        targetId: workspace.id,
        metadata: { enrollmentId, reason },
      });
      this.log.error(
        `Workspace provisioning failed for ${enrollmentId}: ${reason}`,
      );
      throw new BadRequestException(
        "We couldn't create your coding workspace. Please try again.",
      );
    }
  }

  /** Read-only view, for the editor to poll without starting anything. */
  async get(user: JwtPayload, enrollmentId: string): Promise<WorkspaceView> {
    const ctx = await this.loadContext(user, enrollmentId);
    const status = ctx.workspace?.status ?? CodingWorkspaceStatus.NOT_CREATED;
    return this.view(ctx, status, this.blockedReason(ctx));
  }

  /**
   * The caller's coding programs — the list the editor opens on.
   *
   * Only programs actually configured for coding appear. A student's literature
   * course has no repository behind it and must not offer to make one, and the
   * check is the same one provisioning uses: a git config on the program, or on
   * the course itself when it is not an intake of anything.
   */
  async listMine(user: JwtPayload): Promise<WorkspaceSummary[]> {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        studentId: user.sub,
        OR: [
          { course: { gitConfig: { isNot: null } } },
          { course: { parentCourse: { gitConfig: { isNot: null } } } },
        ],
      },
      include: {
        course: {
          select: { title: true, parentCourse: { select: { title: true } } },
        },
        workspace: {
          select: { status: true, githubRepositoryFullName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return enrollments.map((e) => ({
      enrollmentId: e.id,
      courseTitle: e.course.title,
      programTitle: e.course.parentCourse?.title ?? e.course.title,
      status: e.workspace?.status ?? CodingWorkspaceStatus.NOT_CREATED,
      repositoryFullName: e.workspace?.githubRepositoryFullName ?? null,
    }));
  }

  // ---- Provisioning -------------------------------------------------------

  /**
   * Move the row to PROVISIONING, but only from a state where starting is
   * legitimate. Returns null when another request got there first.
   */
  private async claim(
    enrollmentId: string,
    courseId: string,
    studentId: string,
  ): Promise<{ id: string } | null> {
    const existing = await this.prisma.codingEnrollmentWorkspace.upsert({
      where: { enrollmentId },
      create: {
        enrollmentId,
        courseId,
        studentId,
        status: CodingWorkspaceStatus.NOT_CREATED,
      },
      update: {},
      select: { id: true },
    });

    const claimed = await this.prisma.codingEnrollmentWorkspace.updateMany({
      where: {
        id: existing.id,
        OR: [
          {
            status: {
              in: [
                CodingWorkspaceStatus.NOT_CREATED,
                CodingWorkspaceStatus.ERROR,
              ],
            },
          },
          // A PROVISIONING row older than this was stranded rather than being
          // worked on: the server was restarted or died between claiming the
          // work and recording the result. Without this the student's
          // workspace could never be started again, because nothing else ever
          // moves that status back. A genuine concurrent Start finishes in
          // seconds, so it is never caught by this.
          {
            status: CodingWorkspaceStatus.PROVISIONING,
            updatedAt: { lt: new Date(Date.now() - STALE_PROVISIONING_MS) },
          },
        ],
      },
      data: { status: CodingWorkspaceStatus.PROVISIONING, lastError: null },
    });
    return claimed.count === 1 ? existing : null;
  }

  private async provision(ctx: WorkspaceContext, workspaceId: string) {
    const no =
      ctx.enrollment.no ??
      (await this.allocateNumber(ctx.enrollment.id, ctx.enrollment.courseId));
    const name = repositoryName({
      programCode: ctx.programCode,
      cohortCode: ctx.cohortCode,
      enrollmentNo: no,
    });
    const owner = ctx.connectionLogin;
    const installationId = ctx.installationId;

    // Ask GitHub first. A previous attempt may have created the repository and
    // failed before recording it; creating again would be the duplicate §39
    // forbids.
    const existing = await this.github.getRepo(installationId, {
      owner,
      repo: name,
    });
    const repo =
      existing ??
      (ctx.templateRepositoryName
        ? await this.github.createRepoFromTemplate(installationId, {
            templateOwner: owner,
            templateRepo: ctx.templateRepositoryName,
            owner,
            name,
            description: `${ctx.programTitle} — ${ctx.courseTitle}`,
          })
        : await this.github.createRepo(installationId, {
            org: owner,
            name,
            description: `${ctx.programTitle} — ${ctx.courseTitle}`,
          }));

    // Push, never admin: they may commit their work, not change who sees it.
    await this.github.addCollaborator(
      installationId,
      { owner, repo: repo.name },
      ctx.githubLogin,
      'push',
    );

    const saved = await this.prisma.codingEnrollmentWorkspace.update({
      where: { id: workspaceId },
      data: {
        status: CodingWorkspaceStatus.ACTIVE,
        githubRepositoryId: repo.id,
        githubRepositoryName: repo.name,
        githubRepositoryFullName: repo.fullName,
        defaultBranch: repo.defaultBranch || ctx.defaultBranch,
        lastError: null,
        lastSyncedAt: new Date(),
      },
    });

    this.audit.record({
      action: existing
        ? AuditAction.CODING_WORKSPACE_ACCESS_GRANTED
        : AuditAction.CODING_WORKSPACE_CREATED,
      actorId: ctx.studentId,
      orgId: ctx.organizationId,
      targetType: 'CodingEnrollmentWorkspace',
      targetId: workspaceId,
      metadata: {
        enrollmentId: ctx.enrollment.id,
        repository: repo.fullName,
        githubLogin: ctx.githubLogin,
        reusedExisting: Boolean(existing),
      },
    });

    return saved;
  }

  /**
   * Give this enrolment its number, the first time one is needed.
   *
   * Allocated here rather than at enrolment so the sequence counts students who
   * actually code. The unique index on (courseId, no) is what makes it safe:
   * two concurrent allocations cannot both win, and the loser retries against
   * the new maximum instead of quietly reusing a number.
   */
  private async allocateNumber(
    enrollmentId: string,
    courseId: string,
  ): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { _max } = await this.prisma.enrollment.aggregate({
        where: { courseId },
        _max: { no: true },
      });
      const next = (_max.no ?? 0) + 1;
      try {
        await this.prisma.enrollment.update({
          where: { id: enrollmentId },
          data: { no: next },
        });
        return next;
      } catch (err) {
        const clash =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002';
        if (!clash) throw err;
      }
    }
    throw new Error('Could not allocate an enrolment number');
  }

  // ---- Context ------------------------------------------------------------

  private async loadContext(
    user: JwtPayload,
    enrollmentId: string,
  ): Promise<WorkspaceContext> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        student: {
          select: { id: true, githubLogin: true },
        },
        course: {
          include: {
            parentCourse: { include: { gitConfig: true } },
            gitConfig: true,
          },
        },
        workspace: true,
      },
    });
    if (!enrollment) throw new NotFoundException('Enrolment not found');
    // The only student whose workspace this can be is the one asking for it.
    if (enrollment.studentId !== user.sub) {
      throw new ForbiddenException('This is not your enrolment');
    }

    // A batch inherits its program's git configuration; a course with no parent
    // is itself the program.
    const program = enrollment.course.parentCourse ?? enrollment.course;
    const gitConfig =
      enrollment.course.parentCourse?.gitConfig ?? enrollment.course.gitConfig;

    const connection = enrollment.course.organizationId
      ? await this.prisma.gitHubOrganizationConnection.findUnique({
          where: { organizationId: enrollment.course.organizationId },
        })
      : null;

    return {
      enrollment,
      workspace: enrollment.workspace,
      studentId: enrollment.studentId,
      githubLogin: enrollment.student.githubLogin ?? '',
      organizationId: enrollment.course.organizationId,
      courseTitle: enrollment.course.title,
      programTitle: program.title,
      programCode: program.code,
      cohortCode: enrollment.course.code,
      templateRepositoryName: gitConfig?.templateRepositoryName ?? null,
      defaultBranch: gitConfig?.defaultBranch ?? 'main',
      hasGitConfig: Boolean(gitConfig),
      connectionLogin: connection?.githubOrganizationLogin ?? '',
      installationId: connection?.githubInstallationId ?? '',
      connectionActive: connection?.status === GitHubConnectionStatus.ACTIVE,
    };
  }

  /**
   * Why this workspace cannot be started, in words meant for the student.
   *
   * Each of these is someone else's job to fix, so the message says which —
   * a student staring at "provisioning failed" cannot tell whether to wait,
   * connect their account, or message their instructor.
   */
  private blockedReason(ctx: WorkspaceContext): string | null {
    if (!ctx.hasGitConfig) {
      return 'This program is not set up for coding yet — your instructor needs to finish connecting it.';
    }
    if (!ctx.connectionLogin || !ctx.installationId) {
      return 'This school has not connected GitHub yet — your instructor needs to do that once.';
    }
    if (!ctx.connectionActive) {
      return 'This school’s GitHub connection needs renewing — your instructor can reconnect it.';
    }
    if (!ctx.githubLogin) {
      return 'Connect your GitHub account to start coding.';
    }
    if (!ctx.programCode || !ctx.cohortCode) {
      return 'This program is missing its short code — your instructor needs to set one.';
    }
    return null;
  }

  private view(
    ctx: WorkspaceContext,
    status: CodingWorkspaceStatus,
    blockedReason: string | null,
    fullNameOverride?: string | null,
  ): WorkspaceView {
    const fullName =
      fullNameOverride ?? ctx.workspace?.githubRepositoryFullName ?? null;
    return {
      status,
      cloneUrl: fullName ? `https://github.com/${fullName}.git` : null,
      repositoryFullName: fullName,
      defaultBranch: ctx.workspace?.defaultBranch ?? ctx.defaultBranch,
      blockedReason,
      courseTitle: ctx.courseTitle,
      programTitle: ctx.programTitle,
    };
  }
}

interface WorkspaceContext {
  enrollment: {
    id: string;
    courseId: string;
    studentId: string;
    no: number | null;
  };
  workspace: {
    id: string;
    status: CodingWorkspaceStatus;
    githubRepositoryFullName: string | null;
    defaultBranch: string;
  } | null;
  studentId: string;
  githubLogin: string;
  organizationId: string | null;
  courseTitle: string;
  programTitle: string;
  programCode: string | null;
  cohortCode: string | null;
  templateRepositoryName: string | null;
  defaultBranch: string;
  hasGitConfig: boolean;
  connectionLogin: string;
  installationId: string;
  connectionActive: boolean;
}
