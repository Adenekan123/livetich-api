/**
 * Test Prep (exam) smoke test. Requires the API on :3000, and
 * `node scripts/code-test-setup.cjs` run first (pass its JSON on argv).
 *
 *   node scripts/exam-smoke.mjs '<setup-json>'
 *
 * code-academy org has the test-prep pack; plain-academy does not. Exercises:
 * instructor authors a timed exam, student lists + sits + submits (auto-score),
 * answers are hidden from the student, manager sees results + per-topic
 * analytics, and an org WITHOUT the pack is 403 on every exam route.
 */
const API = 'http://localhost:3000';
const setup = JSON.parse(process.argv[2] ?? process.env.SETUP ?? '{}');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const req = async (method, path, token, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _text: text }; }
  return { status: res.status, body: json };
};
const login = async (email) =>
  (await req('POST', '/auth/login', null, { email, password: 'password123' })).body.accessToken;

const it = await login(setup.instructor);
const st = await login(setup.student);
const plain = await login(setup.plainInstructor);
const course = setup.codeCourseId;

// Instructor authors a timed exam.
const created = await req('POST', `/courses/${course}/exams`, it, {
  title: 'JAMB Mock — Mathematics',
  durationMinutes: 30,
  questions: [
    { body: '2 + 2 = ?', options: ['3', '4', '5'], correctIndex: 1, topic: 'Arithmetic' },
    { body: 'Solve x: x + 3 = 10', options: ['5', '6', '7'], correctIndex: 2, topic: 'Algebra' },
    { body: 'Area of a 3x4 rectangle?', options: ['7', '12', '14'], correctIndex: 1, topic: 'Geometry' },
  ],
});
check('instructor created an exam', created.status === 201 && !!created.body.id, JSON.stringify(created.body).slice(0, 80));
const examId = created.body.id;

// Student lists available exams.
const avail = await req('GET', `/courses/${course}/exams/available`, st);
const row = Array.isArray(avail.body) ? avail.body.find((e) => e.id === examId) : null;
check('student sees the exam with question count', !!row && row.questionCount === 3, row ? `q=${row.questionCount}` : 'not found');

// Student starts an attempt; answers must NOT be exposed.
const start = await req('POST', `/exams/${examId}/attempts`, st);
const q = start.body.questions ?? [];
const leaked = q.some((x) => 'correctIndex' in x);
check('start returns questions without correctIndex', start.status === 200 && q.length === 3 && !leaked, `n=${q.length}, leaked=${leaked}`);
check('start returns a deadline', !!start.body.deadline, start.body.deadline);

// Student submits 2/3 correct → expect 67.
const submit = await req('POST', `/attempts/${start.body.attemptId}/submit`, st, {
  answers: [
    { questionId: q[0].id, chosenIndex: 1 }, // correct
    { questionId: q[1].id, chosenIndex: 2 }, // correct
    { questionId: q[2].id, chosenIndex: 0 }, // wrong
  ],
});
check('submit auto-scores (2/3 → 67)', submit.status === 200 && submit.body.score === 67 && submit.body.correct === 2, JSON.stringify(submit.body));

// Re-submitting the same attempt is rejected.
const resub = await req('POST', `/attempts/${start.body.attemptId}/submit`, st, { answers: [] });
check('re-submit rejected', resub.status === 400, `HTTP ${resub.status}`);

// Manager results + per-topic analytics.
const res = await req('GET', `/exams/${examId}/results`, it);
const topics = res.body.topics ?? [];
const arith = topics.find((t) => t.topic === 'Arithmetic');
const geo = topics.find((t) => t.topic === 'Geometry');
check('results list the student score', (res.body.students ?? []).some((s) => s.score === 67));
check('per-topic analytics computed', arith?.accuracy === 100 && geo?.accuracy === 0, `arith=${arith?.accuracy}, geo=${geo?.accuracy}`);

// A student cannot read the manager results endpoint for a course they manage-not.
const studentResults = await req('GET', `/exams/${examId}/results`, st);
check('student blocked from manager results', studentResults.status === 403 || studentResults.status === 404, `HTTP ${studentResults.status}`);

// Negative gate: plain-academy org has no test-prep pack → 403 everywhere.
const gateCreate = await req('POST', `/courses/${setup.plainCourseId}/exams`, plain, {
  title: 'x', durationMinutes: 10, questions: [{ body: 'q', options: ['a', 'b'], correctIndex: 0 }],
});
check('org without pack is 403 on create', gateCreate.status === 403, `HTTP ${gateCreate.status}`);
const gateList = await req('GET', `/courses/${setup.plainCourseId}/exams`, plain);
check('org without pack is 403 on list', gateList.status === 403, `HTTP ${gateList.status}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
