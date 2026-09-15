import { ayahWords, graphemes, validateSelection } from './quran-words';

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

  describe('validateSelection', () => {
    it('accepts a whole ayah and nulls the positions', () => {
      expect(
        validateSelection({
          surahNumber: 113,
          ayahNumber: 2,
          selection: 'AYAH',
          wordStart: 3,
        }),
      ).toEqual({
        surahNumber: 113,
        ayahNumber: 2,
        selection: 'AYAH',
        wordStart: null,
        wordEnd: null,
        letterStart: null,
        letterEnd: null,
      });
    });

    it('accepts a word, and a range of words', () => {
      expect(
        validateSelection({
          surahNumber: 113,
          ayahNumber: 2,
          selection: 'WORD',
          wordStart: 1,
        }),
      ).toMatchObject({ wordStart: 1, wordEnd: 1, letterStart: null });
      expect(
        validateSelection({
          surahNumber: 113,
          ayahNumber: 2,
          selection: 'WORD',
          wordStart: 0,
          wordEnd: 1,
        }),
      ).toMatchObject({ wordStart: 0, wordEnd: 1 });
    });

    it('accepts letters inside one word', () => {
      expect(
        validateSelection({
          surahNumber: 113,
          ayahNumber: 1,
          selection: 'LETTERS',
          wordStart: 2,
          letterStart: 2,
          letterEnd: 2,
        }),
      ).toMatchObject({
        wordStart: 2,
        wordEnd: 2,
        letterStart: 2,
        letterEnd: 2,
      });
    });

    it.each([
      [{ surahNumber: 0, ayahNumber: 1 }, /Surah must be/],
      [{ surahNumber: 113, ayahNumber: 6 }, /has no ayah 6/],
      [
        { surahNumber: 113, ayahNumber: 1, wordStart: 4 },
        /word range does not exist/,
      ],
      [
        { surahNumber: 113, ayahNumber: 1, wordStart: 2, wordEnd: 1 },
        /word range/,
      ],
      [{ surahNumber: 113, ayahNumber: 1, wordStart: -1 }, /word range/],
      [{ surahNumber: 113, ayahNumber: 1, wordStart: 1.5 }, /word range/],
    ])(
      'rejects a word selection that is not in the text: %j',
      (ref, message) => {
        expect(() => validateSelection({ selection: 'WORD', ...ref })).toThrow(
          message,
        );
      },
    );

    it('rejects letters beyond the word, or spanning two words', () => {
      expect(() =>
        validateSelection({
          surahNumber: 113,
          ayahNumber: 1,
          selection: 'LETTERS',
          wordStart: 2,
          letterStart: 3,
        }),
      ).toThrow(/letter range does not exist/);
      expect(() =>
        validateSelection({
          surahNumber: 113,
          ayahNumber: 1,
          selection: 'LETTERS',
          wordStart: 1,
          wordEnd: 2,
          letterStart: 0,
        }),
      ).toThrow(/within one word/);
    });

    it('rejects an unknown selection type', () => {
      expect(() =>
        validateSelection({
          surahNumber: 113,
          ayahNumber: 1,
          selection: 'VERSE' as never,
        }),
      ).toThrow(/Unknown selection/);
    });
  });
});
