/**
 * Live sessions are not scheduled by hand. Each program carries a weekly cadence
 * (meeting days + local time over a fixed run), and the concrete occurrence is
 * materialised on demand the first time someone joins on a meeting day.
 *
 * All wall-clock reasoning happens in the course's IANA timezone using the
 * built-in Intl APIs — no date library. The DST math uses the standard
 * "offset probe" trick, which is correct except across the ~1hr/year fold.
 */

/** Schedule inputs pulled from the Course row. */
export interface CourseSchedule {
  startDate: Date | null;
  durationWeeks: number | null;
  meetingDays: unknown; // JSON int[] — 0=Sun … 6=Sat
  meetingTime: string | null; // local "HH:mm" — the general/default time
  /** Optional per-day time overrides: JSON map { "0".."6": "HH:mm" }. A day
   *  present here meets at its own time; any other meeting day uses meetingTime. */
  meetingTimesByDay?: unknown;
  timezone: string | null; // IANA zone, e.g. "Africa/Lagos"
}

/** One materialisable meeting. */
export interface Occurrence {
  /** Local calendar day in the course tz, "YYYY-MM-DD" — also the room key. */
  dateKey: string;
  /** UTC instant the meeting starts. */
  scheduledAt: Date;
}

export interface JoinWindow {
  /** Today's meeting, if today is a meeting day within the program run. */
  current: Occurrence | null;
  /** Soonest meeting strictly after `now` (for the "next session" label). */
  next: Occurrence | null;
  /** True only on the scheduled day, from `meetingTime` onward. */
  joinableNow: boolean;
}

/** Students may enter a few minutes before the wall-clock start. */
const EARLY_JOIN_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Local wall-clock parts of an instant in `tz`. */
function partsInTz(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  return {
    year: +p.year,
    month: +p.month,
    day: +p.day,
    hour: +p.hour,
    minute: +p.minute,
    second: +p.second,
  };
}

/** Offset of `tz` at `date`, in ms (localWallClockAsUTC − actualUTC). */
function tzOffsetMs(date: Date, tz: string): number {
  const p = partsInTz(date, tz);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - date.getTime();
}

/** The UTC instant for a wall-clock y/m/d h:m in `tz`. */
function zonedWallTimeToUtc(
  y: number,
  mo: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, hh, mm);
  const offset = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - offset);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Parse a "HH:mm" string into hour/minute, or null if malformed. */
function parseHhmm(s: string): { hh: number; mm: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}

/**
 * Per-day time overrides as a map from day-of-week (0=Sun … 6=Sat) to parsed
 * hour/minute. Tolerates the raw JSON shape ({ "1": "18:00", … }); silently
 * drops any malformed key/value so a bad override can never break scheduling —
 * that day just falls back to the general meeting time.
 */
function parseTimesByDay(raw: unknown): Map<number, { hh: number; mm: number }> {
  const out = new Map<number, { hh: number; mm: number }>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const day = Number(k);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    if (typeof v !== 'string') continue;
    const t = parseHhmm(v);
    if (t) out.set(day, t);
  }
  return out;
}

/**
 * All meeting occurrences across the program run, in chronological order.
 * Empty when the schedule is incomplete.
 */
export function listOccurrences(schedule: CourseSchedule): Occurrence[] {
  const { startDate, durationWeeks, meetingTime, timezone } = schedule;
  const days = Array.isArray(schedule.meetingDays)
    ? (schedule.meetingDays as unknown[]).map(Number).filter((n) => !Number.isNaN(n))
    : [];
  if (!startDate || !durationWeeks || !meetingTime || !timezone || days.length === 0) {
    return [];
  }
  // The general (default) time each meeting day uses unless it has an override.
  const general = parseHhmm(meetingTime);
  if (!general) return [];
  const perDay = parseTimesByDay(schedule.meetingTimesByDay);

  // Anchor on the program's first local calendar day, then walk day by day.
  const startKey = partsInTz(startDate, timezone);
  const base = Date.UTC(startKey.year, startKey.month - 1, startKey.day);
  const dayCount = durationWeeks * 7;
  const dayset = new Set(days);
  const occurrences: Occurrence[] = [];

  for (let i = 0; i < dayCount; i++) {
    const dt = new Date(base + i * DAY_MS);
    const dow = dt.getUTCDay();
    if (!dayset.has(dow)) continue;
    const y = dt.getUTCFullYear();
    const mo = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    // A day with its own time meets then; every other day uses the general time.
    const { hh, mm } = perDay.get(dow) ?? general;
    occurrences.push({
      dateKey: `${y}-${pad(mo)}-${pad(d)}`,
      scheduledAt: zonedWallTimeToUtc(y, mo, d, hh, mm, timezone),
    });
  }
  return occurrences;
}

/**
 * Resolve the join window for a course at `now`. `current` is today's meeting;
 * `joinableNow` gates the Join button to the scheduled day, from the meeting
 * time (minus a short early-entry grace) onward.
 */
export function resolveJoinWindow(
  schedule: CourseSchedule,
  now: Date = new Date(),
): JoinWindow {
  const occurrences = listOccurrences(schedule);
  if (occurrences.length === 0) {
    return { current: null, next: null, joinableNow: false };
  }

  const tz = schedule.timezone!;
  const today = partsInTz(now, tz);
  const todayKey = `${today.year}-${pad(today.month)}-${pad(today.day)}`;

  const current = occurrences.find((o) => o.dateKey === todayKey) ?? null;
  const next = occurrences.find((o) => o.scheduledAt.getTime() > now.getTime()) ?? null;
  const joinableNow =
    current !== null && now.getTime() >= current.scheduledAt.getTime() - EARLY_JOIN_MS;

  return { current, next, joinableNow };
}
