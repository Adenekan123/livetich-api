import { getSurahAyahs } from './quran-text';

/**
 * Word- and letter-level addressing into the canonical Qur'an text.
 *
 * The Tanzil Uthmani text is stored an ayah at a time, words separated by a
 * single space. Across all 6,236 ayahs that split yields 77,428 words and not
 * one token without a letter in it: stop marks (ۚ ۖ ۗ …) ride on the word before
 * them rather than standing alone. So a word is addressed by its position in
 * that split, and nothing of the text needs storing to find it again — an
 * annotation points at the Qur'an, it never carries a copy of it.
 *
 * Letters are addressed as grapheme clusters, never as UTF-16 indices. A letter
 * with its harakat — أَ, or رِّ with shaddah and kasrah — is one cluster but
 * several code units, and indexing the string directly would cut the marks off
 * their letter. The web client segments the same way (Intl.Segmenter), so an
 * offset means the same thing on both sides.
 *
 * Unicode does not treat every Qur'anic sign as a combining mark, and that is
 * kept deliberately. Across the whole text the only clusters that do not start
 * with a base letter are the tatweel seat of a dagger alif (ـٰ), the small waw
 * and small yeh of madd silah (ۥ ۦ), the hizb and sajdah markers (۞ ۩) and one
 * thin space in 2:72. The first three are pronounced lengthening — precisely
 * what a teacher marks for Madd — so they stay selectable as letters in their
 * own right rather than being folded into the letter before them.
 */
const segmenter = new Intl.Segmenter('ar', { granularity: 'grapheme' });

/** An ayah's words, in reading order. */
export function splitWords(ayahText: string): string[] {
  return ayahText.split(' ').filter(Boolean);
}

/** A word's letters, each with the marks that belong to it. */
export function graphemes(word: string): string[] {
  return Array.from(segmenter.segment(word), (s) => s.segment);
}

/** The words of one ayah, or null when the reference does not exist. */
export function ayahWords(surah: number, ayah: number): string[] | null {
  const text = getSurahAyahs(surah)?.[ayah - 1];
  return text === undefined ? null : splitWords(text);
}

/** One piece of text a mark holds, as a client sends it. */
export interface PartRef {
  surahNumber: number;
  ayahNumber: number;
  /** 0-based word in the ayah; null or absent marks the whole ayah. */
  wordIndex?: number | null;
  /** 0-based letter in that word; null or absent marks the whole word. */
  letterIndex?: number | null;
}

/** A part as it is stored: every position resolved, nothing left implicit. */
export interface NormalizedPart {
  surahNumber: number;
  ayahNumber: number;
  wordIndex: number | null;
  letterIndex: number | null;
}

const isIndex = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * How many pieces one mark may hold. Generous for a teacher marking a long
 * rule, bounded so no client can post a mark with ten thousand pieces.
 */
export const MAX_PARTS = 64;

/**
 * Check the parts of a mark against the real text, and return them in reading
 * order with duplicates dropped.
 *
 * Throws an Error whose message is safe to show the teacher. Every position is
 * checked against the ayah it names: a client can send any numbers, and a mark
 * on a word that does not exist would draw on the wrong one. Parts may sit in
 * different ayahs — a rule can hold the last letter of one and the first of the
 * next — and nothing between two parts is implied.
 */
export function validateParts(
  parts: readonly PartRef[],
  max: number = MAX_PARTS,
): NormalizedPart[] {
  // Typed as parts, but the gateway hands this straight off the wire, so
  // anything that is not a list is nothing picked. The check goes through a
  // typed const on purpose: Array.isArray narrows to any[], which would widen
  // every position below to `any` and quietly drop the checking they exist for.
  const list: readonly PartRef[] = Array.isArray(parts) ? parts : [];
  if (list.length === 0) {
    throw new Error('Pick a word or a letter to mark');
  }
  if (list.length > max) {
    throw new Error(`A mark can hold at most ${max} pieces`);
  }

  const seen = new Set<string>();
  const out: NormalizedPart[] = [];
  const add = (part: NormalizedPart) => {
    const key = `${part.surahNumber}:${part.ayahNumber}:${part.wordIndex ?? ''}:${part.letterIndex ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(part);
  };

  for (const part of list) {
    const surah = part.surahNumber;
    const ayah = part.ayahNumber;
    if (!Number.isInteger(surah) || surah < 1 || surah > 114) {
      throw new Error('Surah must be between 1 and 114');
    }
    const words =
      Number.isInteger(ayah) && ayah >= 1 ? ayahWords(surah, ayah) : null;
    if (!words) throw new Error(`Surah ${surah} has no ayah ${ayah}`);

    const wordIndex = part.wordIndex ?? null;
    const letterIndex = part.letterIndex ?? null;

    if (wordIndex === null) {
      if (letterIndex !== null) {
        throw new Error('A letter needs the word it belongs to');
      }
      add({
        surahNumber: surah,
        ayahNumber: ayah,
        wordIndex: null,
        letterIndex: null,
      });
      continue;
    }
    if (!isIndex(wordIndex) || wordIndex >= words.length) {
      throw new Error(
        `Ayah ${surah}:${ayah} has ${words.length} words; word ${String(wordIndex)} does not exist`,
      );
    }
    if (letterIndex === null) {
      add({
        surahNumber: surah,
        ayahNumber: ayah,
        wordIndex,
        letterIndex: null,
      });
      continue;
    }
    const letters = graphemes(words[wordIndex]);
    if (!isIndex(letterIndex) || letterIndex >= letters.length) {
      throw new Error(
        `That word has ${letters.length} letters; letter ${String(letterIndex)} does not exist`,
      );
    }
    add({ surahNumber: surah, ayahNumber: ayah, wordIndex, letterIndex });
  }

  // Reading order, with the whole-ayah and whole-word parts before the pieces
  // inside them, so a mark is always stored — and read back — the same way.
  const rank = (n: number | null) => (n === null ? -1 : n);
  out.sort(
    (a, b) =>
      a.surahNumber - b.surahNumber ||
      a.ayahNumber - b.ayahNumber ||
      rank(a.wordIndex) - rank(b.wordIndex) ||
      rank(a.letterIndex) - rank(b.letterIndex),
  );
  return out;
}

/** What a mark is filed under: the ayah of its first part. */
export function firstAyahOf(parts: readonly NormalizedPart[]): {
  surahNumber: number;
  ayahNumber: number;
} {
  const [first] = parts;
  return { surahNumber: first.surahNumber, ayahNumber: first.ayahNumber };
}
