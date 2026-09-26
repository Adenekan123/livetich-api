import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubApiService } from '../../github/github-api.service';
import { resolveCommitRef, type CommitRef } from './commit-ref';
import { AI_TEXT_BUDGET_BYTES } from '../coding-submissions.service';
import {
  isReviewable,
  renderSource,
  reviewOrder,
  studentOwnFiles,
  type ReviewSource,
  type SourceFile,
} from './review-source';

/**
 * Assembles what the AI reviewer is shown for a commit-backed submission.
 *
 * A first attempt is read as the repository stands at the submitted commit. A
 * resubmission is read as a diff against the previous attempt plus the full
 * text of the files that changed (§26) — far cheaper than re-reading a whole
 * project on every attempt, and closer to what an instructor actually looks at.
 *
 * Returns null when the submission has no commit behind it, so the caller can
 * fall back to the archive path rather than this pretending to have found
 * nothing.
 */
@Injectable()
export class ReviewSourceService {
  private readonly log = new Logger(ReviewSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubApiService,
  ) {}

  /** The source for one submission, or null if it is not commit-backed. */
  async forSubmission(
    submissionId: string,
    budgetBytes = AI_TEXT_BUDGET_BYTES,
  ): Promise<ReviewSource | null> {
    const resolved = await resolveCommitRef(this.prisma, submissionId, (m) =>
      this.log.warn(m),
    );
    if (!resolved) return null;

    const ref = { owner: resolved.owner, repo: resolved.repo };
    const installationId = resolved.installationId;

    if (resolved.previousSha) {
      const diff = await this.readDiff(
        installationId,
        ref,
        resolved.previousSha,
        resolved.sha,
        budgetBytes,
      );
      // Two different things end up here, and the second was a real bug.
      //
      // A compare can fail outright — the earlier commit is gone, history was
      // rewritten, the repository was recreated.
      //
      // Or it can succeed with nothing in it, which is what happens when a
      // student submits the identical commit twice. That handed the reviewer an
      // empty source and the words "no readable source files were found" — a
      // sentence that reads like the pipeline broke, and invites the model to
      // fail every requirement on work that may be perfectly good.
      //
      // Neither is reviewable, so both fall through and judge the work as it
      // stands. A patch with no readable body still counts as a real diff.
      if (diff && (diff.files.length > 0 || diff.patches.length > 0)) {
        return diff;
      }
      this.log.warn(
        diff
          ? `Attempt ${resolved.attemptNumber} is identical to ${resolved.previousSha.slice(0, 8)}; reviewing the work as it stands`
          : `Could not diff ${resolved.previousSha.slice(0, 8)}..${resolved.sha.slice(0, 8)}; reading the full tree instead`,
      );
    }

    // Not `else`: a resubmission whose diff was empty should still be measured
    // against the starting code rather than dumped on the reviewer whole.
    if (resolved.templateRepo) {
      // A first attempt on a program with starting code. Reading the whole
      // repository here is how the reviewer went blind on a large project: a
      // Next.js tree overruns the budget long before the student's own files
      // are reached, so it marked work it had mostly not been shown.
      const own = await this.readAgainstTemplate(
        resolved,
        ref,
        installationId,
        budgetBytes,
      );
      if (own) return own;
      this.log.warn(
        `Could not read template ${resolved.orgLogin}/${resolved.templateRepo}; reading the full tree instead`,
      );
    }

    return this.readFull(installationId, ref, resolved.sha, budgetBytes);
  }

  /** Convenience for the reviewer: the rendered block, or null. */
  async renderForSubmission(submissionId: string): Promise<string | null> {
    const source = await this.forSubmission(submissionId);
    return source ? renderSource(source) : null;
  }

  // ---- The three shapes --------------------------------------------------

  /**
   * A first attempt, reduced to what the student added to the starting code.
   *
   * Returns null when either tree cannot be read, so the caller falls back to
   * the whole repository rather than reviewing an empty set. An empty result
   * from a *successful* comparison is not null — a student who changed nothing
   * is a real answer, and the prompt says so.
   */
  private async readAgainstTemplate(
    ref: CommitRef,
    repoRef: { owner: string; repo: string },
    installationId: string,
    budgetBytes: number,
  ): Promise<ReviewSource | null> {
    if (!ref.templateRepo) return null;

    const [student, template] = await Promise.all([
      this.github.listTree(installationId, repoRef, ref.sha),
      this.github.listTree(
        installationId,
        { owner: ref.orgLogin, repo: ref.templateRepo },
        ref.templateBranch,
      ),
    ]);
    if (!student || !template) return null;

    const { own } = studentOwnFiles(student.files, template.files, (f) =>
      isReviewable(f.path, f.size),
    );

    const { files, truncated } = await this.fetchWithin(
      installationId,
      repoRef,
      ref.sha,
      own.slice().sort(reviewOrder).map((f) => f.path),
      budgetBytes,
    );

    return {
      kind: 'template',
      files,
      patches: [],
      truncated: truncated || student.truncated || template.truncated,
    };
  }

  private async readFull(
    installationId: string,
    ref: { owner: string; repo: string },
    sha: string,
    budgetBytes: number,
  ): Promise<ReviewSource | null> {
    const tree = await this.github.listTree(installationId, ref, sha);
    if (!tree) return null;

    const candidates = tree.files
      .filter((f) => isReviewable(f.path, f.size))
      .sort(reviewOrder);

    const { files, truncated } = await this.fetchWithin(
      installationId,
      ref,
      sha,
      candidates.map((c) => c.path),
      budgetBytes,
    );

    return {
      kind: 'full',
      files,
      patches: [],
      // Only budget exhaustion, or GitHub's own limit on a huge tree, counts as
      // truncation. Files excluded on purpose — node_modules, lockfiles,
      // binaries — are not something the reviewer needs warning about, and
      // counting them would fire the warning on nearly every review until it
      // meant nothing and the model hedged on code it could see perfectly well.
      truncated: truncated || tree.truncated,
    };
  }

  private async readDiff(
    installationId: string,
    ref: { owner: string; repo: string },
    base: string,
    head: string,
    budgetBytes: number,
  ): Promise<ReviewSource | null> {
    const comparison = await this.github.compareCommits(
      installationId,
      ref,
      base,
      head,
    );
    if (!comparison) return null;

    // Deleted files have no contents to read, and their patch already says so.
    const changed = comparison.files.filter((f) => f.status !== 'removed');

    const patches = comparison.files
      .filter((f) => f.patch)
      .map((f) => ({
        path: f.path,
        status: f.status,
        patch: f.patch as string,
      }));

    // Patches are the smaller, more informative half, so they are charged
    // against the budget first and the file bodies fill what is left.
    const patchBytes = patches.reduce((n, p) => n + p.patch.length, 0);
    const remaining = Math.max(0, budgetBytes - patchBytes);

    const readable = changed
      .filter((f) => isReviewable(f.path, 0))
      .sort(reviewOrder);

    const { files, truncated } = await this.fetchWithin(
      installationId,
      ref,
      head,
      readable.map((f) => f.path),
      remaining,
    );

    return {
      kind: 'diff',
      files,
      patches,
      truncated: truncated || comparison.truncated,
      baseSha: base,
    };
  }

  /**
   * Read files in order until the budget runs out.
   *
   * Sequential on purpose: the point is to stop early, and firing every request
   * in parallel would fetch a whole repository to then discard most of it.
   */
  private async fetchWithin(
    installationId: string,
    ref: { owner: string; repo: string },
    sha: string,
    paths: string[],
    budgetBytes: number,
  ): Promise<{ files: SourceFile[]; truncated: boolean }> {
    const files: SourceFile[] = [];
    let used = 0;

    for (const path of paths) {
      if (used >= budgetBytes) {
        return { files, truncated: true };
      }
      const content = await this.github.readFile(
        installationId,
        ref,
        sha,
        path,
      );
      if (content === null) continue; // binary, or GitHub declined to inline it
      if (used + content.length > budgetBytes) {
        // Stop rather than truncating mid-file: half a file reads as a file
        // that simply ends, and a reviewer would judge it as written.
        return { files, truncated: true };
      }
      files.push({ path, content });
      used += content.length;
    }

    return { files, truncated: false };
  }
}
