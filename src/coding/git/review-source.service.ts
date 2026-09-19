import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubApiService } from '../../github/github-api.service';
import { resolveCommitRef } from './commit-ref';
import { AI_TEXT_BUDGET_BYTES } from '../coding-submissions.service';
import {
  isReviewable,
  renderSource,
  reviewOrder,
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
      // A compare can fail if the earlier commit is gone — rewritten history,
      // or a repository recreated. Reviewing the whole tree is then correct;
      // an empty diff would invite failing requirements whose code was simply
      // never sent.
      if (diff) return diff;
      this.log.warn(
        `Could not diff ${resolved.previousSha.slice(0, 8)}..${resolved.sha.slice(0, 8)}; reading the full tree instead`,
      );
    }

    return this.readFull(installationId, ref, resolved.sha, budgetBytes);
  }

  /** Convenience for the reviewer: the rendered block, or null. */
  async renderForSubmission(submissionId: string): Promise<string | null> {
    const source = await this.forSubmission(submissionId);
    return source ? renderSource(source) : null;
  }

  // ---- The two shapes ----------------------------------------------------

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
