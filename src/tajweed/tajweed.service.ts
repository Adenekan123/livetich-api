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
  TajweedAnnotationPart as TajweedAnnotationPartRow,
  TajweedAnnotationStyle,
} from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  firstAyahOf,
  validateParts,
  type NormalizedPart,
  type PartRef,
} from '../quran/quran-words';
import { RoomBroadcaster } from '../realtime/room-broadcaster';
import type { TajweedAnnotation, TajweedRule } from '../shared';
import { CreateTajweedAnnotationDto } from './dto/create-annotation.dto';
import { ListTajweedAnnotationsDto } from './dto/list-annotations.dto';
import { UpdateTajweedAnnotationDto } from './dto/update-annotation.dto';
import { cleanText, isTajweedRule } from './tajweed-input';

const STALE =
  'This annotation was changed somewhere else. Reload it and try again.';

/** A mark is its parts, and they always come back in reading order. */
const PARTS = { parts: { orderBy: { position: 'asc' as const } } };

type AnnotationRow = TajweedAnnotationRow & {
  parts: TajweedAnnotationPartRow[];
};

/**
 * Saved Tajweed annotations for a course: lesson material restored with its
 * lesson, and corrections recorded against one student's recitation.
 *
 * A mark points at the canonical text as a list of parts — a word here, a
 * letter two words later, one in the ayah below — so a rule that lives between
 * two letters of different words is one mark, not two. Nothing between two
 * parts is implied.
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
   *
   * Marks the teacher chose to keep come back for the whole course, whatever
   * lesson they were made in: "keep for next time" means any class that opens
   * those ayahs sees them.
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
        ...(scope ? { OR: [...scope, { kept: true }] } : {}),
      },
      include: PARTS,
      orderBy: [
        { surahNumber: 'asc' },
        { ayahNumber: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    let corrections: AnnotationRow[] = [];
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
          include: PARTS,
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
      include: PARTS,
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

    const parts = checkParts(dto.parts);
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
            // Only lesson material is kept for next time; a correction belongs
            // to the student who earned it, not to the ayah.
            kept:
              dto.mode === TajweedAnnotationMode.LESSON
                ? (dto.kept ?? false)
                : false,
            ...firstAyahOf(parts),
            parts: { create: rowsFor(parts) },
            ...content,
            createdById: user.sub,
            updatedById: user.sub,
          },
          include: PARTS,
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
          include: PARTS,
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

    // Parts are sent whole or not at all: what arrives replaces what is stored.
    const parts = dto.parts ? checkParts(dto.parts) : null;
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
    const kept =
      row.mode === TajweedAnnotationMode.LESSON
        ? keep(dto.kept, row.kept)
        : false;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Conditional on the version, so two edits racing past the check above
      // cannot both land: the second matches nothing.
      const { count } = await tx.tajweedAnnotation.updateMany({
        where: { id, courseId, version: dto.version },
        data: {
          ...(parts ? firstAyahOf(parts) : {}),
          ...content,
          kept,
          version: { increment: 1 },
          updatedById: user.sub,
        },
      });
      if (count === 0) throw new ConflictException(STALE);
      if (parts) {
        await tx.tajweedAnnotationPart.deleteMany({
          where: { annotationId: id },
        });
        await tx.tajweedAnnotationPart.createMany({
          data: rowsFor(parts).map((p) => ({ ...p, annotationId: id })),
        });
      }
      const next = await tx.tajweedAnnotation.findUniqueOrThrow({
        where: { id },
        include: PARTS,
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
      // The parts go with it: they are pieces of this mark, not records of
      // their own. The revision below keeps what it looked like.
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
      include: PARTS,
      orderBy: { createdAt: 'desc' },
    });
    return { corrections: rows.map(toPublic), byRule: tallyByRule(rows) };
  }

  /**
   * Where each student stands, rule by rule, from what the teacher recorded.
   *
   * Counts only — issues heard and correct recitations — never a score or a
   * grade. Staff see every enrolled student; a student sees only themselves.
   */
  async progress(user: JwtPayload, courseId: string) {
    const staff = await this.canManage(user, courseId);
    if (!staff) await this.assertEnrolled(courseId, user.sub);
    const mine = staff ? {} : { studentId: user.sub };
    const [enrollments, rows] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where: { courseId, ...mine },
        select: { student: { select: { id: true, name: true } } },
        orderBy: { student: { name: 'asc' } },
      }),
      this.prisma.tajweedAnnotation.findMany({
        where: {
          courseId,
          mode: TajweedAnnotationMode.STUDENT_CORRECTION,
          ...mine,
        },
        select: {
          studentId: true,
          rule: true,
          outcome: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return enrollments.map(({ student }) => {
      const theirs = rows.filter((r) => r.studentId === student.id);
      const byOutcome: Partial<Record<TajweedOutcome, number>> = {};
      for (const r of theirs) {
        if (r.outcome) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
      }
      return {
        student,
        total: theirs.length,
        lastAt: theirs[0]?.createdAt.toISOString() ?? null,
        byRule: tallyByRule(theirs),
        byOutcome,
      };
    });
  }

  /**
   * Who changed an annotation, what it looked like after each change, and
   * when — including after it was deleted. Staff only: a correction's history
   * is part of a student's record.
   */
  async history(user: JwtPayload, courseId: string, id: string) {
    await this.courses.assertCanManageCourse(user, courseId);
    const revisions = await this.prisma.tajweedAnnotationRevision.findMany({
      where: { annotationId: id },
      orderBy: { changedAt: 'asc' },
    });
    // Ids are chosen by clients, so the snapshot — not the id — decides which
    // course a revision belongs to. Another course's history never leaks here.
    const inCourse = revisions.filter(
      (r) =>
        (r.snapshot as { courseId?: string } | null)?.courseId === courseId,
    );
    if (!inCourse.length) {
      throw new NotFoundException('Annotation not found in this course');
    }
    const people = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(inCourse.map((r) => r.changedById))] } },
      select: { id: true, name: true },
    });
    const names = new Map(people.map((p) => [p.id, p.name]));
    return inCourse.map((r) => ({
      id: r.id,
      version: r.version,
      change: r.change,
      changedAt: r.changedAt.toISOString(),
      changedBy: {
        id: r.changedById,
        name: names.get(r.changedById) ?? 'Unknown',
      },
      snapshot: r.snapshot as unknown as TajweedAnnotation,
    }));
  }

  /**
   * Attach the corrections heard in a session to the recitation they belong to.
   *
   * Called when the teacher saves a student's recitation, so the Hifz record
   * and the Tajweed corrections made while listening become one account of the
   * sitting. Only corrections not already linked are touched, each as a
   * version-checked edit with its own history entry; one changed meanwhile is
   * left alone rather than overwritten.
   */
  async linkCorrectionsToRecitation(entry: {
    id: string;
    courseId: string;
    studentId: string;
    sessionId: string | null;
    recordedById: string;
  }): Promise<number> {
    if (!entry.sessionId) return 0;
    const rows = await this.prisma.tajweedAnnotation.findMany({
      where: {
        courseId: entry.courseId,
        studentId: entry.studentId,
        sessionId: entry.sessionId,
        mode: TajweedAnnotationMode.STUDENT_CORRECTION,
        hifzEntryId: null,
      },
      select: { id: true, version: true },
    });
    let linked = 0;
    for (const row of rows) {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.tajweedAnnotation.updateMany({
          where: { id: row.id, version: row.version, hifzEntryId: null },
          data: {
            hifzEntryId: entry.id,
            version: { increment: 1 },
            updatedById: entry.recordedById,
          },
        });
        if (count === 0) return;
        const next = await tx.tajweedAnnotation.findUniqueOrThrow({
          where: { id: row.id },
          include: PARTS,
        });
        await tx.tajweedAnnotationRevision.create({
          data: revision(next, TajweedChange.UPDATED, entry.recordedById),
        });
        linked++;
      });
    }
    return linked;
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
      include: PARTS,
    });
    if (!row) {
      throw new NotFoundException('Annotation not found in this course');
    }
    return row;
  }

  private replay(row: AnnotationRow, user: JwtPayload, courseId: string) {
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
      if (!session) {
        throw new NotFoundException('Session not found in this course');
      }
      section ??= session.sectionId;
    }
    if (section) {
      const found = await this.prisma.section.findFirst({
        where: { id: section, courseId },
        select: { id: true },
      });
      if (!found) {
        throw new NotFoundException('Lesson not found in this course');
      }
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
    row: AnnotationRow,
  ) {
    if (!sessionId) return row.sessionId;
    const session = await this.prisma.liveSession.findFirst({
      where: { id: sessionId, courseId },
      select: { id: true },
    });
    if (!session) {
      throw new NotFoundException('Session not found in this course');
    }
    return sessionId;
  }

  /** Lesson material goes to the whole room; a correction to staff only, so
   *  one student's feedback never fans out to their classmates. */
  private announce(
    kind: 'created' | 'updated',
    row: AnnotationRow,
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

/** Check the parts against the real text; the message becomes a 400. */
function checkParts(parts: readonly PartRef[]): NormalizedPart[] {
  try {
    return validateParts(parts);
  } catch (e) {
    throw new BadRequestException((e as Error).message);
  }
}

/** Parts as rows, numbered so they come back in the order they were picked. */
function rowsFor(parts: readonly NormalizedPart[]) {
  return parts.map((part, position) => ({ ...part, position }));
}

/** Per rule: how many issues the teacher heard, and how many correct. */
function tallyByRule(
  rows: { rule: string | null; outcome: TajweedOutcome | null }[],
) {
  const byRule: Record<string, { issues: number; correct: number }> = {};
  for (const r of rows) {
    if (!r.rule) continue;
    const t = (byRule[r.rule] ??= { issues: 0, correct: 0 });
    if (r.outcome === TajweedOutcome.TAJWEED_ISSUE) t.issues++;
    if (r.outcome === TajweedOutcome.CORRECT) t.correct++;
  }
  return byRule;
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
    if (outcome) {
      throw new BadRequestException('Only a correction has an outcome');
    }
  } else {
    if (!outcome) {
      throw new BadRequestException('Choose what the correction is');
    }
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

function toPublic(row: AnnotationRow): TajweedAnnotation {
  return {
    id: row.id,
    courseId: row.courseId,
    sectionId: row.sectionId,
    sessionId: row.sessionId,
    mode: row.mode,
    studentId: row.studentId,
    hifzEntryId: row.hifzEntryId,
    kept: row.kept,
    surahNumber: row.surahNumber,
    ayahNumber: row.ayahNumber,
    parts: row.parts.map((p) => ({
      surahNumber: p.surahNumber,
      ayahNumber: p.ayahNumber,
      wordIndex: p.wordIndex,
      letterIndex: p.letterIndex,
    })),
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
  row: AnnotationRow,
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
