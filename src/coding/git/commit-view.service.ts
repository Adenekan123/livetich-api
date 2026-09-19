import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubApiService } from '../../github/github-api.service';
import { resolveCommitRef } from './commit-ref';
import { SKIP_DIRECTORIES } from './review-source';

/**
 * What an instructor is shown for a commit-backed submission (§27).
 *
 * Separate from ReviewSourceService on purpose. That one assembles text for a
 * language model under a byte budget, and drops anything a model cannot use —
 * lockfiles, images, oversized files. A human reviewing a student is asking a
 * different question and may well want to click the file the model skipped, so
 * this lists the repository as it is and leaves the reading to them.
 *
 * Every method returns null when the submission is not commit-backed, so the
 * caller can fall back to the uploaded archive instead of showing an empty
 * browser and implying the student submitted nothing.
 */

/** One file's patch, capped. A single generated file can be megabytes. */
const MAX_PATCH_BYTES = 16 * 1024;
/** And the whole set, so one enormous attempt cannot wedge the panel. */
const MAX_TOTAL_PATCH_BYTES = 256 * 1024;
/** A listing longer than this is not something anyone scrolls. */
const MAX_LISTED_FILES = 800;

export interface CommitViewFile {
  path: string;
  /** GitHub's own words on a diff: added, modified, removed, renamed. */
  status: string;
  additions: number;
  deletions: number;
  /** Known when listing a tree; unknown in a diff. */
  size: number | null;
  /** The unified diff, when there is one and it fit. */
  patch: string | null;
}

export interface CommitView {
  /**
   * Which of the two listings this is. The instructor's panel must not show
   * "+0 −0" against every file of a first attempt as though nothing changed.
   */
  kind: 'full' | 'diff';
  commitSha: string;
  shortSha: string;
  message: string;
  committedAt: string | null;
  /** Null when the commit has since gone — the submission is still valid. */
  htmlUrl: string | null;
  repositoryFullName: string;
  compareUrl: string | null;
  baseSha: string | null;
  files: CommitViewFile[];
  truncated: boolean;
}

/** One file's text, shaped to match the archive reader's result exactly. */
export interface CommitTextFile {
  path: string;
  content: string;
  language: string | null;
}

@Injectable()
export class CommitViewService {
  private readonly log = new Logger(CommitViewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubApiService,
  ) {}

  /** The commit, and what changed in it. Null if not commit-backed. */
  async forSubmission(submissionId: string): Promise<CommitView | null> {
    const ref = await resolveCommitRef(this.prisma, submissionId, (m) =>
      this.log.warn(m),
    );
    if (!ref) return null;

    const repoRef = { owner: ref.owner, repo: ref.repo };
    const commit = await this.github.getCommit(
      ref.installationId,
      repoRef,
      ref.sha,
    );

    const base = {
      commitSha: ref.sha,
      shortSha: ref.sha.slice(0, 8),
      message: commit?.message ?? '',
      committedAt: commit?.committedAt ?? null,
      htmlUrl: commit?.htmlUrl ?? null,
      repositoryFullName: ref.fullName,
    };

    if (ref.previousSha) {
      const comparison = await this.github.compareCommits(
        ref.installationId,
        repoRef,
        ref.previousSha,
        ref.sha,
      );
      // A compare fails when the earlier commit is gone — rewritten history, or
      // a repository recreated. Listing the whole tree is then correct; an
      // empty diff would read as "this student changed nothing".
      if (comparison) {
        let spent = 0;
        const files: CommitViewFile[] = comparison.files
          .slice(0, MAX_LISTED_FILES)
          .map((f) => {
            let patch: string | null = null;
            if (f.patch && spent < MAX_TOTAL_PATCH_BYTES) {
              patch =
                f.patch.length > MAX_PATCH_BYTES
                  ? `${f.patch.slice(0, MAX_PATCH_BYTES)}\n… diff truncated`
                  : f.patch;
              spent += patch.length;
            }
            return {
              path: f.path,
              status: f.status,
              additions: f.additions,
              deletions: f.deletions,
              size: null,
              patch,
            };
          });
        return {
          ...base,
          kind: 'diff',
          baseSha: ref.previousSha,
          compareUrl: `https://github.com/${ref.fullName}/compare/${ref.previousSha}...${ref.sha}`,
          files,
          truncated:
            comparison.truncated ||
            comparison.files.length > MAX_LISTED_FILES,
        };
      }
      this.log.warn(
        `Could not compare ${ref.previousSha.slice(0, 8)}..${ref.sha.slice(0, 8)}; listing the tree instead`,
      );
    }

    const tree = await this.github.listTree(
      ref.installationId,
      repoRef,
      ref.sha,
    );
    const listed = (tree?.files ?? [])
      .filter((f) => !f.path.split('/').some((s) => SKIP_DIRECTORIES.has(s)))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      ...base,
      kind: 'full',
      baseSha: null,
      compareUrl: null,
      files: listed.slice(0, MAX_LISTED_FILES).map((f) => ({
        path: f.path,
        status: 'present',
        additions: 0,
        deletions: 0,
        size: f.size,
        patch: null,
      })),
      truncated: (tree?.truncated ?? false) || listed.length > MAX_LISTED_FILES,
    };
  }

  /** One file's text at the submitted commit. Null if not commit-backed. */
  async fileAt(
    submissionId: string,
    path: string,
  ): Promise<CommitTextFile | null> {
    const ref = await resolveCommitRef(this.prisma, submissionId);
    if (!ref) return null;
    const content = await this.github.readFile(
      ref.installationId,
      { owner: ref.owner, repo: ref.repo },
      ref.sha,
      path,
    );
    if (content === null) return null;
    return { path, content, language: languageOf(path) };
  }

  /** True when this submission's code lives in a commit rather than an upload. */
  async isCommitBacked(submissionId: string): Promise<boolean> {
    const sub = await this.prisma.codingSubmission.findUnique({
      where: { id: submissionId },
      select: { commitSha: true },
    });
    return Boolean(sub?.commitSha);
  }
}

/** Editor hint only — the panel highlights by it, nothing depends on it. */
function languageOf(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.py': 'python',
    '.java': 'java',
    '.cs': 'csharp',
    '.go': 'go',
    '.rb': 'ruby',
    '.php': 'php',
    '.html': 'html',
    '.css': 'css',
    '.scss': 'scss',
    '.json': 'json',
    '.md': 'markdown',
    '.sql': 'sql',
    '.sh': 'shellscript',
    '.yml': 'yaml',
    '.yaml': 'yaml',
  };
  return map[ext] ?? null;
}
