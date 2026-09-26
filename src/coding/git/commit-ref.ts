import { GitHubConnectionStatus } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Where one submission's code actually lives, and what it started from.
 *
 * A submission pinned to a commit is only readable through facts that sit in
 * several different rows: the workspace holds the repository, the workspace's
 * course is the *batch* whose parent is the program, the program holds the
 * starting template, and the organisation holds the GitHub installation the
 * call must be made as. Resolving that chain was written twice — once for the
 * AI reviewer and once for the instructor's file browser — and two copies of
 * "which repository is this student's work in" is exactly the kind of thing
 * that drifts apart and starts showing one person's code to another. It lives
 * here once.
 *
 * Returns null whenever the chain does not complete: no commit, no workspace,
 * no repository, or an installation that is no longer active. Callers fall back
 * to the uploaded archive rather than treating null as "no files found".
 */
export interface CommitRef {
  /** The installation to act as. Every GitHub call is made as one institution. */
  installationId: string;
  owner: string;
  repo: string;
  fullName: string;
  /** The exact commit the student submitted. */
  sha: string;
  /** The previous attempt's commit, when there was one — the diff base. */
  previousSha: string | null;
  attemptNumber: number;
  /** The organisation login. Templates live in the same organisation. */
  orgLogin: string;
  /**
   * The program's starting code, when it has one.
   *
   * On a first attempt this is what makes a large project reviewable: the
   * instructor is shown what the student added to the starting code, not the
   * three hundred files everyone was given.
   */
  templateRepo: string | null;
  templateBranch: string;
}

export async function resolveCommitRef(
  prisma: PrismaService,
  submissionId: string,
  warn?: (message: string) => void,
): Promise<CommitRef | null> {
  const submission = await prisma.codingSubmission.findUnique({
    where: { id: submissionId },
    select: {
      commitSha: true,
      assignmentId: true,
      studentId: true,
      attemptNumber: true,
      workspace: {
        select: {
          githubRepositoryFullName: true,
          // The workspace hangs off the batch; the program above it is what
          // owns the git configuration, and so the template.
          course: {
            select: { organizationId: true, parentCourseId: true },
          },
        },
      },
    },
  });
  if (!submission?.commitSha || !submission.workspace) return null;

  const fullName = submission.workspace.githubRepositoryFullName;
  const orgId = submission.workspace.course.organizationId;
  if (!fullName || !orgId) return null;

  const connection = await prisma.gitHubOrganizationConnection.findUnique({
    where: { organizationId: orgId },
  });
  if (!connection || connection.status !== GitHubConnectionStatus.ACTIVE) {
    // Worth saying out loud: the submission is perfectly valid and the commit
    // exists, but the institution's connection has lapsed. Silence here would
    // look identical to a submission that never had a commit.
    warn?.(
      `No active GitHub connection for submission ${submissionId}; cannot read its commit`,
    );
    return null;
  }

  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;

  // Attempts are numbered per student per assignment, so "the previous attempt"
  // is exact rather than a guess at ordering by time.
  const previous = await prisma.codingSubmission.findFirst({
    where: {
      assignmentId: submission.assignmentId,
      studentId: submission.studentId,
      attemptNumber: { lt: submission.attemptNumber },
      commitSha: { not: null },
    },
    orderBy: { attemptNumber: 'desc' },
    select: { commitSha: true },
  });

  const programId = submission.workspace.course.parentCourseId;
  let templateRepo: string | null = null;
  let templateBranch = 'main';
  if (programId) {
    const config = await prisma.codingProgramGitConfig.findUnique({
      where: { courseId: programId },
      select: { templateRepositoryName: true, defaultBranch: true },
    });
    if (config?.templateRepositoryName) {
      templateRepo = config.templateRepositoryName;
      templateBranch = config.defaultBranch || 'main';
    }
  }

  return {
    installationId: connection.githubInstallationId,
    owner,
    repo,
    fullName,
    sha: submission.commitSha,
    previousSha: previous?.commitSha ?? null,
    attemptNumber: submission.attemptNumber,
    orgLogin: connection.githubOrganizationLogin,
    templateRepo,
    templateBranch,
  };
}
