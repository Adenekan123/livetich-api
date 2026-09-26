/**
 * Provisions a self-contained workspace for manual testing: one admin, one
 * instructor, two students, a program with a daily-meeting batch, and both
 * kinds of join link. Idempotent — re-run it whenever the state gets messy.
 *
 *   DATABASE_URL="mysql://root@localhost:3306/livetich_dev" \
 *     node scripts/qa-test-setup.cjs
 *
 * Everybody gets the same password so nothing has to be remembered per account;
 * the batch meets every day of the week so Join is never gated on the calendar.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const PASSWORD = 'Test1234!';
const ORG_SLUG = 'livetich-qa';
const COURSE_INVITE = 'qa-course-invite';
const WORKSPACE_INVITE = 'qa-workspace-invite';

async function member(email, name, role, orgId) {
  const passwordHash = bcrypt.hashSync(PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { name, role, passwordHash, organizationId: orgId, emailVerified: true, status: 'ACTIVE' },
    create: { email, name, role, passwordHash, organizationId: orgId, emailVerified: true },
  });
  await prisma.membership.upsert({
    where: { userId_organizationId: { userId: user.id, organizationId: orgId } },
    update: { role, status: 'ACTIVE' },
    create: { userId: user.id, organizationId: orgId, role, status: 'ACTIVE' },
  });
  return user;
}

async function course(data) {
  const existing = await prisma.course.findFirst({
    where: { title: data.title, organizationId: data.organizationId },
  });
  return existing
    ? prisma.course.update({ where: { id: existing.id }, data })
    : prisma.course.create({ data });
}

async function main() {
  const org = await prisma.organization.upsert({
    where: { slug: ORG_SLUG },
    update: {},
    create: {
      name: 'Livetich QA',
      slug: ORG_SLUG,
      tagline: 'Manual test workspace',
      primaryColor: '#2563eb',
      accentColor: '#f59e0b',
    },
  });

  // Every add-on on, so no surface is hidden behind a pack gate during a test.
  for (const pluginKey of ['islamic-education', 'code-instruction', 'maths-sciences', 'test-prep']) {
    await prisma.orgPlugin.upsert({
      where: { organizationId_pluginKey: { organizationId: org.id, pluginKey } },
      update: {},
      create: { organizationId: org.id, pluginKey },
    });
  }

  const admin = await member('qa.admin@livetich.test', 'QA Admin', 'ORG_ADMIN', org.id);
  const instructor = await member('qa.instructor@livetich.test', 'QA Instructor', 'INSTRUCTOR', org.id);
  const student = await member('qa.student@livetich.test', 'QA Student', 'STUDENT', org.id);
  // Deliberately in the workspace but enrolled in nothing — this is the account
  // that proves a course-scoped link enrols an existing member.
  const outsider = await member('qa.student2@livetich.test', 'QA Student Two', 'STUDENT', org.id);

  const program = await course({
    organizationId: org.id,
    title: 'QA Frontend Development',
    description: 'Program used for manual testing.',
    category: 'Software Engineering',
    level: 'Beginner',
    code: 'QAFE',
    instructorId: instructor.id,
  });

  // Meets every day, from 08:00, for twelve weeks starting a week ago: today is
  // always a meeting day, so the Join button is always live.
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const batch = await course({
    organizationId: org.id,
    parentCourseId: program.id,
    title: 'QA Cohort',
    description: 'Batch used for manual testing — meets daily.',
    code: 'QA1',
    instructorId: instructor.id,
    category: 'Software Engineering',
    level: 'Beginner',
    startDate: weekAgo,
    durationWeeks: 12,
    meetingDays: [0, 1, 2, 3, 4, 5, 6],
    meetingTime: '08:00',
    timezone: 'Africa/Lagos',
    scheduleUpdatedAt: new Date(),
  });

  await prisma.enrollment.upsert({
    where: { courseId_studentId: { courseId: batch.id, studentId: student.id } },
    update: {},
    create: { courseId: batch.id, studentId: student.id },
  });

  const invite = async (token, label, courseId) =>
    prisma.invite.upsert({
      where: { token },
      update: { revokedAt: null, expiresAt: null, maxUses: null, courseId, organizationId: org.id },
      create: {
        token, label, courseId, organizationId: org.id,
        role: 'STUDENT', createdById: admin.id,
      },
    });
  await invite(COURSE_INVITE, 'QA cohort link', batch.id);
  await invite(WORKSPACE_INVITE, 'QA workspace link', null);

  console.log(JSON.stringify({
    password: PASSWORD,
    organization: { name: org.name, slug: org.slug, id: org.id },
    accounts: {
      admin: admin.email,
      instructor: instructor.email,
      student: student.email,
      studentNotEnrolled: outsider.email,
    },
    programId: program.id,
    batchId: batch.id,
    joinLinks: {
      cohort: `/join/${COURSE_INVITE}`,
      workspace: `/join/${WORKSPACE_INVITE}`,
    },
  }, null, 2));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
