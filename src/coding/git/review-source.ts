/**
 * What the AI reviewer is shown for a commit-backed submission.
 *
 * Two shapes, and the difference matters enough that the prompt says which it
 * got. A first attempt has nothing to compare against, so the reviewer sees the
 * repository as it stands. A resubmission is shown what changed since the last
 * attempt, plus the full text of the changed files — a patch alone shows
 * altered lines with no surrounding code, and "does this meet the requirement"
 * cannot be answered from fragments.
 *
 * Telling the model which of the two it received is not a detail: a reviewer
 * that believes it saw a whole project, when it was handed six changed files,
 * will confidently mark absent requirements as failed (§25).
 */

/**
 * Directories that are never the student's own work — dependencies, build
 * output, the repository's own metadata.
 *
 * Exported because the instructor's file browser needs the same exclusion: a
 * repository with `node_modules` committed would otherwise list thousands of
 * entries and bury the handful of files the student actually wrote. Only this
 * set is shared — the lockfile and extension filters below are about what is
 * worth spending an AI budget on, which is a different question from what a
 * human may want to click.
 */
export const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.git',
]);

/** Extensions that are text but carry no reviewable meaning. */
const SKIP_EXTENSIONS = new Set([
  '.lock',
  '.map',
  '.min.js',
  '.min.css',
  '.snap',
  '.svg',
  '.csv',
]);

/**
 * Lockfiles, matched by name rather than extension.
 *
 * `.lock` catches yarn and Cargo, but pnpm's is `pnpm-lock.yaml` and npm's is
 * `package-lock.json` — both ordinary extensions. They are thousands of
 * generated lines that would crowd the student's actual code out of the
 * budget, and no requirement was ever met by one.
 */
const SKIP_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'composer.lock',
  'gemfile.lock',
  'poetry.lock',
  'pipfile.lock',
  'cargo.lock',
  'go.sum',
]);

/** Anything larger than this is generated, vendored, or data — not authored. */
export const MAX_FILE_BYTES = 64 * 1024;

export interface SourceFile {
  path: string;
  content: string;
}

export interface ReviewSource {
  /**
   * How this was assembled, so the prompt can be honest about it.
   *
   * `template` is a first attempt on a program that ships starting code: only
   * the files the student added or changed. Like `diff`, it is a subset, and
   * the prompt must say so.
   */
  kind: 'full' | 'diff' | 'template';
  files: SourceFile[];
  /** Unified diffs, when reviewing a resubmission. */
  patches: { path: string; status: string; patch: string }[];
  /** True when the budget or GitHub's own limits cut the listing short. */
  truncated: boolean;
  /** The attempt this was compared against, when there was one. */
  baseSha?: string;
}

/** Whether a path is worth reading at all. */
export function isReviewable(path: string, size: number): boolean {
  if (size > MAX_FILE_BYTES) return false;
  const segments = path.split('/');
  if (segments.some((s) => SKIP_DIRECTORIES.has(s))) return false;
  const name = segments[segments.length - 1].toLowerCase();
  if (SKIP_FILENAMES.has(name)) return false;
  for (const ext of SKIP_EXTENSIONS) {
    if (name.endsWith(ext)) return false;
  }
  // Dotfiles are configuration, not the work being marked — with the exception
  // of nothing, currently: a student's .eslintrc is not what they are graded on.
  return !name.startsWith('.');
}

/**
 * Order files so the most likely-relevant survive the budget.
 *
 * Source directories first, then shallower paths, then smaller files — a
 * reviewer that runs out of budget should lose a deep fixture rather than the
 * entry point.
 */
export function reviewOrder(a: { path: string }, b: { path: string }): number {
  const score = (p: string) => {
    if (/^(src|app|lib)\//.test(p)) return 0;
    if (p.includes('/')) return 2;
    return 1; // root-level files: README, index, entry points
  };
  const byScore = score(a.path) - score(b.path);
  if (byScore !== 0) return byScore;
  const byDepth = a.path.split('/').length - b.path.split('/').length;
  if (byDepth !== 0) return byDepth;
  return a.path.localeCompare(b.path);
}

/** One entry in a repository tree, as both services receive it. */
export interface TreeFile {
  path: string;
  /** The blob's content hash — identical content has an identical sha. */
  sha: string;
  size: number;
}

export type OwnedFile = TreeFile & { status: 'added' | 'modified' };

/**
 * Which files in a student's repository are the student's own work.
 *
 * A repository created from a GitHub template shares no history with that
 * template, so there is no merge base and no commit to compare against. But
 * two identical files have the same blob sha in both trees, so a file the
 * template does not have is new, and one whose sha differs was edited.
 * Everything else is the starting code every student was handed.
 *
 * Pure, and shared: the instructor's file browser and the AI reviewer must
 * agree on whose work is whose, and two copies of this rule would eventually
 * disagree. `keep` decides what is even a candidate — the two callers exclude
 * different things, because a human may want to open a file a model cannot use.
 */
export function studentOwnFiles(
  student: TreeFile[],
  template: TreeFile[],
  keep: (file: TreeFile) => boolean,
): { own: OwnedFile[]; unchangedCount: number } {
  const starting = new Map<string, string>();
  for (const f of template) starting.set(f.path, f.sha);

  const own: OwnedFile[] = [];
  let unchangedCount = 0;
  for (const f of student) {
    if (!keep(f)) continue;
    const was = starting.get(f.path);
    if (was === undefined) own.push({ ...f, status: 'added' });
    else if (was !== f.sha) own.push({ ...f, status: 'modified' });
    else unchangedCount++;
  }
  return { own, unchangedCount };
}

/**
 * Render the source into the block the prompt carries, stating plainly which
 * of the three shapes it is.
 */
export function renderSource(source: ReviewSource): string {
  const header =
    source.kind === 'diff'
      ? [
          'This is a RESUBMISSION. You are being shown only what changed since',
          `the student's previous attempt${source.baseSha ? ` (${source.baseSha.slice(0, 8)})` : ''},`,
          'plus the full text of the files that changed.',
          'Work not shown here was submitted before and has not been altered —',
          'do NOT mark a requirement failed merely because its code is absent.',
        ].join('\n')
      : source.kind === 'template'
        ? [
            'This is the FIRST ATTEMPT on a program that ships starting code.',
            'You are being shown only the files this student added or changed.',
            'Every other file is the starting code that every student was given',
            'and is not shown here.',
            'Do NOT mark a requirement failed merely because its code is absent —',
            'it may live in the unchanged starting code.',
          ].join('\n')
        : [
            'This is the first attempt. You are being shown the repository as it',
            'stands at the submitted commit.',
          ].join('\n');

  if (source.files.length === 0 && source.patches.length === 0) {
    // For a template submission this is a finding, not a failure to read
    // anything: the student handed back the starting code untouched. Saying so
    // plainly is very different from "no files were found", which reads like
    // the pipeline broke and invites the model to hedge.
    return source.kind === 'template'
      ? `${header}\n\nThis student changed nothing at all from the starting code.`
      : '(no readable source files were found in this submission)';
  }

  const patches = source.patches.length
    ? '\n\nChanges since the last attempt:\n' +
      source.patches
        .map((p) => `\n--- ${p.path} (${p.status}) ---\n${p.patch}`)
        .join('\n')
    : '';

  const files = source.files.length
    ? '\n\nFiles:\n' +
      source.files
        .map((f) => `\n----- FILE: ${f.path} -----\n${f.content}`)
        .join('\n')
    : '';

  const note = source.truncated
    ? '\n\n(Some files were omitted for size. Judge only what you were given.)'
    : '';

  return `${header}${patches}${files}${note}`;
}
