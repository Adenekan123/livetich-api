// Verifies (1) deleting a buzzer question that was answered in a live round, and
// (2) hard-deleting a program with data cascades everything. Uses a minted admin
// token; seeds throwaway data and asserts it's gone afterwards.
import { PrismaClient } from '@prisma/client';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const jwt = require(require.resolve('jsonwebtoken', { paths: [require.resolve('@nestjs/jwt')] }));
const apiRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const env = fs.readFileSync(path.join(apiRoot, '.env'), 'utf8');
const SECRET = env.match(/^JWT_SECRET=(.*)$/m)[1].trim().replace(/^["'](.*)["']$/, '$1');
const BASE = 'http://localhost:3000';
const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: 'ORG_ADMIN', organizationId: { not: null } } });
  const student = await prisma.user.findFirst({ where: { role: 'STUDENT', organizationId: admin.organizationId } });
  const orgId = admin.organizationId;
  const token = jwt.sign(
    { sub: admin.id, role: admin.role, name: admin.name, email: admin.email, organizationId: orgId, emailVerified: true, isSuperAdmin: false },
    SECRET, { expiresIn: '1h' },
  );
  const auth = { Authorization: `Bearer ${token}` };
  const results = [];

  // Pre-clean any leftovers from a previous failed run (uses the same cascade).
  const stale = await prisma.course.findMany({ where: { title: { startsWith: 'DEL ' } }, select: { id: true } });
  for (const s of stale) await fetch(`${BASE}/courses/${s.id}`, { method: 'DELETE', headers: auth }).catch(() => {});

  // ---------- (1) Buzzer question delete with an answer ----------
  const bcourse = await prisma.course.create({ data: { organizationId: orgId, instructorId: admin.id, title: 'DEL buzzer course' } });
  const quiz = await prisma.quiz.create({ data: { courseId: bcourse.id, type: 'BUZZER' } });
  const q = await prisma.quizQuestion.create({ data: { quizId: quiz.id, body: 'Q?', options: ['a', 'b'], correctIndex: 0 } });
  await prisma.quizAnswer.create({ data: { questionId: q.id, studentId: student.id, answerIndex: 0, isCorrect: true } });

  const delRes = await fetch(`${BASE}/quizzes/questions/${q.id}`, { method: 'DELETE', headers: auth });
  const gone = !(await prisma.quizQuestion.findUnique({ where: { id: q.id } }));
  const answersGone = (await prisma.quizAnswer.count({ where: { questionId: q.id } })) === 0;
  results.push(['buzzer question with an answer deletes (200)', delRes.status === 200]);
  results.push(['question + its answers are gone', gone && answersGone]);
  await prisma.course.delete({ where: { id: bcourse.id } }).catch(() => {});

  // ---------- (2) Delete program cascade ----------
  const course = await prisma.course.create({ data: { organizationId: orgId, instructorId: admin.id, title: 'DEL cascade program' } });
  const section = await prisma.section.create({ data: { courseId: course.id, order: 1, title: 'S1' } });
  await prisma.enrollment.create({ data: { courseId: course.id, studentId: student.id } });
  const session = await prisma.liveSession.create({ data: { courseId: course.id, status: 'ENDED', endedAt: new Date(), scheduledAt: new Date(), livekitRoom: `del-${Date.now()}` } });
  await prisma.attendance.create({ data: { sessionId: session.id, studentId: student.id } });
  await prisma.chatMessage.create({ data: { sessionId: session.id, userId: student.id, body: 'hi' } });
  const aq = await prisma.assessmentQuestion.create({ data: { courseId: course.id, sectionId: section.id, body: 'AQ', options: ['x', 'y'], correctIndex: 1, createdById: admin.id } });
  const assessment = await prisma.assessment.create({ data: { courseId: course.id, sessionId: session.id, questionIds: [aq.id] } });
  const attempt = await prisma.assessmentAttempt.create({ data: { assessmentId: assessment.id, studentId: student.id, score: 1, total: 1, submittedAt: new Date() } });
  await prisma.assessmentResponse.create({ data: { attemptId: attempt.id, questionId: aq.id, answerIndex: 1, isCorrect: true } });
  const cquiz = await prisma.quiz.create({ data: { courseId: course.id, type: 'BUZZER' } });
  const cq = await prisma.quizQuestion.create({ data: { quizId: cquiz.id, body: 'CQ', options: ['a', 'b'], correctIndex: 0 } });
  await prisma.quizAnswer.create({ data: { questionId: cq.id, studentId: student.id, answerIndex: 0, isCorrect: true } });
  const assignment = await prisma.assignment.create({ data: { courseId: course.id, title: 'A1', createdById: admin.id } });
  await prisma.submission.create({ data: { assignmentId: assignment.id, studentId: student.id } });
  await prisma.pointsLedger.create({ data: { courseId: course.id, studentId: student.id, delta: 5, reason: 'PARTICIPATION' } });
  await prisma.certificate.create({ data: { courseId: course.id, studentId: student.id, verificationCode: `DELCERT${Date.now()}`, issuedById: admin.id } });
  await prisma.sessionReminder.create({ data: { courseId: course.id, dateKey: '2099-01-01' } });

  const res = await fetch(`${BASE}/courses/${course.id}`, { method: 'DELETE', headers: auth });
  const body = res.ok ? null : await res.text();
  results.push([`DELETE /courses/:id → 200 (${res.status})`, res.ok]);
  if (body) console.log('  delete error body:', body);

  const courseGone = !(await prisma.course.findUnique({ where: { id: course.id } }));
  const leftovers =
    (await prisma.liveSession.count({ where: { courseId: course.id } })) +
    (await prisma.enrollment.count({ where: { courseId: course.id } })) +
    (await prisma.assessment.count({ where: { courseId: course.id } })) +
    (await prisma.assessmentAttempt.count({ where: { assessmentId: assessment.id } })) +
    (await prisma.quiz.count({ where: { courseId: course.id } })) +
    (await prisma.assignment.count({ where: { courseId: course.id } })) +
    (await prisma.attendance.count({ where: { sessionId: session.id } })) +
    (await prisma.certificate.count({ where: { courseId: course.id } })) +
    (await prisma.section.count({ where: { courseId: course.id } }));
  results.push(['course row gone', courseGone]);
  results.push(['no orphaned children left', leftovers === 0]);

  // Safety cleanup if the delete failed.
  if (!courseGone) await prisma.course.delete({ where: { id: course.id } }).catch(() => {});

  let ok = true;
  for (const [name, pass] of results) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); if (!pass) ok = false; }
  console.log(`\nRESULT: ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('ERROR', e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
