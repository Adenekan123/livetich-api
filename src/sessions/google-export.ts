/**
 * Turning a Google file link into its PDF export.
 *
 * A Google file embedded in an iframe is a sealed box: it cannot be scrolled in
 * step for the class, cannot be drawn on, and cannot be edited (Google refuses
 * to render its editors inside another page at all). Exporting it to PDF and
 * rasterising the pages onto the board gives up live updates in exchange for
 * the things a lesson actually needs — everyone on the same page, and the
 * instructor able to write over it.
 *
 * The fetch has to happen here rather than in the browser: Google serves no
 * CORS headers, so a page-side request is refused before it starts.
 */

/** Google's id alphabet. */
const ID = '[A-Za-z0-9_-]+';

const EXPORTS: { re: RegExp; build: (id: string) => string }[] = [
  {
    re: new RegExp(`^/document/d/(${ID})`),
    build: (id) => `https://docs.google.com/document/d/${id}/export?format=pdf`,
  },
  {
    re: new RegExp(`^/spreadsheets/d/(${ID})`),
    build: (id) =>
      `https://docs.google.com/spreadsheets/d/${id}/export?format=pdf`,
  },
  {
    // Slides exports at /export/pdf, not /export?format=pdf.
    re: new RegExp(`^/presentation/d/(${ID})`),
    build: (id) => `https://docs.google.com/presentation/d/${id}/export/pdf`,
  },
];

const DRIVE_FILE = new RegExp(`^/file/d/(${ID})`);

/**
 * The PDF-export URL for a Google link, or null when there is not one.
 *
 * Forms are deliberately absent: a form has no document to print, and the
 * useful thing to put on a board is the live form, which the embed already
 * does.
 */
export function googleExportUrl(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  // https only, and only Google's own hosts — this runs server-side, so a
  // lookalike domain here would be ours to fetch on a user's say-so.
  if (url.protocol !== 'https:') return null;

  if (url.hostname === 'docs.google.com') {
    for (const { re, build } of EXPORTS) {
      const m = re.exec(url.pathname);
      if (m) return build(m[1]);
    }
    return null;
  }
  if (url.hostname === 'drive.google.com') {
    const m = DRIVE_FILE.exec(url.pathname);
    // A Drive file is already a file; ask for it as-is rather than converting.
    if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  }
  return null;
}
