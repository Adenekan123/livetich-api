import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * One piece of text a mark holds: a whole ayah, one word of it, or one letter
 * of that word.
 *
 * Only the shape is checked here. Whether the position exists — whether that
 * ayah has that many words, and that word that many letters — is checked in the
 * service against the canonical text, because a client can send any numbers.
 */
export class TajweedPartDto {
  @IsInt()
  @Min(1)
  @Max(114)
  surahNumber!: number;

  @IsInt()
  @Min(1)
  ayahNumber!: number;

  /** 0-based word in the ayah; absent or null marks the whole ayah. */
  @IsOptional()
  @IsInt()
  @Min(0)
  wordIndex?: number | null;

  /** 0-based letter in that word; absent or null marks the whole word. */
  @IsOptional()
  @IsInt()
  @Min(0)
  letterIndex?: number | null;
}
