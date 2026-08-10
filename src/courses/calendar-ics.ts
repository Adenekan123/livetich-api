import { listOccurrences, type CourseSchedule } from '../sessions/session-schedule';

// 0=Sun … 6=Sat → iCalendar weekday codes.
const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DURATION_MIN = 60; // we don't store class length; assume 1h.

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`);

function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Wall-clock stamp (no zone marker — paired with TZID) for a local date+time. */
function localStamp(dateKey: string, hh: number, mm: number, addMin = 0): string {
  const base = new Date(
    Date.UTC(+dateKey.slice(0, 4), +dateKey.slice(5, 7) - 1, +dateKey.slice(8, 10), hh, mm),
  );
  const d = new Date(base.getTime() + addMin * 60_000);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`
  );
}

function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

export interface IcsCourse extends CourseSchedule {
  id: string;
  title: string;
  scheduleUpdatedAt: Date | null;
}

/**
 * A recurring .ics for a course's weekly cadence (weekly RRULE, 15-min alarm),
 * or null when the course isn't schedulable yet. Stable UID + a SEQUENCE that
 * bumps on schedule changes so re-imports update the existing series. Times use
 * a bare TZID — Apple/Google Calendar resolve IANA zones from their own tz db.
 */
export function buildCourseIcs(
  course: IcsCourse,
  host = 'livetich.nekan.dev',
): string | null {
  const occ = listOccurrences(course);
  if (occ.length === 0 || !course.meetingTime || !course.timezone) return null;

  const days = Array.isArray(course.meetingDays)
    ? (course.meetingDays as unknown[]).map(Number).filter((n) => !Number.isNaN(n))
    : [];
  const [hh, mm] = course.meetingTime.split(':').map(Number);
  const firstKey = occ[0].dateKey;
  const until = utcStamp(occ[occ.length - 1].scheduledAt);
  const byday = days.map((d) => ICS_DAYS[d]).join(',');
  const seq = course.scheduleUpdatedAt
    ? Math.floor(course.scheduleUpdatedAt.getTime() / 1000)
    : 0;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//livetich//class//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:course-${course.id}@${host}`,
    `SEQUENCE:${seq}`,
    `DTSTAMP:${utcStamp(new Date())}`,
    `DTSTART;TZID=${course.timezone}:${localStamp(firstKey, hh, mm)}`,
    `DTEND;TZID=${course.timezone}:${localStamp(firstKey, hh, mm, DURATION_MIN)}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${byday};UNTIL=${until}`,
    `SUMMARY:${esc(course.title)}`,
    `DESCRIPTION:${esc(`Live class on livetich — ${course.title}`)}`,
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${esc(`${course.title} starts in 15 minutes`)}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}
