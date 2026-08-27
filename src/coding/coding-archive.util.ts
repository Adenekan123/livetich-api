import AdmZip from 'adm-zip';

/**
 * Safe, in-memory reading of a student's submitted project archive (.zip).
 *
 * We NEVER extract to disk — the original archive is stored immutably in object
 * storage, and everything here reads entries in memory to (a) build a file
 * index and (b) pull text file contents for the review viewer and AI reviewer.
 * That sidesteps zip-slip (a write-time vulnerability) entirely; the path guards
 * below are defence-in-depth so a hostile path can't poison the stored index.
 */

/** Hard caps so a huge or malicious archive can't exhaust memory (zip bomb). */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024; // compressed, matches multer
const MAX_FILES = 500; // entries indexed
const MAX_TOTAL_UNCOMPRESSED = 60 * 1024 * 1024; // guards decompression bombs
const MAX_TEXT_FILE_BYTES = 256 * 1024; // per-file cap for content reads

/** Directories that are never coursework — skipped from index and content. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
]);

/** Extensions we treat as text (everything else is indexed but not read). */
const TEXT_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'txt', 'html', 'htm',
  'css', 'scss', 'sass', 'less', 'py', 'java', 'kt', 'go', 'rs', 'rb', 'php',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'swift', 'sql', 'yml', 'yaml', 'toml',
  'xml', 'sh', 'bash', 'env', 'gitignore', 'dockerfile', 'vue', 'svelte',
  'prisma', 'graphql', 'gql',
]);

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', py: 'python', java: 'java', kt: 'kotlin',
  go: 'go', rs: 'rust', rb: 'ruby', php: 'php', c: 'c', h: 'c', cpp: 'cpp',
  hpp: 'cpp', cc: 'cpp', cs: 'csharp', swift: 'swift', sql: 'sql', html: 'html',
  htm: 'html', css: 'css', scss: 'scss', sass: 'sass', less: 'less',
  json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', vue: 'vue',
  svelte: 'svelte', prisma: 'prisma', graphql: 'graphql', gql: 'graphql',
};

export interface IndexedFile {
  path: string;
  size: number;
  language: string | null;
}

export interface ArchiveIndex {
  files: IndexedFile[];
  totalUncompressed: number;
  /** True when the archive had more entries than we indexed (hit a cap). */
  truncated: boolean;
}

export interface ArchiveTextFile {
  path: string;
  content: string;
  language: string | null;
}

/** True for a path that must never enter the stored index (absolute, escaping,
 *  or inside a skipped tool directory). */
function isUnsafeOrSkipped(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return true; // Windows drive-absolute
  const parts = path.split('/');
  if (parts.some((p) => p === '..')) return true;
  return parts.some((p) => SKIP_DIRS.has(p));
}

function extOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function languageOf(path: string): string | null {
  return LANG_BY_EXT[extOf(path)] ?? null;
}

function isTextFile(path: string): boolean {
  return TEXT_EXT.has(extOf(path));
}

/** Normalise a zip entry name to a forward-slash relative path. */
function normalize(entryName: string): string {
  return entryName.replace(/\\/g, '/').replace(/^\.\//, '');
}

function open(buffer: Buffer): AdmZip {
  try {
    return new AdmZip(buffer);
  } catch {
    throw new Error('The uploaded file is not a valid .zip archive');
  }
}

/**
 * Build the file index (path, size, language) for the stored submission,
 * enforcing the entry-count and decompression caps.
 */
export function indexArchive(buffer: Buffer): ArchiveIndex {
  const zip = open(buffer);
  const files: IndexedFile[] = [];
  let totalUncompressed = 0;
  let truncated = false;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path = normalize(entry.entryName);
    if (isUnsafeOrSkipped(path)) continue;

    const size = entry.header.size; // uncompressed size
    totalUncompressed += size;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error('Archive contents are too large to process');
    }
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }
    files.push({ path, size, language: languageOf(path) });
  }

  if (files.length === 0) {
    throw new Error('The archive contains no readable project files');
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalUncompressed, truncated };
}

/**
 * Read text file contents from the archive (for the review viewer and the AI
 * reviewer). Skips binaries, skipped dirs, and files over the per-file cap; the
 * optional overall budget bounds how much text we pull for a single AI call.
 */
export function readTextFiles(
  buffer: Buffer,
  opts: { maxTotalBytes?: number } = {},
): ArchiveTextFile[] {
  const zip = open(buffer);
  const out: ArchiveTextFile[] = [];
  let budget = opts.maxTotalBytes ?? Infinity;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path = normalize(entry.entryName);
    if (isUnsafeOrSkipped(path) || !isTextFile(path)) continue;
    if (entry.header.size > MAX_TEXT_FILE_BYTES) continue;
    if (budget <= 0) break;

    const content = entry.getData().toString('utf8');
    out.push({ path, content, language: languageOf(path) });
    budget -= Buffer.byteLength(content, 'utf8');
  }
  return out;
}

/** Read a single file's text content by path (review viewer). Null if absent
 *  or not a readable text file. */
export function readOneTextFile(
  buffer: Buffer,
  path: string,
): ArchiveTextFile | null {
  const zip = open(buffer);
  const target = normalize(path);
  const entry = zip
    .getEntries()
    .find((e) => !e.isDirectory && normalize(e.entryName) === target);
  if (!entry || isUnsafeOrSkipped(target) || !isTextFile(target)) return null;
  if (entry.header.size > MAX_TEXT_FILE_BYTES) return null;
  return {
    path: target,
    content: entry.getData().toString('utf8'),
    language: languageOf(target),
  };
}
