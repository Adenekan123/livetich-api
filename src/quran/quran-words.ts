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

export type TajweedSelectionKind = 'AYAH' | 'WORD' | 'LETTERS';

export interface SelectionRef {
  surahNumber: number;
  ayahNumber: number;
  selection: TajweedSelectionKind;
  /** 0-based word positions, both ends inclusive. */
  wordStart?: number | null;
  wordEnd?: number | null;
  /** 0-based letter positions within the single word, both ends inclusive. */
  letterStart?: number | null;
  letterEnd?: number | null;
}

export type NormalizedSelection = Required<{
  [K in keyof SelectionRef]: Exclude<SelectionRef[K], undefined>;
}>;

const isIndex = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Check a selection against the real text and return it in canonical form.
 *
 * Throws an Error whose message is safe to show the teacher. Every position is
 * checked against the ayah it names — a client can send any numbers, and an
 * annotation on a word that does not exist would render on the wrong one.
 * Fields that do not apply to the selection kind are nulled, so the same
 * selection is always stored the same way.
 */
export function validateSelection(ref: SelectionRef): NormalizedSelection {
  const { surahNumber: surah, ayahNumber: ayah, selection } = ref;
  if (!Number.isInteger(surah) || surah < 1 || surah > 114) {
    throw new Error('Surah must be between 1 and 114');
  }
  const words =
    Number.isInteger(ayah) && ayah >= 1 ? ayahWords(surah, ayah) : null;
  if (!words) throw new Error(`Surah ${surah} has no ayah ${ayah}`);

  const base = {
    surahNumber: surah,
    ayahNumber: ayah,
    selection,
    wordStart: null,
    wordEnd: null,
    letterStart: null,
    letterEnd: null,
  };
  if (selection === 'AYAH') return base;
  if (selection !== 'WORD' && selection !== 'LETTERS') {
    throw new Error('Unknown selection type');
  }

  const wordStart = ref.wordStart;
  const wordEnd = ref.wordEnd ?? ref.wordStart;
  if (
    !isIndex(wordStart) ||
    !isIndex(wordEnd) ||
    wordEnd < wordStart ||
    wordEnd >= words.length
  ) {
    throw new Error(
      `Ayah ${surah}:${ayah} has ${words.length} words; that word range does not exist`,
    );
  }
  if (selection === 'WORD') return { ...base, wordStart, wordEnd };

  if (wordStart !== wordEnd) {
    throw new Error('A letter selection must stay within one word');
  }
  const letters = graphemes(words[wordStart]);
  const letterStart = ref.letterStart;
  const letterEnd = ref.letterEnd ?? ref.letterStart;
  if (
    !isIndex(letterStart) ||
    !isIndex(letterEnd) ||
    letterEnd < letterStart ||
    letterEnd >= letters.length
  ) {
    throw new Error(
      `That word has ${letters.length} letters; that letter range does not exist`,
    );
  }
  return { ...base, wordStart, wordEnd, letterStart, letterEnd };
}
