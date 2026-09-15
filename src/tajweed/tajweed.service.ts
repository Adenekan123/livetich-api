import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  Role,
  TajweedAnnotationMode,
  TajweedChange,
  TajweedOutcome,
} from '@prisma/client';
import type {
  TajweedAnnotation as TajweedAnnotationRow,
  TajweedAnnotationStyle,
} from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import { validateSelection, type SelectionRef } from '../quran/quran-words';
import { RoomBroadcaster } from '../realtime/room-broadcaster';
import type { TajweedAnnotation, TajweedRule } from '../shared';
import { CreateTajweedAnnotationDto } from './dto/create-annotation.dto';
import { ListTajweedAnnotationsDto } from './dto/list-annotations.dto';
import { UpdateTajweedAnnotationDto } from './dto/update-annotation.dto';
import { cleanText, isTajweedRule } from './tajweed-input';

const STALE =
  'This annotation was changed somewhere else. Reload it and try again.';

/**
 * Saved Tajweed annotations for a course: lesson material restored with its
 * lesson, and corrections recorded against one student's recitation.
 *
 * Live, temporary annotations are not here — they never touch the database and
 * belong to the room gateway. Everything here is teacher-driven: nothing is
 * inferred, and a correction's history is kept even after it is deleted.
 */
@Injectable()
export class TajweedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly broadcaster: RoomBroadcaster,
  ) {}

  /**
   * The annotations for a lesson or live session.
   *
   * Staff get the lesson's annotations and, for a session, the corrections made
   * in it (or one student's, when asked). A student gets the lesson's
   * annotations and only their own corrections. A recorder films the lesson,
   * so it gets the lesson and nothing about any one student.
   */
  async list(user: JwtPayload, courseId: string, q: ListTajweedAnnotationsDto) {
    const recorder = !!user.recorder;
    if (recorder && user.recorder?.sessionId !== q.sessionId) {
      throw new ForbiddenException('Not the session this token films');
    }
    const staff = !recorder && (await this.canManage(user, courseId));
    if (!staff && !recorder) await this.assertEnrolled(courseId, user.sub);

    const scope = await this.lessonScope(courseId, q.sectionId, q.sessionId);
    const lesson = await this.prisma.tajweedAnnotation.findMany({
      where: {
        courseId,
        mode: TajweedAnnotationMode.LESSON,
        ...(scope ? { OR: scope } : {}),
      },
      orderBy: [
        { surahNumber: 'asc' },
        { ayahNumber: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    let corrections: TajweedAnnotationRow[] = [];
    if (!recorder) {
      if (staff && q.studentId)
        await this.assertEnrolled(courseId, q.studentId);
      const who = staff
        ? q.studentId
          ? { studentId: q.studentId }
          : q.sessionId
            ? { sessionId: q.sessionId }
            : null
        : { studentId: user.sub };
      if (who) {
        corrections = await this.prisma.tajweedAnnotation.findMany({
          where: {
            courseId,
            mode: TajweedAnnotationMode.STUDENT_CORRECTION,
            ...who,
          },
          orderBy: { createdAt: 'desc' },
        });
      }
    }
    return {
      lesson: lesson.map(toPublic),
      corrections: corrections.map(toPublic),
    };
  }

  async create(
    user: JwtPayload,
    courseId: string,
    dto: CreateTajweedAnnotationDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);

    // A resend of a create that already landed returns what it made.
    const existing = await this.prisma.tajweedAnnotation.findUnique({
      where: { id: dto.id },
    });
    if (existing) return this.replay(existing, user, courseId);

    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { organizationId: true },
    });
    if (!course?.organizationId) {
      throw new ForbiddenException(
        'This course does not belong to a workspace',
      );
    }

    const ref = selection(dto);
    const content = contentOf(dto, dto.mode);
    if (dto.mode === TajweedAnnotationMode.LESSON) {
      if (dto.studentId || dto.hifzEntryId) {
        throw new BadRequestException(
          'A lesson annotation is not about one student — save it as a correction instead',
        );
      }
    } else {
      if (!dto.studentId) {
        throw new BadRequestException(
          'Choose the student this correction is for',
        );
      }
      await this.assertEnrolled(courseId, dto.studentId);
    }
    const sectionId = await this.resolveSection(
      courseId,
      dto.sectionId,
      dto.sessionId,
    );
    if (dto.hifzEntryId) {
      const entry = await this.prisma.hifzEntry.findFirst({
        where: { id: dto.hifzEntryId, courseId, studentId: dto.studentId },
        select: { id: true },
      });
      if (!entry) {
        throw new NotFoundException(
          "That recitation is not this student's in this course",
        );
      }
    }

    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.tajweedAnnotation.create({
          data: {
            id: dto.id,
            organizationId: course.organizationId!,
            courseId,
            sectionId,
            sessionId: dto.sessionId ?? null,
            mode: dto.mode,
            studentId: dto.studentId ?? null,
            hifzEntryId: dto.hifzEntryId ?? null,
            ...ref,
            ...content,
            createdById: user.sub,
            updatedById: user.sub,
          },
        });
        await tx.tajweedAnnotationRevision.create({
          data: revision(created, TajweedChange.CREATED, user.sub),
        });
        return created;
      });
      this.announce('created', row, row.sessionId);
      return toPublic(row);
    } catch (e) {
      // Two resends racing: the loser finds the winner's row.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        const raced = await this.prisma.tajweedAnnotation.findUnique({
          where: { id: dto.id },
        });
        if (raced) return this.replay(raced, user, courseId);
      }
      throw e;
    }
  }

  async update(
    user: JwtPayload,
    courseId: string,
    id: string,
    dto: UpdateTajweedAnnotationDto,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    const row = await this.find(courseId, id);
    if (dto.version !== row.version) {
      throw new ConflictException({ message: STALE, current: toPublic(row) });
    }
    const notify = await this.notifySession(courseId, dto.sessionId, row);

    const ref = selection({
      surahNumber: dto.surahNumber ?? row.surahNumber,
      ayahNumber: dto.ayahNumber ?? row.ayahNumber,
      selection: dto.selection ?? row.selection,
      wordStart: keep(dto.wordStart, row.wordStart),
      wordEnd: keep(dto.wordEnd, row.wordEnd),
      letterStart: keep(dto.letterStart, row.letterStart),
      letterEnd: keep(dto.letterEnd, row.letterEnd),
    });
    const content = contentOf(
      {
        rule: keep(dto.rule, row.rule),
        customLabel: keep(dto.customLabel, row.customLabel),
        style: dto.style ?? row.style,
        color: keep(dto.color, row.color),
        note: keep(dto.note, row.note),
        outcome: keep(dto.outcome, row.outcome),
      },
      row.mode,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      // Conditional on the version, so two edits racing past the check above
      // cannot both land: the second matches nothing.
      const { count } = await tx.tajweedAnnotation.updateMany({
        where: { id, courseId, version: dto.version },
        data: {
          ...ref,
          ...content,
          version: { increment: 1 },
          updatedById: user.sub,
        },
      });
      if (count === 0) throw new ConflictException(STALE);
      const next = await tx.tajweedAnnotation.findUniqueOrThrow({
        where: { id },
      });
      await tx.tajweedAnnotationRevision.create({
        data: revision(next, TajweedChange.UPDATED, user.sub),
      });
      return next;
    });
    this.announce('updated', updated, notify);
    return toPublic(updated);
  }

  async remove(
    user: JwtPayload,
    courseId: string,
    id: string,
    sessionId?: string,
  ) {
    await this.courses.assertCanManageCourse(user, courseId);
    const row = await this.find(courseId, id);
    const notify = await this.notifySession(courseId, sessionId, row);
    await this.prisma.$transaction([
      this.prisma.tajweedAnnotation.delete({ where: { id } }),
      this.prisma.tajweedAnnotationRevision.create({
        data: revision(row, TajweedChange.DELETED, user.sub),
      }),
    ]);
    if (notify) {
      const payload = { sessionId: notify, id, mode: row.mode };
      if (row.mode === TajweedAnnotationMode.LESSON) {
        this.broadcaster.emitToSession(
          notify,
          'tajweed:annotation:deleted',
          payload,
        );
      } else {
        this.broadcaster.emitToSessionStaff(
          notify,
          'tajweed:annotation:deleted',
          payload,
        );
      }
    }
    return { deleted: true };
  }

  /**
   * One student's corrections, with a tally per rule.
   *
   * The tally is counts of what the teacher recorded — issues and correct
   * recitations — not a rating. Nothing here judges a student on its own.
   */
  async studentCorrections(
    user: JwtPayload,
    courseId: string,
    studentId: string,
  ) {
    const staff = await this.canManage(user, courseId);
    if (!staff && studentId !== user.sub) {
      throw new ForbiddenException('You can only see your own corrections');
    }
    await this.assertEnrolled(courseId, studentId);
    const rows = await this.prisma.tajweedAnnotation.findMany({
      where: {
        courseId,
        mode: TajweedAnnotationMode.STUDENT_CORRECTION,
        studentId,
      },
      orderBy: { createdAt: 'desc' },
    });
    const byRule: Record<string, { issues: number; correct: number }> = {};
    for (const r of rows) {
      if (!r.rule) continue;
      const t = (byRule[r.rule] ??= { issues: 0, correct: 0 });
      if (r.outcome === TajweedOutcome.TAJWEED_ISSUE) t.issues++;
      if (r.outcome === TajweedOutcome.CORRECT) t.correct++;
    }
    return { corrections: rows.map(toPublic), byRule };
  }

  // ---- helpers ---------------------------------------------------------

  /** Instructor of the course, or an admin of its workspace. */
  private async canManage(
    user: JwtPayload,
    courseId: string,
  ): Promise<boolean> {
    if (user.role === Role.STUDENT) return false;
    try {
      await this.courses.assertCanManageCourse(user, courseId);
      return true;
    } catch (e) {
      if (e instanceof ForbiddenException) return false;
      throw e;
    }
  }

  private async assertEnrolled(courseId: string, studentId: string) {
    const enrolled = await this.prisma.enrollment.findFirst({
      where: { courseId, studentId },
      select: { id: true },
    });
    if (!enrolled) {
      throw new ForbiddenException(
        'That student is not enrolled in this course',
      );
    }
  }

  private async find(courseId: string, id: string) {
    const row = await this.prisma.tajweedAnnotation.findFirst({
      where: { id, courseId },
    });
    if (!row)
      throw new NotFoundException('Annotation not found in this course');
    return row;
  }

  private replay(
    row: TajweedAnnotationRow,
    user: JwtPayload,
    courseId: string,
  ) {
    if (row.courseId !== courseId || row.createdById !== user.sub) {
      throw new ConflictException('An annotation with that id already exists');
    }
    return toPublic(row);
  }

  /**
   * The lesson an annotation belongs to: the one named, or the session's own.
   * Both are checked against the course, so an id from another course — or
   * another workspace — is refused rather than quietly attached.
   */
  private async resolveSection(
    courseId: string,
    sectionId?: string,
    sessionId?: string,
  ) {
    let section = sectionId ?? null;
    if (sessionId) {
      const session = await this.prisma.liveSession.findFirst({
        where: { id: sessionId, courseId },
        select: { sectionId: true },
      });
      if (!session)
        throw new NotFoundException('Session not found in this course');
      section ??= session.sectionId;
    }
    if (section) {
      const found = await this.prisma.section.findFirst({
        where: { id: section, courseId },
        select: { id: true },
      });
      if (!found)
        throw new NotFoundException('Lesson not found in this course');
    }
    return section;
  }

  /** The where-clauses for "this lesson": its section's annotations, plus any
   *  made in the session when that session has no section. Null = whole course. */
  private async lessonScope(
    courseId: string,
    sectionId?: string,
    sessionId?: string,
  ) {
    const section = await this.resolveSection(courseId, sectionId, sessionId);
    if (!section && !sessionId) return null;
    return [
      ...(section ? [{ sectionId: section }] : []),
      ...(sessionId ? [{ sessionId, sectionId: null }] : []),
    ];
  }

  private async notifySession(
    courseId: string,
    sessionId: string | undefined,
    row: TajweedAnnotationRow,
  ) {
    if (!sessionId) return row.sessionId;
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, courseId },
      select: { id: true },
    });
    if (!session)
      throw new NotFoundException('Session not found in this course');
    return sessionId;
  }

  /** Lesson material goes to the whole room; a correction to staff only, so
   *  one student's feedback never fans out to their classmates. */
  private announce(
    kind: 'created' | 'updated',
    row: TajweedAnnotationRow,
    sessionId: string | null,
  ) {
    if (!sessionId) return;
    const event =
      kind === 'created'
        ? 'tajweed:annotation:created'
        : 'tajweed:annotation:updated';
    const payload = { sessionId, annotation: toPublic(row) };
    if (row.mode === TajweedAnnotationMode.LESSON) {
      this.broadcaster.emitToSession(sessionId, event, payload);
    } else {
      this.broadcaster.emitToSessionStaff(sessionId, event, payload);
    }
  }
}

/** Undefined keeps the stored value; anything else, null included, replaces it. */
function keep<T>(next: T | undefined, stored: T): T {
  return next === undefined ? stored : next;
}

/** Check a reference against the real text; its message becomes a 400. */
function selection(ref: SelectionRef) {
  try {
    return validateSelection(ref);
  } catch (e) {
    throw new BadRequestException((e as Error).message);
  }
}

/** The rule, label, style and note, checked for the annotation's mode. */
function contentOf(
  input: {
    rule?: string | null;
    customLabel?: string | null;
    style?: TajweedAnnotationStyle;
    color?: string | null;
    note?: string | null;
    outcome?: TajweedOutcome | null;
  },
  mode: TajweedAnnotationMode,
) {
  const rule = input.rule ?? null;
  const customLabel = cleanText(input.customLabel, 60);
  const outcome = input.outcome ?? null;
  if (rule !== null && !isTajweedRule(rule)) {
    throw new BadRequestException('Unknown Tajweed rule');
  }
  if (mode === TajweedAnnotationMode.LESSON) {
    if (!rule) throw new BadRequestException('Choose a Tajweed rule');
    if (outcome)
      throw new BadRequestException('Only a correction has an outcome');
  } else {
    if (!outcome)
      throw new BadRequestException('Choose what the correction is');
    if (outcome === TajweedOutcome.TAJWEED_ISSUE && !rule) {
      throw new BadRequestException('Choose which Tajweed rule needs work');
    }
  }
  if (rule === 'custom' && !customLabel) {
    throw new BadRequestException('Give the custom note a label');
  }
  return {
    rule,
    customLabel,
    style: input.style ?? 'HIGHLIGHT',
    color: input.color ?? null,
    note: cleanText(input.note, 1000),
    outcome,
  };
}

function toPublic(row: TajweedAnnotationRow): TajweedAnnotation {
  return {
    id: row.id,
    courseId: row.courseId,
    sectionId: row.sectionId,
    sessionId: row.sessionId,
    mode: row.mode,
    studentId: row.studentId,
    hifzEntryId: row.hifzEntryId,
    surahNumber: row.surahNumber,
    ayahNumber: row.ayahNumber,
    selection: row.selection,
    wordStart: row.wordStart,
    wordEnd: row.wordEnd,
    letterStart: row.letterStart,
    letterEnd: row.letterEnd,
    rule: row.rule as TajweedRule | null,
    customLabel: row.customLabel,
    style: row.style,
    color: row.color,
    note: row.note,
    outcome: row.outcome,
    version: row.version,
    createdById: row.createdById,
    updatedById: row.updatedById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function revision(
  row: TajweedAnnotationRow,
  change: TajweedChange,
  changedById: string,
) {
  return {
    annotationId: row.id,
    version: row.version,
    change,
    snapshot: toPublic(row) as unknown as Prisma.InputJsonObject,
    changedById,
  };
}
