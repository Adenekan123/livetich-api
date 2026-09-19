import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubApiService } from '../../github/github-api.service';
import type { TreeEntry } from '../../github/github-api.service';
import { resolveCommitRef, type CommitRef } from './commit-ref';
import { SKIP_DIRECTORIES, studentOwnFiles } from './review-source';

/**
 * What an instructor is shown for a commit-backed submission (§27).
 *
 * Separate from ReviewSourceService on purpose. That one assembles text for a
 * language model under a byte budget, and drops anything a model cannot use —
 * lockfiles, images, oversized files. A human reviewing a student is asking a
 * different question and may well want to click the file the model skipped, so
 * this lists the repository as it is and leaves the reading to them.
 *
 * Three shapes, in order of how much they spare the reader:
 *
 *  - `diff`     — a resubmission, compared against the previous attempt.
 *  - `template` — a first attempt on a program that ships starting code. Shows
 *                 only what the student added to it, which is the difference
 *                 between reviewing six files and reviewing three hundred.
 *  - `full`     — everything else: the repository as it stands at the commit.
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
   * Which of the three listings this is. The instructor's panel must not show
   * "+0 -0" against every file of a first attempt as though nothing changed.
   */
  kind: 'full' | 'diff' | 'template';
  commitSha: string;
  shortSha: string;
  message: string;
  committedAt: string | null;
  /** Null when the commit has since gone — the submission is still valid. */
  htmlUrl: string | null;
  repositoryFullName: string;
  compareUrl: string | null;
  baseSha: string | null;
  /** What this listing is measured against, in words for a human. */
  baseLabel: string | null;
  /** Files left exactly as the starting code. Only meaningful for `template`. */
  unchangedCount: number;
  files: CommitViewFile[];
  truncated: boolean;
}

/** One file's text, shaped to match the archive reader's result exactly. */
export interface CommitTextFile {
  path: string;
  content: string;
  language: string | null;
}

/** Dependencies and build output are nobody's coursework. */
function isStudentPath(path: string): boolean {
  return !path.split('/').some((s) => SKIP_DIRECTORIES.has(s));
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
      const diff = await this.readDiff(ref, repoRef, base);
      // A compare can fail outright, or succeed with nothing in it when a
      // student submits the identical commit twice. An empty "Changed files"
      // list tells the instructor nothing either way, so both fall through to
      // something that does.
      if (diff && diff.files.length > 0) return diff;
      this.log.warn(
        diff
          ? `Attempt ${ref.attemptNumber} is identical to ${ref.previousSha.slice(0, 8)}; showing the work instead`
          : `Could not compare ${ref.previousSha.slice(0, 8)}..${ref.sha.slice(0, 8)}; listing the tree instead`,
      );
    }

    // Not `else`: a resubmission with an empty diff is still better shown
    // against the starting code than as the whole repository.
    if (ref.templateRepo) {
      const against = await this.readAgainstTemplate(ref, repoRef, base);
      if (against) return against;
      this.log.warn(
        `Could not read template ${ref.orgLogin}/${ref.templateRepo}; listing the tree instead`,
      );
    }

    return this.readTree(ref, repoRef, base);
  }

  // ---- The three shapes ---------------------------------------------------

  private async readDiff(
    ref: CommitRef,
    repoRef: { owner: string; repo: string },
    base: Omit<
      CommitView,
      | 'kind'
      | 'compareUrl'
      | 'baseSha'
      | 'baseLabel'
      | 'unchangedCount'
      | 'files'
      | 'truncated'
    >,
  ): Promise<CommitView | null> {
    if (!ref.previousSha) return null;
    const comparison = await this.github.compareCommits(
      ref.installationId,
      repoRef,
      ref.previousSha,
      ref.sha,
    );
    if (!comparison) return null;

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
      baseLabel: `attempt #${ref.attemptNumber - 1}`,
      unchangedCount: 0,
      compareUrl: `https://github.com/${ref.fullName}/compare/${ref.previousSha}...${ref.sha}`,
      files,
      truncated:
        comparison.truncated || comparison.files.length > MAX_LISTED_FILES,
    };
  }

  /**
   * A first attempt, measured against the program's starting code.
   *
   * Repositories created from a GitHub template share no history with it, so
   * this cannot be a commit comparison. It compares the two trees by blob hash
   * instead: a file the template does not have is new, and a file whose hash
   * differs is one the student edited. Everything else is the starting code and
   * is counted rather than listed.
   */
  private async readAgainstTemplate(
    ref: CommitRef,
    repoRef: { owner: string; repo: string },
    base: Omit<
      CommitView,
      | 'kind'
      | 'compareUrl'
      | 'baseSha'
      | 'baseLabel'
      | 'unchangedCount'
      | 'files'
      | 'truncated'
    >,
  ): Promise<CommitView | null> {
    if (!ref.templateRepo) return null;

    const [student, template] = await Promise.all([
      this.github.listTree(ref.installationId, repoRef, ref.sha),
      this.github.listTree(
        ref.installationId,
        { owner: ref.orgLogin, repo: ref.templateRepo },
        ref.templateBranch,
      ),
    ]);
    if (!student || !template) return null;

    // Shared with the AI reviewer on purpose: the instructor's file list and
    // the model's source must agree on whose work is whose.
    const { own, unchangedCount: unchanged } = studentOwnFiles(
      student.files,
      template.files,
      (f) => isStudentPath(f.path),
    );
    const mine = own
      .map((f) => entry(f, f.status))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      ...base,
      kind: 'template',
      baseSha: null,
      baseLabel: 'the starting code',
      unchangedCount: unchanged,
      compareUrl: null,
      files: mine.slice(0, MAX_LISTED_FILES),
      truncated:
        student.truncated ||
        template.truncated ||
        mine.length > MAX_LISTED_FILES,
    };
  }

  private async readTree(
    ref: CommitRef,
    repoRef: { owner: string; repo: string },
    base: Omit<
      CommitView,
      | 'kind'
      | 'compareUrl'
      | 'baseSha'
      | 'baseLabel'
      | 'unchangedCount'
      | 'files'
      | 'truncated'
    >,
  ): Promise<CommitView> {
    const tree = await this.github.listTree(
      ref.installationId,
      repoRef,
      ref.sha,
    );
    const listed = (tree?.files ?? [])
      .filter((f) => isStudentPath(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      ...base,
      kind: 'full',
      baseSha: null,
      baseLabel: null,
      unchangedCount: 0,
      compareUrl: null,
      files: listed.slice(0, MAX_LISTED_FILES).map((f) => entry(f, 'present')),
      truncated: (tree?.truncated ?? false) || listed.length > MAX_LISTED_FILES,
    };
  }

  // ---- Reading one file ---------------------------------------------------

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

function entry(f: TreeEntry, status: string): CommitViewFile {
  return {
    path: f.path,
    status,
    additions: 0,
    deletions: 0,
    size: f.size,
    patch: null,
  };
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
