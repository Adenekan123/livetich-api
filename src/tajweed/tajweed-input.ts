import { TAJWEED_RULE_KEYS, type TajweedRule } from '../shared';

/**
 * Input rules shared by the HTTP API and the room gateway, so a live annotation
 * and a saved one are held to the same standard.
 */

/** Client-chosen annotation ids: long enough to be unique, short and plain
 *  enough to be safe in a URL and a Redis hash field. */
export const ANNOTATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isTajweedRule(value: unknown): value is TajweedRule {
  return (
    typeof value === 'string' &&
    (TAJWEED_RULE_KEYS as readonly string[]).includes(value)
  );
}

/**
 * Teacher-written text, made safe to store and to show.
 *
 * Notes are plain text and are never rendered as HTML, so tags are dropped
 * outright rather than escaped: a later export or report that forgets to escape
 * cannot be turned into a script by a note. Control characters other than line
 * breaks go too. Returns null for anything that is empty once cleaned.
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/<[^>]*>/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
  return cleaned || null;
}
