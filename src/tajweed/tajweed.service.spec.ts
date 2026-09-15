/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment --
   The in-memory Prisma stands in for an async client, so its methods are async
   without awaiting anything; Jest's asymmetric matchers are typed `any`. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
const ENROLLED = new Set(['student-1', 'student-2']);

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

type Row = Record<string, unknown> & { id: string; version: number };

/**
 * An in-memory Prisma, just deep enough for the service. Authorization is not
 * faked: the real CoursesService.assertCanManageCourse runs against it, so the
 * workspace-isolation tests exercise the same check production does.
 */
function setup() {
  const rows = new Map<string, Row>();
  const revisions: Record<string, unknown>[] = [];
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
        ENROLLED.has(where.studentId) ? { id: 'enrollment' } : null,
      ),
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
          where.id === 'section-1' && where.courseId === COURSE
            ? { id: 'section-1' }
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
        async ({ where }: { where: { id: string; courseId: string } }) => {
          const r = rows.get(where.id);
          return r && r.courseId === where.courseId ? r : null;
        },
      ),
      findMany: jest.fn(
        async ({
          where,
        }: {
          where: { courseId: string; mode: string; studentId?: string };
        }) =>
          [...rows.values()].filter(
            (r) =>
              r.courseId === where.courseId &&
              r.mode === where.mode &&
              (where.studentId === undefined ||
                r.studentId === where.studentId),
          ),
      ),
      create: jest.fn(
        async ({
          data,
        }: {
          data: Record<string, unknown> & { id: string };
        }) => {
          const now = new Date();
          const row: Row = {
            sectionId: null,
            sessionId: null,
            studentId: null,
            hifzEntryId: null,
            createdAt: now,
            updatedAt: now,
            ...data,
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
          where: { id: string; version: number };
          data: Record<string, unknown>;
        }) => {
          const r = rows.get(where.id);
          if (!r || r.version !== where.version) return { count: 0 };
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
    tajweedAnnotationRevision: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        revisions.push(data);
        return data;
      }),
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

const lesson = (
  over: Partial<CreateTajweedAnnotationDto> = {},
): CreateTajweedAnnotationDto => ({
  id: 'annotation-0001',
  mode: 'LESSON',
  sessionId: 'session-1',
  surahNumber: 113,
  ayahNumber: 3,
  selection: 'WORD',
  wordStart: 0,
  rule: 'ikhfa',
  ...over,
});

const correction = (over: Partial<CreateTajweedAnnotationDto> = {}) =>
  lesson({
    id: 'correction-0001',
    mode: 'STUDENT_CORRECTION',
    studentId: 'student-1',
    outcome: 'TAJWEED_ISSUE',
    rule: 'qalqalah',
    ...over,
  });

describe('TajweedService', () => {
  it("saves an instructor's lesson annotation to the session's lesson and shows the class", async () => {
    const { service, rows, revisions, broadcaster } = setup();
    const saved = await service.create(teacher, COURSE, lesson());

    expect(saved).toMatchObject({
      sectionId: 'section-1',
      wordStart: 0,
      wordEnd: 0,
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
  });

  it("refuses a reference that is not in the Qur'an", async () => {
    const { service } = setup();
    await expect(
      service.create(teacher, COURSE, lesson({ ayahNumber: 6 })),
    ).rejects.toThrow(/has no ayah 6/);
    await expect(
      service.create(teacher, COURSE, lesson({ wordStart: 9 })),
    ).rejects.toBeInstanceOf(BadRequestException);
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
      rule: 'qalqalah',
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
        rule: 'madd',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
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
    expect(byRule).toEqual({ qalqalah: { issues: 1, correct: 1 } });
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
