import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Full Uthmani Qur'an text (Tanzil Uthmani orthography, 114 surahs / 6236
 * ayahs), loaded once at startup so the live mushaf reader can serve any
 * surah's verses. The JSON is shipped as a build asset (see nest-cli.json);
 * we fall back to the source tree so it also loads under ts-node / tests.
 *
 * Shape: { "<surahNumber>": ["<ayah 1 text>", "<ayah 2 text>", ...] }.
 */
type QuranText = Record<string, string[]>;

function load(): QuranText {
  const candidates = [
    join(__dirname, 'quran-uthmani.json'), // dist (copied asset)
    join(process.cwd(), 'src', 'quran', 'quran-uthmani.json'), // source tree
  ];
  for (const path of candidates) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as QuranText;
    } catch {
      // try next candidate
    }
  }
  throw new Error('quran-uthmani.json not found — mushaf text unavailable');
}

const TEXT = load();

/** Ayah texts for a surah (1-based number), or null if out of range. */
export function getSurahAyahs(surahNumber: number): string[] | null {
  return TEXT[String(surahNumber)] ?? null;
}
