// Socket-level check of the "mic requires a raised hand" org preference.
// Seeds a live session, connects instructor + student, and exercises the grant
// gate + auto-revoke-on-lower. Prints PASS/FAIL. Cleans up after itself.
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jwt = require(
  require.resolve('jsonwebtoken', { paths: [require.resolve('@nestjs/jwt')] }),
);
const { io } = require(require.resolve('socket.io-client'));

const apiRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const env = fs.readFileSync(path.join(apiRoot, '.env'), 'utf8');
const SECRET = env.match(/^JWT_SECRET=(.*)$/m)[1].trim().replace(/^["'](.*)["']$/, '$1');
const BASE = 'http://localhost:3000';
const prisma = new PrismaClient();

const mint = (u) =>
  jwt.sign(
    { sub: u.id, role: u.role, name: u.name, email: u.email, organizationId: u.organizationId, emailVerified: true, isSuperAdmin: false },
    SECRET,
    { expiresIn: '1h' },
  );

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(token, sessionId) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  const speakers = { current: [] };
  const errors = [];
  s.on('mic:speakers', (p) => { if (p.sessionId === sessionId) speakers.current = p.userIds; });
  s.on('error', (e) => errors.push(e));
  return { s, speakers, errors };
}

async function main() {
  const student = await prisma.user.findFirst({ where: { email: 'eames.rashed@forliion.com' } });
  const instructor = await prisma.user.findFirst({ where: { email: 'jeyson.umer@forliion.com' } });
  // A course the instructor owns and the student is enrolled in.
  const enrollment = await prisma.enrollment.findFirst({
    where: { studentId: student.id, course: { instructorId: instructor.id } },
    select: { courseId: true },
  });
  if (!enrollment) throw new Error('no shared course for instructor+student');
  const courseId = enrollment.courseId;

  // Turn the pref ON for the org.
  await prisma.organization.update({ where: { id: instructor.organizationId }, data: { micRequiresRaisedHand: true } });

  const session = await prisma.liveSession.create({
    data: { courseId, status: 'LIVE', scheduledAt: new Date(), startedAt: new Date(), livekitRoom: `e2e-mic-${Date.now()}` },
  });

  const teacher = connect(mint(instructor), session.id);
  const learner = connect(mint(student), session.id);
  await wait(500);
  teacher.s.emit('room:join', { sessionId: session.id });
  learner.s.emit('room:join', { sessionId: session.id });
  await wait(1200);

  const results = [];

  // 1) Grant with NO raised hand → must be refused; student not a speaker.
  teacher.errors.length = 0;
  teacher.s.emit('mic:grant', { sessionId: session.id, userId: student.id });
  await wait(800);
  const refused = teacher.errors.some((e) => e.code === 'MIC_NEEDS_HAND');
  const notSpeaking = !learner.speakers.current.includes(student.id);
  results.push(['grant blocked without raised hand', refused && notSpeaking]);

  // 2) Raise hand, then grant → student becomes a speaker.
  learner.s.emit('hand:raise', { sessionId: session.id });
  await wait(600);
  teacher.s.emit('mic:grant', { sessionId: session.id, userId: student.id });
  await wait(800);
  results.push(['grant works after raising hand', learner.speakers.current.includes(student.id)]);

  // 3) Lower hand → mic auto-revoked.
  learner.s.emit('hand:lower', { sessionId: session.id });
  await wait(800);
  results.push(['mic auto-revoked when hand lowered', !learner.speakers.current.includes(student.id)]);

  teacher.s.close();
  learner.s.close();

  // Cleanup.
  await prisma.assessment.deleteMany({ where: { sessionId: session.id } });
  await prisma.liveSession.delete({ where: { id: session.id } });
  await prisma.organization.update({ where: { id: instructor.organizationId }, data: { micRequiresRaisedHand: false } });

  let ok = true;
  for (const [name, pass] of results) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) ok = false;
  }
  console.log(`\nRESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('ERROR', e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
