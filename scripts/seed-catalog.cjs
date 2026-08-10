/**
 * Seeds a browsable catalog for the courses page: a few instructors, some
 * students (for realistic enrollment counts), and ~14 courses each with one
 * live or upcoming session. Idempotent — safe to run repeatedly (upserts on
 * unique keys; re-running refreshes each session's live/upcoming state).
 *
 * Run:  DATABASE_URL="mysql://root@localhost:3306/livetich_dev" \
 *         node scripts/seed-catalog.cjs
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();
const H = 3600 * 1000;
const MIN = 60 * 1000;

const INSTRUCTORS = [
  ['ada', 'Ada Okoro', 'instructor@livetich.dev'],
  ['grace', 'Grace Adeyemi', 'grace@livetich.dev'],
  ['kai', 'Kai Mensah', 'kai@livetich.dev'],
];

// live: currently LIVE. inH: hours from now for upcoming (SCHEDULED).
const COURSES = [
  { t: 'System Design: Scaling to 1M Users', by: 'grace', live: true,
    d: 'Load balancers, caching layers, sharding and back-pressure — designed live on the board with the whole room.' },
  { t: 'Figma Auto Layout, Live', by: 'kai', live: true,
    d: 'Build a responsive component set from scratch and watch every constraint resolve in real time.' },
  { t: 'Rust Ownership & Borrowing', by: 'ada', live: true,
    d: 'The borrow checker, demystified. Move semantics, lifetimes and when to reach for a clone.' },
  { t: 'Jazz Piano: Reharmonization', by: 'kai', live: true,
    d: 'Take a plain lead sheet and reharmonize it live — tritone subs, modal interchange, the works.' },
  { t: 'Financial Modeling in Excel', by: 'grace', live: true,
    d: 'A three-statement model built cell by cell, with a buzzer round on every formula.' },

  { t: 'Intro to Kubernetes', by: 'ada', inH: 3,
    d: 'Pods, deployments and services without the fear. Deploy a real app to a live cluster together.' },
  { t: 'Design Systems from Scratch', by: 'kai', inH: 6,
    d: 'Tokens, primitives and components — the architecture that keeps a product consistent at scale.' },
  { t: 'TypeScript for Teams', by: 'grace', inH: 24,
    d: 'Generics, discriminated unions and the type-level tricks that make a large codebase safe to refactor.' },
  { t: 'Watercolor Fundamentals', by: 'kai', inH: 26,
    d: 'Washes, wet-on-wet and controlled bleeds. Paint one small landscape alongside the class.' },
  { t: 'Data Visualization with D3', by: 'ada', inH: 48,
    d: 'Scales, axes and joins — build an interactive chart that updates as the data streams in.' },
  { t: 'French Conversation, A2', by: 'grace', inH: 52,
    d: 'A full hour of spoken French. Raise your hand, take the mic, and get corrected on the spot.' },
  { t: 'Ceramics: Wheel Throwing', by: 'kai', inH: 72,
    d: 'Centering, opening and pulling walls. Throw your first cylinder with live over-the-shoulder guidance.' },
  { t: 'Product Analytics 101', by: 'ada', inH: 96,
    d: 'Funnels, retention curves and the metrics that actually move a product. No vanity numbers.' },
  { t: 'Public Speaking Live Lab', by: 'grace', inH: 120,
    d: 'Deliver a two-minute talk to the room and get real-time feedback from peers and the leaderboard.' },
];

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  const hash = bcrypt.hashSync('password123', 10);

  const instructors = {};
  for (const [key, name, email] of INSTRUCTORS) {
    instructors[key] = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { role: 'INSTRUCTOR', name, email, passwordHash: hash },
    });
  }

  const students = [];
  for (let i = 1; i <= 8; i++) {
    students.push(
      await prisma.user.upsert({
        where: { email: `seedstudent${i}@livetich.dev` },
        update: {},
        create: {
          role: 'STUDENT',
          name: `Student ${i}`,
          email: `seedstudent${i}@livetich.dev`,
          passwordHash: hash,
        },
      }),
    );
  }

  const now = Date.now();
  let live = 0;
  let upcoming = 0;

  for (const c of COURSES) {
    const instr = instructors[c.by];
    let course = await prisma.course.findFirst({
      where: { title: c.t, instructorId: instr.id },
    });
    if (!course) {
      course = await prisma.course.create({
        data: { title: c.t, description: c.d, instructorId: instr.id },
      });
    } else {
      course = await prisma.course.update({
        where: { id: course.id },
        data: { description: c.d },
      });
    }

    // Deterministic grayscale poster per course (same formula the web derives).
    const posterUrl = `https://picsum.photos/seed/lt-${slugify(c.t)}/800/1000`;
    await prisma.$executeRawUnsafe(
      'UPDATE `Course` SET `posterUrl` = ? WHERE `id` = ?',
      posterUrl,
      course.id,
    );

    const room = `seed-${slugify(c.t)}`;
    const status = c.live ? 'LIVE' : 'SCHEDULED';
    const scheduledAt = c.live
      ? new Date(now - 20 * MIN)
      : new Date(now + (c.inH ?? 3) * H);
    const startedAt = c.live ? new Date(now - 12 * MIN) : null;

    await prisma.liveSession.upsert({
      where: { livekitRoom: room },
      update: { status, scheduledAt, startedAt, courseId: course.id },
      create: {
        courseId: course.id,
        status,
        scheduledAt,
        startedAt,
        livekitRoom: room,
      },
    });
    c.live ? live++ : upcoming++;

    // Varied, deterministic enrollment counts so tiles differ.
    const k = (slugify(c.t).length * 7) % (students.length + 1);
    for (let j = 0; j < k; j++) {
      await prisma.enrollment.upsert({
        where: {
          courseId_studentId: { courseId: course.id, studentId: students[j].id },
        },
        update: {},
        create: { courseId: course.id, studentId: students[j].id },
      });
    }
  }

  console.log(
    `Seed complete: ${COURSES.length} courses, ${live} live + ${upcoming} upcoming sessions, ${students.length} students.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
