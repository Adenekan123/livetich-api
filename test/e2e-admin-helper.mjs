/**
 * Cross-repo helper for the web e2e "batch flow" spec. The web repo has no DB
 * access or JWT secret, so it shells out to this (run from the api repo) to:
 *   default  -> print JSON { adminToken, studentEnrolled, programId, programTitle, batchCount }
 *   --cleanup-> delete e2e-created batches ("E2E Batch …") and their snapshot rows
 *
 * The admin token is minted (not a login) so tests need no password. It is a
 * normal HS256 JWT signed with the API's JWT_SECRET — the same token the auth
 * guard verifies for a real session.
 */
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jwt = require(
  require.resolve('jsonwebtoken', { paths: [require.resolve('@nestjs/jwt')] }),
);

const apiRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const env = fs.readFileSync(path.join(apiRoot, '.env'), 'utf8');
const SECRET = env
  .match(/^JWT_SECRET=(.*)$/m)[1]
  .trim()
  .replace(/^["'](.*)["']$/, '$1');

const STUDENT_EMAIL = 'eames.rashed@forliion.com';
const BATCH_MARKER = 'E2E Batch';
const prisma = new PrismaClient();

async function cleanup() {
  const batches = await prisma.course.findMany({
    where: { parentCourseId: { not: null }, title: { contains: BATCH_MARKER } },
    select: { id: true },
  });
  for (const b of batches) {
    await prisma.assessmentQuestion.deleteMany({ where: { courseId: b.id } });
    await prisma.assignment.deleteMany({ where: { courseId: b.id } });
    await prisma.courseDocument.deleteMany({ where: { courseId: b.id } });
    await prisma.section.deleteMany({ where: { courseId: b.id } });
    await prisma.course.delete({ where: { id: b.id } });
  }
  console.error(`cleanup: removed ${batches.length} e2e batch(es)`);
}

async function setup() {
  // Work in the test org (the one the seeded student/instructor belong to).
  const student = await prisma.user.findFirst({
    where: { email: STUDENT_EMAIL },
    select: { id: true, organizationId: true },
  });
  if (!student?.organizationId) throw new Error('test student/org not found');
  const orgId = student.organizationId;

  const admin = await prisma.user.findFirst({
    where: { role: 'ORG_ADMIN', organizationId: orgId },
  });
  if (!admin) throw new Error('no ORG_ADMIN in test org');

  // A program (no parent) in the org — prefer one the student is NOT enrolled in
  // (so the "Choose your batch" rail shows) and that has some content to copy.
  const programs = await prisma.course.findMany({
    where: { organizationId: orgId, parentCourseId: null },
    include: {
      _count: { select: { sections: true, batches: true } },
      enrollments: { where: { studentId: student.id }, select: { id: true } },
    },
  });
  if (!programs.length) throw new Error('no program in test org');
  programs.sort(
    (a, b) =>
      (a.enrollments.length ? 1 : 0) - (b.enrollments.length ? 1 : 0) ||
      b._count.sections - a._count.sections,
  );
  const program = programs[0];

  const adminToken = jwt.sign(
    {
      sub: admin.id,
      role: admin.role,
      name: admin.name,
      email: admin.email,
      organizationId: admin.organizationId,
      emailVerified: true,
      isSuperAdmin: !!admin.isSuperAdmin,
    },
    SECRET,
    { expiresIn: '7d' },
  );

  process.stdout.write(
    JSON.stringify({
      adminToken,
      studentEnrolled: program.enrollments.length > 0,
      programId: program.id,
      programTitle: program.title,
      batchCount: program._count.batches,
    }),
  );
}

// A held (unreleased) class-end quiz for the release-flow test: an ENDED
// session marked with an e2e livekitRoom prefix + an Assessment(released=false).
const HELD_ROOM_PREFIX = 'e2e-held-';

async function seedHeld(courseId) {
  const questions = await prisma.assessmentQuestion.findMany({
    where: { courseId, active: true },
    select: { id: true },
    take: 5,
  });
  const session = await prisma.liveSession.create({
    data: {
      courseId,
      status: 'ENDED',
      endedAt: new Date(),
      scheduledAt: new Date(),
      livekitRoom: `${HELD_ROOM_PREFIX}${Date.now()}`,
    },
  });
  const assessment = await prisma.assessment.create({
    data: {
      courseId,
      sessionId: session.id,
      questionIds: questions.map((q) => q.id),
      released: false,
    },
  });
  process.stdout.write(
    JSON.stringify({ assessmentId: assessment.id, sessionId: session.id }),
  );
}

async function cleanupHeld() {
  const sessions = await prisma.liveSession.findMany({
    where: { livekitRoom: { startsWith: HELD_ROOM_PREFIX } },
    select: { id: true },
  });
  for (const s of sessions) {
    await prisma.assessmentAttempt.deleteMany({
      where: { assessment: { sessionId: s.id } },
    });
    await prisma.assessment.deleteMany({ where: { sessionId: s.id } });
    await prisma.liveSession.delete({ where: { id: s.id } });
  }
  console.error(`cleanup: removed ${sessions.length} e2e held quiz(zes)`);
}

// A throwaway LIVE session for the evict-on-end room test — never the shared
// board-test session, so ending it can't disturb other specs.
const LIVE_ROOM_PREFIX = 'e2e-live-';

async function setEvict(on) {
  const student = await prisma.user.findFirst({
    where: { email: STUDENT_EMAIL },
    select: { organizationId: true },
  });
  if (!student?.organizationId) throw new Error('test org not found');
  await prisma.organization.update({
    where: { id: student.organizationId },
    data: { evictOnInstructorLeave: on },
  });
  console.error(`evict-on-instructor-leave → ${on}`);
}

async function seedLive(courseId) {
  const session = await prisma.liveSession.create({
    data: {
      courseId,
      status: 'LIVE',
      scheduledAt: new Date(),
      startedAt: new Date(),
      livekitRoom: `${LIVE_ROOM_PREFIX}${Date.now()}`,
    },
  });
  process.stdout.write(JSON.stringify({ sessionId: session.id, courseId }));
}

async function cleanupLive() {
  const sessions = await prisma.liveSession.findMany({
    where: { livekitRoom: { startsWith: LIVE_ROOM_PREFIX } },
    select: { id: true },
  });
  for (const s of sessions) {
    await prisma.assessmentAttempt.deleteMany({
      where: { assessment: { sessionId: s.id } },
    });
    await prisma.assessment.deleteMany({ where: { sessionId: s.id } });
    await prisma.attendance.deleteMany({ where: { sessionId: s.id } });
    await prisma.chatMessage.deleteMany({ where: { sessionId: s.id } });
    await prisma.liveSession.delete({ where: { id: s.id } });
  }
  console.error(`cleanup: removed ${sessions.length} e2e live session(s)`);
}

/** Force org class-preferences to a known baseline (all off / lead 30). */
async function resetPrefs() {
  const student = await prisma.user.findFirst({
    where: { email: STUDENT_EMAIL },
    select: { organizationId: true },
  });
  if (student?.organizationId) {
    await prisma.organization.update({
      where: { id: student.organizationId },
      data: {
        evictOnInstructorLeave: false,
        micRequiresRaisedHand: false,
        preClassReminder: false,
        reminderLeadMinutes: 30,
      },
    });
  }
  console.error('reset: org class preferences → defaults');
}

const mode = process.argv[2];
const run =
  mode === '--cleanup'
    ? cleanup()
    : mode === '--seed-held'
      ? seedHeld(process.argv[3])
      : mode === '--cleanup-held'
        ? cleanupHeld()
        : mode === '--reset-prefs'
          ? resetPrefs()
          : mode === '--evict-on'
            ? setEvict(true)
            : mode === '--evict-off'
              ? setEvict(false)
              : mode === '--seed-live'
                ? seedLive(process.argv[3])
                : mode === '--cleanup-live'
                  ? cleanupLive()
                  : setup();
run
  .catch((e) => {
    console.error('helper error:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
