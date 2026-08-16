/**
 * Provisions data for a live test of the Code Instruction pack. Idempotent.
 *
 *   DATABASE_URL="mysql://root@localhost:3306/livetich_dev" \
 *     node scripts/code-test-setup.cjs
 *
 * Creates one org WITH the code-instruction pack (a live course + session,
 * verified instructor + enrolled verified student) and a second org WITHOUT
 * it (for the negative gate check). Prints the ids the smoke test reads.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function verifiedUser(email, name, role, orgId) {
  const passwordHash = bcrypt.hashSync('password123', 10);
  return prisma.user.upsert({
    where: { email },
    update: { organizationId: orgId, emailVerified: true, status: 'ACTIVE', role },
    create: { email, name, role, passwordHash, organizationId: orgId, emailVerified: true },
  });
}

async function liveCourseWithSession(title, instructorId, orgId, room) {
  let course = await prisma.course.findFirst({ where: { title, instructorId } });
  course = course
    ? await prisma.course.update({ where: { id: course.id }, data: { organizationId: orgId } })
    : await prisma.course.create({
        data: { title, description: `${title} — live test`, instructorId, organizationId: orgId },
      });
  const session = await prisma.liveSession.upsert({
    where: { livekitRoom: room },
    update: { status: 'LIVE', courseId: course.id, startedAt: new Date() },
    create: {
      courseId: course.id,
      status: 'LIVE',
      livekitRoom: room,
      scheduledAt: new Date(Date.now() - 10 * 60 * 1000),
      startedAt: new Date(),
    },
  });
  return { course, session };
}

async function main() {
  // --- Org WITH the code-instruction pack ---
  const codeOrg = await prisma.organization.upsert({
    where: { slug: 'code-academy-test' },
    update: {},
    create: { name: 'Code Academy (test)', slug: 'code-academy-test' },
  });
  for (const pluginKey of ['code-instruction', 'test-prep']) {
    await prisma.orgPlugin.upsert({
      where: { organizationId_pluginKey: { organizationId: codeOrg.id, pluginKey } },
      update: {},
      create: { organizationId: codeOrg.id, pluginKey },
    });
  }

  const codeInstr = await verifiedUser('instructor@livetich.dev', 'Ada Okoro', 'INSTRUCTOR', codeOrg.id);
  const codeStudent = await verifiedUser('seedstudent1@livetich.dev', 'Student 1', 'STUDENT', codeOrg.id);
  const { course: codeCourse, session: codeSession } = await liveCourseWithSession(
    'Rust Ownership & Borrowing', codeInstr.id, codeOrg.id, 'codetest-rust',
  );
  await prisma.enrollment.upsert({
    where: { courseId_studentId: { courseId: codeCourse.id, studentId: codeStudent.id } },
    update: {},
    create: { courseId: codeCourse.id, studentId: codeStudent.id },
  });

  // An assignment tied to the live session — this is what the VSCode extension
  // submits to (GET /assignments/mine → POST /assignments/:id/submissions).
  const codeTitle = 'Implement a Vec-backed stack';
  let codeAssignment = await prisma.assignment.findFirst({
    where: { title: codeTitle, courseId: codeCourse.id },
  });
  if (!codeAssignment) {
    codeAssignment = await prisma.assignment.create({
      data: {
        courseId: codeCourse.id,
        sessionId: codeSession.id,
        title: codeTitle,
        instructions: 'Write a generic stack backed by a Vec, with push/pop/peek. Submit the .rs file from the Livetich VSCode extension.',
        maxPoints: 100,
        createdById: codeInstr.id,
      },
    });
  }

  // --- Org WITHOUT the pack (negative gate) ---
  const plainOrg = await prisma.organization.upsert({
    where: { slug: 'plain-academy-test' },
    update: {},
    create: { name: 'Plain Academy (test)', slug: 'plain-academy-test' },
  });
  const plainInstr = await verifiedUser('grace@livetich.dev', 'Grace Adeyemi', 'INSTRUCTOR', plainOrg.id);
  const { course: plainCourse, session: plainSession } = await liveCourseWithSession(
    'System Design: Scaling to 1M Users', plainInstr.id, plainOrg.id, 'codetest-plain',
  );

  console.log(JSON.stringify({
    codeSessionId: codeSession.id,
    codeCourseId: codeCourse.id,
    codeAssignmentId: codeAssignment.id,
    plainSessionId: plainSession.id,
    plainCourseId: plainCourse.id,
    instructor: 'instructor@livetich.dev',
    student: 'seedstudent1@livetich.dev',
    plainInstructor: 'grace@livetich.dev',
    password: 'password123',
  }, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
