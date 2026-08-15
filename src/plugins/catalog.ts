/**
 * The plugin (add-on pack) catalog. Lives in code — not the DB — because the
 * set of packs ships with the app. An OrgPlugin row only records which packs a
 * given tenant has turned on.
 *
 * `priceMonthly` is null during the pilot (every pack is free). When we
 * monetize post-PMF, setting a price here + routing the enable action through
 * checkout is the whole change — the entitlement seam below stays the same.
 */
export interface PluginDef {
  key: string;
  name: string;
  summary: string;
  /** What turning it on gives the instructor — shown on the Add-ons page. */
  features: string[];
  /** Null = free (pilot). A number is the intended monthly price, later. */
  priceMonthly: number | null;
}

/** Pack keys, referenced by feature code that gates on an entitlement. Keep in
 *  sync with the catalog entries below. */
export const PLUGIN_ISLAMIC_EDUCATION = 'islamic-education';
export const PLUGIN_CODE_INSTRUCTION = 'code-instruction';

export const PLUGIN_CATALOG: readonly PluginDef[] = [
  {
    key: 'islamic-education',
    name: 'Islamic Education',
    summary:
      'Tools for Qur’an, tajweed, and Arabic instructors — RTL classroom, ' +
      'memorization (hifz) tracking, and tajweed-aware assessment.',
    features: [
      'Right-to-left / Arabic classroom mode',
      'Hifz (memorization) tracking per student',
      'Tajweed-aware assessment templates',
      'Ijazah-style certificate template',
    ],
    priceMonthly: null,
  },
  {
    key: 'code-instruction',
    name: 'Code Instruction',
    summary:
      'Tools for programming instructors — a live, syntax-highlighted code ' +
      'board the class follows in real time, with per-language editing.',
    features: [
      'Live shared code editor as a classroom surface',
      'Syntax highlighting across common languages',
      'Instructor drives; students follow read-only',
    ],
    priceMonthly: null,
  },
];

const KEYS = new Set(PLUGIN_CATALOG.map((p) => p.key));

export function isValidPluginKey(key: string): boolean {
  return KEYS.has(key);
}
