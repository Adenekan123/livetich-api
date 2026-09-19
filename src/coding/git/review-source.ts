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

/** Files whose contents are never worth sending to a reviewer. */
const SKIP_DIRECTORIES = new Set([
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
  /** How this was assembled, so the prompt can be honest about it. */
  kind: 'full' | 'diff';
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

/**
 * Render the source into the block the prompt carries, stating plainly which
 * of the two shapes it is.
 */
export function renderSource(source: ReviewSource): string {
  if (source.files.length === 0 && source.patches.length === 0) {
    return '(no readable source files were found in this submission)';
  }

  const header =
    source.kind === 'diff'
      ? [
          'This is a RESUBMISSION. You are being shown only what changed since',
          `the student's previous attempt${source.baseSha ? ` (${source.baseSha.slice(0, 8)})` : ''},`,
          'plus the full text of the files that changed.',
          'Work not shown here was submitted before and has not been altered —',
          'do NOT mark a requirement failed merely because its code is absent.',
        ].join('\n')
      : [
          'This is the first attempt. You are being shown the repository as it',
          'stands at the submitted commit.',
        ].join('\n');

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
