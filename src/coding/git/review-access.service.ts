import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { JwtPayload } from '../../auth/jwt-payload';
import { PrismaService } from '../../prisma/prisma.service';
import { CoursesService } from '../../courses/courses.service';
import { GitHubApiService } from '../../github/github-api.service';
import { resolveCommitRef } from './commit-ref';

/**
 * Whether the person about to mark a submission can actually fetch it.
 *
 * Marking locally is the one part of this feature that runs on the
 * instructor's own machine with the instructor's own GitHub credentials, and
 * it is the one part Livetich cannot make work by itself: provisioning grants
 * the *student* push on their repository and grants the instructor nothing.
 * An instructor who is a plain member of the organisation therefore gets
 * repositories created perfectly and a `fetch` that fails at the moment they
 * sit down to mark — which looks like a broken feature and is a GitHub
 * setting.
 *
 * Asked before the checkout rather than discovered during it, so the answer
 * arrives as a sentence about organisation access instead of git's.
 */

/** What the instructor has to do about it, for the editor to act on. */
export type ReviewAccessRemedy =
  'CONNECT_GITHUB' | 'ORGANISATION_ACCESS' | 'NO_COMMIT' | null;

export interface ReviewAccess {
  /** The only question the editor actually asks. */
  canRead: boolean;
  /** The reviewer's connected GitHub account, when they have one. */
  login: string | null;
  organizationLogin: string | null;
  repositoryFullName: string | null;
  /** Why not, in words meant for the instructor. Null when they can read it. */
  reason: string | null;
  remedy: ReviewAccessRemedy;
}

@Injectable()
export class ReviewAccessService {
  private readonly log = new Logger(ReviewAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly github: GitHubApiService,
  ) {}

  async forSubmission(
    user: JwtPayload,
    submissionId: string,
  ): Promise<ReviewAccess> {
    const submission = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      select: { id: true, assignment: { select: { courseId: true } } },
    });
    if (!submission) throw new NotFoundException('Submission not found');
    // Only someone who manages the course may ask about its repositories — the
    // answer names an organisation and a repository a student must not learn.
    await this.courses.assertCanManageCourse(
      user,
      submission.assignment.courseId,
    );

    const ref = await resolveCommitRef(this.prisma, submissionId);
    if (!ref) {
      return {
        canRead: false,
        login: null,
        organizationLogin: null,
        repositoryFullName: null,
        reason:
          'This submission is an uploaded archive rather than a commit, so there is no repository to check out.',
        remedy: 'NO_COMMIT',
      };
    }

    const me = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { githubLogin: true },
    });
    const login = me?.githubLogin ?? null;
    if (!login) {
      return {
        canRead: false,
        login: null,
        organizationLogin: ref.orgLogin,
        repositoryFullName: ref.fullName,
        reason:
          'Connect your GitHub account, so Livetich can tell whether you are able to read your students’ repositories.',
        remedy: 'CONNECT_GITHUB',
      };
    }

    // Fails open, deliberately. This check exists to turn a git error into a
    // sentence about GitHub — it is not an authorisation boundary, and the
    // real one is GitHub itself a moment later. If GitHub is unreachable, or
    // the installation cannot answer this particular question, saying no would
    // invent a way to stop an instructor marking work they can read perfectly
    // well.
    let permission: 'admin' | 'write' | 'read' | 'none' | null;
    try {
      permission = await this.github.collaboratorPermission(
        ref.installationId,
        { owner: ref.owner, repo: ref.repo },
        login,
      );
    } catch (error) {
      this.log.warn(
        `Could not check ${login}'s access to ${ref.fullName}; letting the checkout proceed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        canRead: true,
        login,
        organizationLogin: ref.orgLogin,
        repositoryFullName: ref.fullName,
        reason: null,
        remedy: null,
      };
    }

    const canRead =
      permission === 'admin' || permission === 'write' || permission === 'read';

    return {
      canRead,
      login,
      organizationLogin: ref.orgLogin,
      repositoryFullName: ref.fullName,
      reason: canRead
        ? null
        : `${login} cannot read ${ref.fullName}. Student repositories are private to the ${ref.orgLogin} organisation, and Livetich never grants instructors access to them — a GitHub owner has to make you an owner of ${ref.orgLogin}, or add you to a team with read access.`,
      remedy: canRead ? null : 'ORGANISATION_ACCESS',
    };
  }
}
