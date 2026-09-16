import { ayahWords, graphemes, validateParts } from './quran-words';

describe('quran-words', () => {
  describe('ayahWords', () => {
    it('splits an ayah into its words, in reading order', () => {
      // Al-Falaq 1: قُلۡ أَعُوذُ بِرَبِّ ٱلۡفَلَقِ
      const words = ayahWords(113, 1);
      expect(words).toHaveLength(4);
      expect(words?.[0]).toBe('قُلۡ');
      expect(words?.[3]).toBe('ٱلۡفَلَقِ');
    });

    it('keeps a stop mark on the word it follows, never as a word of its own', () => {
      // Al-Baqarah 255 carries several waqf signs. Expectations are code points
      // read off the source, never retyped Arabic: the same word typed by hand
      // can order its marks differently and still look identical.
      const words = ayahWords(2, 255)!;
      expect(words).toHaveLength(50);
      expect(words[6].startsWith('\u0671')).toBe(true); // ٱ
      expect(words[6].endsWith('\u06DA')).toBe(true); // small high jeem (waqf)
      for (const w of words) expect(w).toMatch(/[\u0621-\u064A\u0671]/);
    });

    it('returns null for a reference that does not exist', () => {
      expect(ayahWords(113, 6)).toBeNull();
      expect(ayahWords(115, 1)).toBeNull();
    });
  });

  describe('graphemes', () => {
    it('keeps harakat on their letter', () => {
      expect(graphemes('أَعُوذُ')).toEqual(['أَ', 'عُ', 'و', 'ذُ']);
    });

    it('keeps shaddah with its vowel as one letter', () => {
      // بِرَبِّ — the last letter carries shaddah and kasrah.
      const letters = graphemes('بِرَبِّ');
      expect(letters).toHaveLength(3);
      expect(letters[2]).toBe('بِّ');
    });

    it('keeps sukun and tanween with their letter', () => {
      expect(graphemes('قُلۡ')).toEqual(['قُ', 'لۡ']); // sukun (U+06E1)
      expect(graphemes('غَاسِقٍ').at(-1)).toBe('قٍ'); // tanween kasr
    });

    it('makes the small waw of madd silah a letter of its own, so it can be marked', () => {
      // عِندَهُۥٓ (2:255, word 23): the small waw is the pronounced lengthening
      // after the pronoun — exactly what a teacher marks for Madd — so it is
      // selectable apart from the haa it follows.
      const letters = graphemes(ayahWords(2, 255)![23]);
      expect(letters.at(-2)?.startsWith('\u0647')).toBe(true); // هُ
      expect(letters.at(-1)).toBe('\u06E5\u0653'); // ۥ with maddah
    });

    it("loses nothing when any word of the Qur'an is split into letters", () => {
      for (let surah = 1; surah <= 114; surah++) {
        for (let ayah = 1; ; ayah++) {
          const words = ayahWords(surah, ayah);
          if (!words) break;
          for (const w of words) {
            const letters = graphemes(w);
            expect(letters.length).toBeGreaterThan(0);
            if (letters.join('') !== w)
              throw new Error(`${surah}:${ayah} ${w}`);
          }
        }
      }
    });
  });

  describe('validateParts', () => {
    /** A part of Al-Falaq: ayah 1 has 4 words, ayah 2 has 4. */
    const at = (
      ayahNumber: number,
      wordIndex: number,
      letterIndex?: number,
    ) => ({
      surahNumber: 113,
      ayahNumber,
      wordIndex,
      ...(letterIndex === undefined ? {} : { letterIndex }),
    });

    it('accepts a whole ayah, a whole word, and a single letter', () => {
      expect(validateParts([{ surahNumber: 113, ayahNumber: 2 }])).toEqual([
        { surahNumber: 113, ayahNumber: 2, wordIndex: null, letterIndex: null },
      ]);
      expect(validateParts([at(2, 1)])).toEqual([
        { surahNumber: 113, ayahNumber: 2, wordIndex: 1, letterIndex: null },
      ]);
      expect(validateParts([at(1, 2, 2)])).toEqual([
        { surahNumber: 113, ayahNumber: 1, wordIndex: 2, letterIndex: 2 },
      ]);
    });

    it('holds letters from two different ayahs, in reading order', () => {
      // The whole point of parts: a rule can live on a letter of one ayah and a
      // letter of the next, with nothing between them taken in.
      expect(validateParts([at(2, 3, 1), at(1, 0, 0)])).toEqual([
        { surahNumber: 113, ayahNumber: 1, wordIndex: 0, letterIndex: 0 },
        { surahNumber: 113, ayahNumber: 2, wordIndex: 3, letterIndex: 1 },
      ]);
    });

    it('keeps one part when the same letter is picked twice', () => {
      expect(validateParts([at(1, 0, 0), at(1, 0, 0)])).toHaveLength(1);
    });

    it.each([
      [{ surahNumber: 0, ayahNumber: 1 }, /Surah must be/],
      [{ surahNumber: 113, ayahNumber: 6 }, /has no ayah 6/],
      [{ surahNumber: 113, ayahNumber: 1, wordIndex: 4 }, /does not exist/],
      [{ surahNumber: 113, ayahNumber: 1, wordIndex: -1 }, /does not exist/],
      [{ surahNumber: 113, ayahNumber: 1, wordIndex: 1.5 }, /does not exist/],
      [
        { surahNumber: 113, ayahNumber: 1, wordIndex: 2, letterIndex: 3 },
        /letters/,
      ],
      [
        { surahNumber: 113, ayahNumber: 1, letterIndex: 0 },
        /letter needs the word/,
      ],
    ])('rejects a part that is not in the text: %j', (part, message) => {
      expect(() => validateParts([part])).toThrow(message);
    });

    it('rejects nothing picked, and more pieces than one mark may hold', () => {
      expect(() => validateParts([])).toThrow(/Pick a word or a letter/);
      expect(() =>
        validateParts(Array.from({ length: 65 }, (_, i) => at(1, i % 4))),
      ).toThrow(/at most 64/);
    });
  });
});
