import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { resolveJoinWindow } from '../sessions/session-schedule';

/**
 * Pre-class email reminders. Sessions materialise on demand (no row to hang a
 * reminder on), so this reads each course's weekly cadence, finds courses whose
 * next occurrence falls inside the org's lead window, and emails enrolled
 * students once per occurrence. A SessionReminder row (unique per course+day) is
 * the dedupe latch, so overlapping ticks — or a restart — never double-send.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  private webUrl(): string {
    return this.config.get<string>('WEB_URL') ?? 'http://localhost:3001';
  }

  // Every 5 minutes. The lead window (org-configurable) is much wider, and the
  // dedupe latch means the first qualifying tick is the only one that emails.
  @Cron('*/5 * * * *')
  async sweep(): Promise<void> {
    const now = Date.now();
    // Only courses in reminder-enabled orgs that actually have a cadence + roster.
    const courses = await this.prisma.course.findMany({
      where: {
        organization: { is: { preClassReminder: true } },
        meetingTime: { not: null },
        enrollments: { some: {} },
      },
      select: {
        id: true,
        title: true,
        startDate: true,
        durationWeeks: true,
        meetingDays: true,
        meetingTime: true,
        timezone: true,
        organization: { select: { reminderLeadMinutes: true } },
        enrollments: {
          select: { student: { select: { name: true, email: true } } },
        },
      },
    });

    for (const course of courses) {
      const leadMs = (course.organization?.reminderLeadMinutes ?? 30) * 60_000;
      const window = resolveJoinWindow({
        startDate: course.startDate,
        durationWeeks: course.durationWeeks,
        meetingDays: course.meetingDays,
        meetingTime: course.meetingTime,
        timezone: course.timezone,
      });
      const next = window.next;
      if (!next) continue;
      const untilMs = next.scheduledAt.getTime() - now;
      // Inside the lead window and still upcoming (never remind a class that's
      // already started — e.g. after downtime).
      if (untilMs <= 0 || untilMs > leadMs) continue;

      // Latch first: the unique (courseId, dateKey) makes this the single sender.
      try {
        await this.prisma.sessionReminder.create({
          data: { courseId: course.id, dateKey: next.dateKey },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002'
        ) {
          continue; // already reminded this occurrence
        }
        throw e;
      }

      const whenLabel = this.formatWhen(next.scheduledAt, course.timezone, untilMs);
      const url = `${this.webUrl()}/courses/${course.id}`;
      let sent = 0;
      for (const { student } of course.enrollments) {
        if (!student?.email) continue;
        await this.mail.sendClassReminder(
          student.email,
          student.name ?? 'there',
          course.title,
          whenLabel,
          url,
        );
        sent++;
      }
      this.logger.log(
        `Reminded ${sent} student(s) for "${course.title}" (${next.dateKey}).`,
      );
    }
  }

  /** "in 30 minutes · 9:00 AM WAT" — a friendly, timezone-correct label. */
  private formatWhen(
    at: Date,
    timezone: string | null,
    untilMs: number,
  ): string {
    const mins = Math.max(1, Math.round(untilMs / 60_000));
    const rel =
      mins >= 60
        ? `in about ${Math.round(mins / 60)} hour${mins >= 120 ? 's' : ''}`
        : `in ${mins} minute${mins === 1 ? '' : 's'}`;
    try {
      const time = new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone ?? undefined,
        timeZoneName: 'short',
      }).format(at);
      return `${rel} · ${time}`;
    } catch {
      return rel;
    }
  }
}
