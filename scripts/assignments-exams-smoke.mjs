/**
 * End-to-end smoke test of the assignments and exams flows, over real HTTP.
 *
 *   node scripts/assignments-exams-smoke.mjs "$(node scripts/code-test-setup.cjs)"
 *
 * Requires the API on :3000. Everything runs inside the two throwaway orgs
 * code-test-setup.cjs provisions, so it never touches real workspace data.
 *
 * Covers, for both surfaces: the full lifecycle (author -> student sees ->
 * submits -> manager marks -> student sees the mark), org isolation, role
 * separation, and the three things worth being paranoid about — that a grade
 * cannot exceed the assignment's own maxPoints (it is worth leaderboard
 * points), that an exam's answer key never ships with the attempt, and that an
 * exam is one sitting per student while a dropped connection still resumes.
 */
const API = 'http://localhost:3000';
const setup = JSON.parse(process.argv[2] ?? '{}');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function req(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, body: json, raw: text };
}

const login = async (email) => {
  const r = await req('POST', '/auth/login', null, { email, password: 'password123' });
  if (!r.body?.accessToken) throw new Error(`login failed for ${email}: ${r.status} ${r.raw}`);
  return r.body.accessToken;
};

const [IT, ST, OTHER] = await Promise.all([
  login(setup.instructor),
  login(setup.student),
  login(setup.plainInstructor),
]);
const course = setup.codeCourseId;

console.log('\n=== ASSIGNMENTS ===');

const dueAt = new Date(Date.now() + 7 * 864e5).toISOString();
const mk = await req('POST', `/courses/${course}/assignments`, IT, {
  title: 'E2E: essay on ownership',
  instructions: 'Explain move semantics in your own words.',
  dueAt,
  maxPoints: 100,
});
check('instructor creates an assignment', mk.status === 201 && !!mk.body?.id, `status ${mk.status}`);
const aId = mk.body?.id;

const list = await req('GET', `/courses/${course}/assignments`, IT);
check(
  'appears in the course list',
  Array.isArray(list.body) && list.body.some((a) => a.id === aId),
  `status ${list.status}`,
);

const mine = await req('GET', '/assignments/mine', ST);
const mineRow = Array.isArray(mine.body) ? mine.body.find((a) => a.id === aId) : null;
check('student sees it under /assignments/mine', !!mineRow, `status ${mine.status}`);

const foreign = await req('GET', `/courses/${course}/assignments`, OTHER);
check(
  'another org cannot list it',
  foreign.status === 403 || foreign.status === 404,
  `status ${foreign.status}`,
);

const sub = await req('POST', `/assignments/${aId}/submissions`, ST, {
  content: 'Ownership means each value has exactly one owner...',
});
check(
  'student submits',
  (sub.status === 201 || sub.status === 200) && !!sub.body?.id,
  `status ${sub.status}`,
);
const subId = sub.body?.id;

const subs = await req('GET', `/assignments/${aId}/submissions`, IT);
const subsArr = Array.isArray(subs.body) ? subs.body : (subs.body?.submissions ?? []);
check(
  'instructor sees the submission',
  subsArr.some((s) => s.id === subId),
  `status ${subs.status}`,
);

const badGrade = await req('PATCH', `/submissions/${subId}`, ST, { grade: 100 });
check('student cannot grade their own work', badGrade.status === 403, `status ${badGrade.status}`);

const graded = await req('PATCH', `/submissions/${subId}`, IT, {
  grade: 85,
  feedback: 'Clear, but say more about borrowing.',
});
check(
  'instructor grades it',
  graded.status === 200 && graded.body?.grade === 85,
  `status ${graded.status} grade ${graded.body?.grade}`,
);

const stList = await req('GET', `/courses/${course}/assignments`, ST);
const after = Array.isArray(stList.body) ? stList.body.find((a) => a.id === aId) : null;
check('student sees the grade', after?.mySubmission?.grade === 85,
  `saw ${JSON.stringify(after?.mySubmission?.grade)}`);
check('student sees the feedback',
  typeof after?.mySubmission?.feedback === 'string' && after.mySubmission.feedback.length > 0,
  `saw ${JSON.stringify(after?.mySubmission?.feedback)}`);
check('the manager-only submission count is hidden from the student',
  after !== null && !('submissionCount' in after) && !('_count' in after));

const neg = await req('PATCH', `/submissions/${subId}`, IT, { grade: -1 });
check('a negative grade is rejected', neg.status === 400, `status ${neg.status}`);

// The ceiling is the assignment's own maxPoints, not a constant: a grade is
// worth leaderboard points, so an out-of-range one outranks the whole class.
const over = await req('PATCH', `/submissions/${subId}`, IT, { grade: 5000 });
check('a grade far above maxPoints is rejected', over.status === 400,
  `status ${over.status} -> ${JSON.stringify(over.body)?.slice(0, 140)}`);

const justOver = await req('PATCH', `/submissions/${subId}`, IT, { grade: 101 });
check('one point above maxPoints is rejected', justOver.status === 400,
  `status ${justOver.status}`);

const full = await req('PATCH', `/submissions/${subId}`, IT, { grade: 100 });
check('full marks (exactly maxPoints) is accepted',
  full.status === 200 && full.body?.grade === 100, `status ${full.status}`);

// Leave the submission on a sane grade for whatever reads it next.
await req('PATCH', `/submissions/${subId}`, IT, { grade: 85, feedback: 'Clear, but say more about borrowing.' });

const track = await req('GET', `/courses/${course}/assignments/tracking`, IT);
check('tracking endpoint answers', track.status === 200, `status ${track.status}`);

console.log('\n=== EXAMS ===');

const questions = [
  { body: '2 + 2 = ?', options: ['3', '4', '5'], correctIndex: 1, topic: 'maths' },
  { body: 'Capital of Nigeria?', options: ['Lagos', 'Abuja'], correctIndex: 1, topic: 'geography' },
  { body: 'Rust keyword for a constant?', options: ['let', 'const', 'var'], correctIndex: 1 },
];

const ex = await req('POST', `/courses/${course}/exams`, IT, {
  title: 'E2E: quick check',
  durationMinutes: 30,
  questions,
});
check('instructor creates an exam', ex.status === 201 && !!ex.body?.id, `status ${ex.status}`);
const exId = ex.body?.id;

const stMk = await req('POST', `/courses/${course}/exams`, ST, {
  title: 'nope',
  durationMinutes: 5,
  questions,
});
check('student cannot author an exam', stMk.status === 403, `status ${stMk.status}`);

const empty = await req('POST', `/courses/${course}/exams`, IT, {
  title: 'empty',
  durationMinutes: 5,
  questions: [],
});
check('an exam with no questions is rejected', empty.status === 400, `status ${empty.status}`);

const avail = await req('GET', `/courses/${course}/exams/available`, ST);
const availArr = Array.isArray(avail.body) ? avail.body : (avail.body?.exams ?? []);
check(
  'student sees it as available',
  availArr.some((e) => e.id === exId),
  `status ${avail.status}`,
);

const att = await req('POST', `/exams/${exId}/attempts`, ST);
const attId = att.body?.attemptId ?? att.body?.id;
check('student starts an attempt', att.status === 200 && !!attId, `status ${att.status}`);

const leaked = JSON.stringify(att.body ?? {}).includes('correctIndex');
check(
  'the answer key is NOT sent with the attempt',
  !leaked,
  leaked ? 'correctIndex present in the attempt payload' : '',
);

const qs = att.body?.questions ?? att.body?.exam?.questions ?? [];
check('the attempt carries the questions', qs.length === 3, `got ${qs.length}`);

// Two right, one wrong: index 1 is correct for all three.
const answers = qs.map((q, i) => ({ questionId: q.id, chosenIndex: i === 2 ? 0 : 1 }));
const done = await req('POST', `/attempts/${attId}/submit`, ST, { answers });
check('student submits the attempt', done.status === 200, `status ${done.status}`);
// `score` is a percentage; `correct`/`total` are the raw counts.
const b = done.body ?? {};
check('marked 2 of 3 correct', b.correct === 2 && b.total === 3,
  `correct ${b.correct} total ${b.total}`);
check('score is the right percentage', b.score === 67, `score ${b.score}`);
check('all three answers were recorded', b.answered === 3, `answered ${b.answered}`);
check('the attempt was not marked expired', b.expired === false, `expired ${b.expired}`);

const rev = await req('GET', `/exams/${exId}/review`, ST);
check('review is available after submitting', rev.status === 200, `status ${rev.status}`);

const res = await req('GET', `/exams/${exId}/results`, IT);
const resArr = res.body?.students ?? [];
check('instructor sees the student result', res.status === 200 && resArr.length > 0,
  `status ${res.status} rows ${resArr.length}`);
check('the result carries a per-topic breakdown',
  Array.isArray(res.body?.topics) ? res.body.topics.length > 0 : !!res.body?.topics,
  JSON.stringify(res.body?.topics)?.slice(0, 120));

const foreignRes = await req('GET', `/exams/${exId}/results`, OTHER);
check(
  'another org cannot read results',
  foreignRes.status === 403 || foreignRes.status === 404,
  `status ${foreignRes.status}`,
);

// One sitting each: a student who has submitted cannot start again.
const again = await req('POST', `/exams/${exId}/attempts`, ST);
check('a second sitting is refused', again.status === 409,
  `status ${again.status} -> ${JSON.stringify(again.body)?.slice(0, 140)}`);

// ...but resuming an unsubmitted attempt is not a second sitting. A student
// whose tab died must get the same attempt back, on the original clock.
const ex2 = await req('POST', `/courses/${course}/exams`, IT, {
  title: 'E2E: resume check', durationMinutes: 30, questions,
});
const openA = await req('POST', `/exams/${ex2.body?.id}/attempts`, ST);
const openB = await req('POST', `/exams/${ex2.body?.id}/attempts`, ST);
check('an unsubmitted attempt resumes rather than restarting',
  openB.status === 200 && openB.body?.attemptId === openA.body?.attemptId,
  `${openA.body?.attemptId} vs ${openB.body?.attemptId}`);
check('resuming keeps the original deadline',
  openB.body?.deadline === openA.body?.deadline,
  `${openA.body?.deadline} vs ${openB.body?.deadline}`);
await req('DELETE', `/courses/${course}/exams/${ex2.body?.id}`, IT);

const upd = await req('PATCH', `/courses/${course}/exams/${exId}`, IT, { title: 'E2E: renamed' });
check('instructor edits the exam', upd.status === 200, `status ${upd.status}`);

const del = await req('DELETE', `/courses/${course}/exams/${exId}`, IT);
check(
  'instructor deletes the exam',
  del.status === 200 || del.status === 204,
  `status ${del.status}`,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
