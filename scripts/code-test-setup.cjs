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
  await prisma.orgPlugin.upsert({
    where: { organizationId_pluginKey: { organizationId: codeOrg.id, pluginKey: 'code-instruction' } },
    update: {},
    create: { organizationId: codeOrg.id, pluginKey: 'code-instruction' },
  });

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

  // --- Org WITHOUT the pack (negative gate) ---
  const plainOrg = await prisma.organization.upsert({
    where: { slug: 'plain-academy-test' },
    update: {},
    create: { name: 'Plain Academy (test)', slug: 'plain-academy-test' },
  });
  const plainInstr = await verifiedUser('grace@livetich.dev', 'Grace Adeyemi', 'INSTRUCTOR', plainOrg.id);
  const { session: plainSession } = await liveCourseWithSession(
    'System Design: Scaling to 1M Users', plainInstr.id, plainOrg.id, 'codetest-plain',
  );

  console.log(JSON.stringify({
    codeSessionId: codeSession.id,
    plainSessionId: plainSession.id,
    instructor: 'instructor@livetich.dev',
    student: 'seedstudent1@livetich.dev',
    plainInstructor: 'grace@livetich.dev',
  }, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
