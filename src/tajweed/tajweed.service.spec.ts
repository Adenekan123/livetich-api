/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment --
   The in-memory Prisma stands in for an async client, so its methods are async
   without awaiting anything; Jest's asymmetric matchers are typed `any`. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import type { JwtPayload } from '../auth/jwt-payload';
import { CoursesService } from '../courses/courses.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RoomBroadcaster } from '../realtime/room-broadcaster';
import type { CreateTajweedAnnotationDto } from './dto/create-annotation.dto';
import { TajweedService } from './tajweed.service';

const COURSE = 'course-1';
const ORG = 'org-1';
const STUDENTS: Record<string, string> = {
  'student-1': 'Ahmad',
  'student-2': 'Bilal',
};
const SECTIONS = ['section-1', 'section-2'];

const person = (over: Partial<JwtPayload>): JwtPayload => ({
  sub: 'teacher-1',
  role: Role.INSTRUCTOR,
  name: 'Teacher',
  email: 'teacher@example.com',
  organizationId: ORG,
  emailVerified: true,
  isSuperAdmin: false,
  ...over,
});
const teacher = person({});
const student = person({ sub: 'student-1', role: Role.STUDENT });
const outsideAdmin = person({
  sub: 'admin-2',
  role: Role.ORG_ADMIN,
  organizationId: 'org-2',
});

type PartRow = Record<string, unknown>;
type Row = Record<string, unknown> & {
  id: string;
  version: number;
  parts: PartRow[];
};

/**
 * Every key of `where` matches the row (null included). OR is honoured — the
 * lesson scope is built from it, and "kept marks come back for the whole
 * course" is exactly an OR branch, so ignoring it would test nothing.
 */
const matches = (
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean =>
  Object.entries(where).every(([key, value]) => {
    if (key === 'OR') {
      return (value as Record<string, unknown>[]).some((clause) =>
        matches(row, clause),
      );
    }
    return value === undefined || row[key] === value;
  });

/**
 * An in-memory Prisma, just deep enough for the service. Authorization is not
 * faked: the real CoursesService.assertCanManageCourse runs against it, so the
 * workspace-isolation tests exercise the same check production does.
 */
function setup() {
  const rows = new Map<string, Row>();
  const revisions: (Record<string, unknown> & { changedAt: Date })[] = [];
  const prisma = {
    course: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === COURSE
          ? { instructorId: teacher.sub, organizationId: ORG }
          : null,
      ),
    },
    enrollment: {
      findFirst: jest.fn(async ({ where }: { where: { studentId: string } }) =>
        STUDENTS[where.studentId] ? { id: 'enrollment' } : null,
      ),
      findMany: jest.fn(async ({ where }: { where: { studentId?: string } }) =>
        Object.entries(STUDENTS)
          .filter(([id]) => !where.studentId || id === where.studentId)
          .map(([id, name]) => ({ student: { id, name } })),
      ),
    },
    user: {
      findMany: jest.fn(async () => [{ id: teacher.sub, name: 'Teacher' }]),
    },
    liveSession: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; courseId: string } }) =>
          where.id === 'session-1' && where.courseId === COURSE
            ? { id: 'session-1', sectionId: 'section-1' }
            : null,
      ),
    },
    section: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; courseId: string } }) =>
          SECTIONS.includes(where.id) && where.courseId === COURSE
            ? { id: where.id }
            : null,
      ),
    },
    hifzEntry: { findFirst: jest.fn(async () => null) },
    tajweedAnnotation: {
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          rows.get(where.id) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) =>
        rows.get(where.id)!,
      ),
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          [...rows.values()].find((r) => matches(r, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((r) => matches(r, where)),
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Record<string, unknown> & {
            id: string;
            parts?: { create: PartRow[] };
          };
        }) => {
          const now = new Date();
          const { parts, ...rest } = data;
          const row: Row = {
            sectionId: null,
            sessionId: null,
            studentId: null,
            hifzEntryId: null,
            kept: false,
            createdAt: now,
            updatedAt: now,
            ...rest,
            parts: (parts?.create ?? []).map((p, i) => ({
              id: `part-${i}`,
              annotationId: data.id,
              ...p,
            })),
            version: 1,
          };
          rows.set(row.id, row);
          return row;
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: Record<string, unknown> & { id: string };
          data: Record<string, unknown>;
        }) => {
          const r = rows.get(where.id);
          if (!r || !matches(r, where)) return { count: 0 };
          // The fake bumps the version itself, as Prisma's `increment` would.
          const rest = { ...data };
          delete rest.version;
          Object.assign(r, rest, {
            version: r.version + 1,
            updatedAt: new Date(),
          });
          return { count: 1 };
        },
      ),
      delete: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.get(where.id);
        rows.delete(where.id);
        return r;
      }),
    },
    // Parts belong to their mark: they are replaced wholesale on an edit and
    // go with it when it is deleted.
    tajweedAnnotationPart: {
      deleteMany: jest.fn(
        async ({ where }: { where: { annotationId: string } }) => {
          const row = rows.get(where.annotationId);
          const count = row?.parts.length ?? 0;
          if (row) row.parts = [];
          return { count };
        },
      ),
      createMany: jest.fn(async ({ data }: { data: PartRow[] }) => {
        for (const part of data) {
          const row = rows.get(part.annotationId as string);
          if (row) row.parts.push({ id: `part-${row.parts.length}`, ...part });
        }
        return { count: data.length };
      }),
    },
    tajweedAnnotationRevision: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const saved = {
          id: `rev-${revisions.length + 1}`,
          changedAt: new Date(),
          ...data,
        };
        revisions.push(saved);
        return saved;
      }),
      findMany: jest.fn(
        async ({ where }: { where: { annotationId: string } }) =>
          revisions.filter((r) => r.annotationId === where.annotationId),
      ),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => unknown)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );

  const courses = {
    assertCanManageCourse: (user: JwtPayload, courseId: string) =>
      CoursesService.prototype.assertCanManageCourse.call(
        { prisma },
        user,
        courseId,
      ),
  } as unknown as CoursesService;
  const broadcaster = {
    emitToSession: jest.fn(),
    emitToSessionStaff: jest.fn(),
  };
  const service = new TajweedService(
    prisma as unknown as PrismaService,
    courses,
    broadcaster as unknown as RoomBroadcaster,
  );
  return { service, prisma, rows, revisions, broadcaster };
}

/** Al-Falaq 3 — "وَمِن شَرِّ غَاسِقٍ إِذَا وَقَبَ" — five words, so word 9 is not there. */
const word = (ayahNumber: number, wordIndex: number) => ({
  surahNumber: 113,
  ayahNumber,
  wordIndex,
});

const lesson = (
  over: Partial<CreateTajweedAnnotationDto> = {},
): CreateTajweedAnnotationDto => ({
  id: 'annotation-0001',
  mode: 'LESSON',
  sessionId: 'session-1',
  parts: [word(3, 0)],
  rule: 'nun.ikhfa_haqiqi',
  ...over,
});

const correction = (over: Partial<CreateTajweedAnnotationDto> = {}) =>
  lesson({
    id: 'correction-0001',
    mode: 'STUDENT_CORRECTION',
    studentId: 'student-1',
    outcome: 'TAJWEED_ISSUE',
    rule: 'qalqalah.kubra',
    ...over,
  });

describe('TajweedService', () => {
  it("saves an instructor's lesson annotation to the session's lesson and shows the class", async () => {
    const { service, rows, revisions, broadcaster } = setup();
    const saved = await service.create(teacher, COURSE, lesson());

    expect(saved).toMatchObject({
      sectionId: 'section-1',
      surahNumber: 113,
      ayahNumber: 3,
      parts: [
        { surahNumber: 113, ayahNumber: 3, wordIndex: 0, letterIndex: null },
      ],
      version: 1,
    });
    expect(rows.get('annotation-0001')).toMatchObject({ organizationId: ORG });
    expect(revisions).toEqual([
      expect.objectContaining({ change: 'CREATED', version: 1 }),
    ]);
    expect(broadcaster.emitToSession).toHaveBeenCalledWith(
      'session-1',
      'tajweed:annotation:created',
      expect.objectContaining({
        annotation: expect.objectContaining({ id: 'annotation-0001' }),
      }),
    );
  });

  it('holds letters from two different ayahs as one mark, in reading order', async () => {
    const { service } = setup();
    const saved = await service.create(
      teacher,
      COURSE,
      // Picked out of order, and across an ayah boundary: the rule lives on the
      // last letter of one ayah and a letter of the next.
      lesson({
        parts: [
          { surahNumber: 113, ayahNumber: 4, wordIndex: 1, letterIndex: 0 },
          { surahNumber: 113, ayahNumber: 3, wordIndex: 4, letterIndex: 1 },
        ],
      }),
    );

    expect(saved.parts).toEqual([
      { surahNumber: 113, ayahNumber: 3, wordIndex: 4, letterIndex: 1 },
      { surahNumber: 113, ayahNumber: 4, wordIndex: 1, letterIndex: 0 },
    ]);
    // Filed under the first part, whatever order the teacher picked in.
    expect(saved).toMatchObject({ surahNumber: 113, ayahNumber: 3 });
  });

  it('drops a part picked twice rather than marking it twice', async () => {
    const { service } = setup();
    const saved = await service.create(
      teacher,
      COURSE,
      lesson({ parts: [word(3, 2), word(3, 2), word(3, 1)] }),
    );
    expect(saved.parts).toEqual([
      { surahNumber: 113, ayahNumber: 3, wordIndex: 1, letterIndex: null },
      { surahNumber: 113, ayahNumber: 3, wordIndex: 2, letterIndex: null },
    ]);
  });

  it('refuses a student who tries to annotate', async () => {
    const { service, rows } = setup();
    await expect(
      service.create(student, COURSE, lesson()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(rows.size).toBe(0);
  });

  it("keeps another workspace's admin out of both writing and reading", async () => {
    const { service } = setup();
    await expect(
      service.create(outsideAdmin, COURSE, lesson()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.list(outsideAdmin, COURSE, { sessionId: 'session-1' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.progress(outsideAdmin, COURSE)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("refuses a part that is not in the Qur'an", async () => {
    const { service } = setup();
    await expect(
      service.create(teacher, COURSE, lesson({ parts: [word(6, 0)] })),
    ).rejects.toThrow(/has no ayah 6/);
    await expect(
      service.create(teacher, COURSE, lesson({ parts: [word(3, 9)] })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(
        teacher,
        COURSE,
        lesson({
          parts: [
            { surahNumber: 113, ayahNumber: 3, wordIndex: 0, letterIndex: 99 },
          ],
        }),
      ),
    ).rejects.toThrow(/letters/);
    await expect(
      service.create(
        teacher,
        COURSE,
        lesson({
          parts: [{ surahNumber: 113, ayahNumber: 3, letterIndex: 0 }],
        }),
      ),
    ).rejects.toThrow(/letter needs the word/);
    await expect(
      service.create(teacher, COURSE, lesson({ parts: [] })),
    ).rejects.toThrow(/Pick a word or a letter/);
  });

  it('refuses a session from outside the course', async () => {
    const { service } = setup();
    await expect(
      service.create(
        teacher,
        COURSE,
        lesson({ sessionId: 'someone-elses-session' }),
      ),
    ).rejects.toThrow(/Session not found/);
  });

  it('saves prepared lesson material to a lesson, with no session at all', async () => {
    const { service, broadcaster } = setup();
    const saved = await service.create(
      teacher,
      COURSE,
      lesson({ sessionId: undefined, sectionId: 'section-1' }),
    );
    expect(saved).toMatchObject({ sectionId: 'section-1', sessionId: null });
    // Nobody is in a room to tell.
    expect(broadcaster.emitToSession).not.toHaveBeenCalled();
  });

  it('brings a kept mark back in another lesson of the same course', async () => {
    const { service } = setup();
    await service.create(teacher, COURSE, lesson({ kept: true }));
    await service.create(
      teacher,
      COURSE,
      lesson({ id: 'annotation-0002', kept: false }),
    );

    // A different lesson entirely: only what the teacher chose to keep follows.
    const next = await service.list(teacher, COURSE, {
      sectionId: 'section-2',
    });
    expect(next.lesson.map((a) => a.id)).toEqual(['annotation-0001']);

    // The lesson it was made in still shows both.
    const same = await service.list(teacher, COURSE, {
      sectionId: 'section-1',
    });
    expect(same.lesson.map((a) => a.id)).toEqual([
      'annotation-0001',
      'annotation-0002',
    ]);
  });

  it('never keeps a correction for the whole course', async () => {
    const { service } = setup();
    const saved = await service.create(
      teacher,
      COURSE,
      correction({ kept: true }),
    );
    expect(saved.kept).toBe(false);
  });

  it('keeps lesson material and student corrections apart', async () => {
    const { service } = setup();
    await expect(
      service.create(teacher, COURSE, lesson({ studentId: 'student-1' })),
    ).rejects.toThrow(/not about one student/);
    await expect(
      service.create(teacher, COURSE, correction({ studentId: undefined })),
    ).rejects.toThrow(/Choose the student/);
  });

  it('saves a correction against an enrolled student and tells only staff', async () => {
    const { service, broadcaster } = setup();
    const saved = await service.create(teacher, COURSE, correction());

    expect(saved).toMatchObject({
      studentId: 'student-1',
      outcome: 'TAJWEED_ISSUE',
      rule: 'qalqalah.kubra',
    });
    expect(broadcaster.emitToSessionStaff).toHaveBeenCalledWith(
      'session-1',
      'tajweed:annotation:created',
      expect.anything(),
    );
    expect(broadcaster.emitToSession).not.toHaveBeenCalled();
  });

  it('refuses a correction for someone who is not in the course', async () => {
    const { service } = setup();
    await expect(
      service.create(teacher, COURSE, correction({ studentId: 'stranger' })),
    ).rejects.toThrow(/not enrolled/);
  });

  it('does not make a second annotation when a create is resent', async () => {
    const { service, prisma, rows } = setup();
    const first = await service.create(teacher, COURSE, lesson());
    const again = await service.create(teacher, COURSE, lesson());

    expect(again).toEqual(first);
    expect(prisma.tajweedAnnotation.create).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(1);
  });

  it('replaces the parts of a mark when an edit sends new ones', async () => {
    const { service } = setup();
    await service.create(teacher, COURSE, lesson());

    const edited = await service.update(teacher, COURSE, 'annotation-0001', {
      version: 1,
      parts: [word(3, 2), word(4, 0)],
    });
    expect(edited.parts).toEqual([
      { surahNumber: 113, ayahNumber: 3, wordIndex: 2, letterIndex: null },
      { surahNumber: 113, ayahNumber: 4, wordIndex: 0, letterIndex: null },
    ]);

    // An edit that says nothing about the parts leaves them alone.
    const noted = await service.update(teacher, COURSE, 'annotation-0001', {
      version: 2,
      note: 'Hold it two counts',
    });
    expect(noted.parts).toHaveLength(2);
  });

  it('refuses an edit made against an older version', async () => {
    const { service } = setup();
    await service.create(teacher, COURSE, lesson());

    const edited = await service.update(teacher, COURSE, 'annotation-0001', {
      version: 1,
      note: 'Keep the nasal sound',
    });
    expect(edited).toMatchObject({ version: 2, note: 'Keep the nasal sound' });

    await expect(
      service.update(teacher, COURSE, 'annotation-0001', {
        version: 1,
        rule: 'madd.tabii',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('still accepts a rule saved before the taxonomy was grouped', async () => {
    const { service } = setup();
    const saved = await service.create(
      teacher,
      COURSE,
      lesson({ rule: 'madd' }),
    );
    expect(saved.rule).toBe('madd');
  });

  it('keeps a record of what was deleted, and clears it for the class', async () => {
    const { service, rows, revisions, broadcaster } = setup();
    await service.create(teacher, COURSE, lesson());
    await service.remove(teacher, COURSE, 'annotation-0001');

    expect(rows.size).toBe(0);
    expect(revisions.at(-1)).toMatchObject({
      change: 'DELETED',
      annotationId: 'annotation-0001',
    });
    expect(broadcaster.emitToSession).toHaveBeenCalledWith(
      'session-1',
      'tajweed:annotation:deleted',
      {
        sessionId: 'session-1',
        id: 'annotation-0001',
        mode: 'LESSON',
      },
    );
  });

  it('shows a student the lesson and only their own corrections', async () => {
    const { service } = setup();
    await service.create(teacher, COURSE, lesson());
    await service.create(teacher, COURSE, correction());
    await service.create(
      teacher,
      COURSE,
      correction({ id: 'correction-0002', studentId: 'student-2' }),
    );

    const seen = await service.list(student, COURSE, {
      sessionId: 'session-1',
    });
    expect(seen.lesson.map((a) => a.id)).toEqual(['annotation-0001']);
    expect(seen.corrections.map((a) => a.studentId)).toEqual(['student-1']);
  });

  it("does not let a student read another student's corrections", async () => {
    const { service } = setup();
    await expect(
      service.studentCorrections(student, COURSE, 'student-2'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('counts what the teacher recorded per rule, without rating anyone', async () => {
    const { service } = setup();
    await service.create(teacher, COURSE, correction());
    await service.create(
      teacher,
      COURSE,
      correction({ id: 'correction-0002', outcome: 'CORRECT' }),
    );

    const { byRule } = await service.studentCorrections(
      teacher,
      COURSE,
      'student-1',
    );
    expect(byRule).toEqual({ 'qalqalah.kubra': { issues: 1, correct: 1 } });
  });

  it('shows staff the whole class’s progress, and a student only their own', async () => {
    const { service } = setup();
    await service.create(teacher, COURSE, correction());
    await service.create(
      teacher,
      COURSE,
      correction({ id: 'correction-0002', outcome: 'REPEAT', rule: undefined }),
    );

    const classView = await service.progress(teacher, COURSE);
    expect(classView).toEqual([
      expect.objectContaining({
        student: { id: 'student-1', name: 'Ahmad' },
        total: 2,
        byRule: { 'qalqalah.kubra': { issues: 1, correct: 0 } },
        byOutcome: { TAJWEED_ISSUE: 1, REPEAT: 1 },
      }),
      expect.objectContaining({
        student: { id: 'student-2', name: 'Bilal' },
        total: 0,
        lastAt: null,
      }),
    ]);

    const own = await service.progress(student, COURSE);
    expect(own.map((r) => r.student.id)).toEqual(['student-1']);
  });

  it('shows staff who changed an annotation and when — even after it is deleted', async () => {
    const { service } = setup();
    await service.create(teacher, COURSE, correction());
    await service.update(teacher, COURSE, 'correction-0001', {
      version: 1,
      note: 'Bounce the qaf',
    });
    await service.remove(teacher, COURSE, 'correction-0001');

    const history = await service.history(teacher, COURSE, 'correction-0001');
    expect(history.map((h) => h.change)).toEqual([
      'CREATED',
      'UPDATED',
      'DELETED',
    ]);
    expect(history[1]).toMatchObject({
      version: 2,
      changedBy: { name: 'Teacher' },
      snapshot: expect.objectContaining({ note: 'Bounce the qaf' }),
    });

    await expect(
      service.history(student, COURSE, 'correction-0001'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.history(teacher, COURSE, 'never-existed'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('links the corrections heard in a session to the recitation they belong to', async () => {
    const { service, rows, revisions } = setup();
    await service.create(teacher, COURSE, correction());
    // Another student's correction in the same session is not theirs to link.
    await service.create(
      teacher,
      COURSE,
      correction({ id: 'correction-0002', studentId: 'student-2' }),
    );

    const entry = {
      id: 'entry-1',
      courseId: COURSE,
      studentId: 'student-1',
      sessionId: 'session-1',
      recordedById: teacher.sub,
    };
    expect(await service.linkCorrectionsToRecitation(entry)).toBe(1);
    expect(rows.get('correction-0001')).toMatchObject({
      hifzEntryId: 'entry-1',
      version: 2,
    });
    expect(rows.get('correction-0002')).toMatchObject({ hifzEntryId: null });
    expect(revisions.at(-1)).toMatchObject({
      change: 'UPDATED',
      annotationId: 'correction-0001',
    });

    // Saving again links nothing twice, and a recitation outside a session links nothing.
    expect(await service.linkCorrectionsToRecitation(entry)).toBe(0);
    expect(
      await service.linkCorrectionsToRecitation({ ...entry, sessionId: null }),
    ).toBe(0);
  });

  it('stores a note as plain text', async () => {
    const { service } = setup();
    const saved = await service.create(
      teacher,
      COURSE,
      lesson({ note: '<b>Hold</b> the ghunnah<script>alert(1)</script>' }),
    );
    expect(saved.note).toBe('Hold the ghunnahalert(1)');
  });

  it('requires a label for a custom note', async () => {
    const { service } = setup();
    await expect(
      service.create(teacher, COURSE, lesson({ rule: 'custom' })),
    ).rejects.toThrow(/label/);
  });
});
