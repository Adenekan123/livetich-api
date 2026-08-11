import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HifzKind } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { validateRef } from '../quran/surahs';
import { CreateHifzTargetDto } from './dto/create-target.dto';
import { LogHifzEntryDto } from './dto/log-entry.dto';

/**
 * Qur'an memorization (Hifz) tracking for a course. Instructors/admins set
 * targets and log recitations (new memorization or muraja'ah revision); each
 * student sees only their own. Ranges are validated against real ayah counts.
 */
@Injectable()
export class HifzService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
  ) {}

  // ---- Instructor / admin ----------------------------------------------

  /** Every enrolled student with their targets, recent recitations and a
   *  distinct-ayah progress summary. */
  async overview(user: JwtPayload, courseId: string) {
    await this.courses.assertCanManageCourse(user, courseId);

    const [enrollments, targets, entries] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where: { courseId },
        select: { student: { select: { id: true, name: true, email: true } } },
        orderBy: { student: { name: 'asc' } },
      }),
      this.prisma.hifzTarget.findMany({
        where: { courseId },
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.hifzEntry.findMany({
        where: { courseId },
        orderBy: { recordedAt: 'desc' },
      }),
    ]);

    return enrollments.map(({ student }) => {
      const theirEntries = entries.filter((e) => e.studentId === student.id);
      return {
        student,
        targets: targets.filter((t) => t.studentId === student.id),
        entries: theirEntries,
        progress: summarize(theirEntries),
      };
    });
  }

  async createTarget(
    user: JwtPayload,
    courseId: string,
    dto: CreateHifzTargetDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertEnrolled(courseId, dto.studentId);
    const ref = validate(dto.surahNumber, dto.ayahStart, dto.ayahEnd);

    return this.prisma.hifzTarget.create({
      data: {
        courseId,
        studentId: dto.studentId,
        ...ref,
        dueAt: dto.dueAt ? new Date(dto.dueAt) : null,
        note: dto.note?.trim() || null,
        createdById: user.sub,
      },
    });
  }

  async removeTarget(user: JwtPayload, courseId: string, targetId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertOwned('hifzTarget', targetId, courseId);
    await this.prisma.hifzTarget.delete({ where: { id: targetId } });
    return { deleted: true };
  }

  async logEntry(user: JwtPayload, courseId: string, dto: LogHifzEntryDto) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertEnrolled(courseId, dto.studentId);
    const ref = validate(dto.surahNumber, dto.ayahStart, dto.ayahEnd);

    if (dto.sessionId) {
      const session = await this.prisma.liveSession.findFirst({
        where: { id: dto.sessionId, courseId },
        select: { id: true },
      });
      if (!session) throw new ForbiddenException('Session not found in course');
    }

    return this.prisma.hifzEntry.create({
      data: {
        courseId,
        studentId: dto.studentId,
        ...ref,
        kind: dto.kind,
        rating: dto.rating ?? null,
        tajweed: dto.tajweed?.trim() || null,
        notes: dto.notes?.trim() || null,
        sessionId: dto.sessionId ?? null,
        recordedById: user.sub,
      },
    });
  }

  async removeEntry(user: JwtPayload, courseId: string, entryId: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    await this.assertOwned('hifzEntry', entryId, courseId);
    await this.prisma.hifzEntry.delete({ where: { id: entryId } });
    return { deleted: true };
  }

  // ---- Student self-view -----------------------------------------------

  /** A student's own targets + recitation log for the course. */
  async mine(user: JwtPayload, courseId: string) {
    await this.assertEnrolled(courseId, user.sub);
    const [targets, entries] = await this.prisma.$transaction([
      this.prisma.hifzTarget.findMany({
        where: { courseId, studentId: user.sub },
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.hifzEntry.findMany({
        where: { courseId, studentId: user.sub },
        orderBy: { recordedAt: 'desc' },
      }),
    ]);
    return { targets, entries, progress: summarize(entries) };
  }

  // ---- helpers ---------------------------------------------------------

  private async assertEnrolled(courseId: string, studentId: string) {
    const enrolled = await this.prisma.enrollment.findFirst({
      where: { courseId, studentId },
      select: { id: true },
    });
    if (!enrolled) {
      throw new ForbiddenException('That student is not enrolled in this course');
    }
  }

  private async assertOwned(
    model: 'hifzTarget' | 'hifzEntry',
    id: string,
    courseId: string,
  ) {
    const row = await (this.prisma[model] as {
      findFirst: (args: unknown) => Promise<{ id: string } | null>;
    }).findFirst({ where: { id, courseId }, select: { id: true } });
    if (!row) throw new NotFoundException('Record not found in this course');
  }
}

/** Wrap the shared validator so its message becomes a 400 the client can show. */
function validate(surah: number, start: number, end: number) {
  try {
    return validateRef(surah, start, end);
  } catch (e) {
    throw new ForbiddenException((e as Error).message);
  }
}

/** Distinct-ayah progress from a student's NEW_HIFZ entries, merging overlaps
 *  per surah so re-recited ranges aren't double counted. */
function summarize(entries: { kind: HifzKind; surahNumber: number; ayahStart: number; ayahEnd: number; recordedAt: Date }[]) {
  const bySurah = new Map<number, [number, number][]>();
  for (const e of entries) {
    if (e.kind !== HifzKind.NEW_HIFZ) continue;
    const list = bySurah.get(e.surahNumber) ?? [];
    list.push([e.ayahStart, e.ayahEnd]);
    bySurah.set(e.surahNumber, list);
  }

  let ayahsMemorized = 0;
  for (const ranges of bySurah.values()) {
    ranges.sort((a, b) => a[0] - b[0]);
    let [curStart, curEnd] = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
      const [s, en] = ranges[i];
      if (s <= curEnd + 1) {
        curEnd = Math.max(curEnd, en);
      } else {
        ayahsMemorized += curEnd - curStart + 1;
        [curStart, curEnd] = [s, en];
      }
    }
    ayahsMemorized += curEnd - curStart + 1;
  }

  return {
    ayahsMemorized,
    surahsTouched: bySurah.size,
    lastRecitedAt: entries.length ? entries[0].recordedAt : null,
  };
}
