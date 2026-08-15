/**
 * Real-time submission flow smoke test. Requires the API on :3000 + Redis, and
 * `node scripts/code-test-setup.cjs` run first (pass its JSON on argv).
 *
 *   node scripts/submission-smoke.mjs '<setup-json>'
 *
 * Exercises: instructor creates a session-tied assignment, joins the room (and
 * thus the staff sub-room), a student submits code over HTTP, and the
 * instructor receives submission:new live — while a peer student does NOT.
 */
import { io } from 'socket.io-client';

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
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { _status: res.status, _text: text }; }
};

const login = async (email) =>
  (await req('POST', '/auth/login', null, { email, password: 'password123' })).accessToken;

const waitFor = (socket, event, pred = () => true, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.on(event, (payload) => {
      if (!pred(payload)) return;
      clearTimeout(timer);
      resolve(payload);
    });
  });

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(API, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const sid = setup.codeSessionId;
const [it, st] = await Promise.all([login(setup.instructor), login(setup.student)]);

// Session -> course id, then create a session-tied assignment.
const session = await req('GET', `/sessions/${sid}`, it);
const courseId = session.courseId;
const assignment = await req('POST', `/courses/${courseId}/assignments`, it, {
  title: 'Live: reverse a linked list',
  sessionId: sid,
});
check('instructor created a session-tied assignment', !!assignment.id, assignment.id ?? JSON.stringify(assignment));

// Instructor joins the room (and the staff sub-room).
const iSock = await connect(it);
iSock.emit('room:join', { sessionId: sid });
await new Promise((r) => setTimeout(r, 400));

// A peer student joins too — must NOT receive staff pushes.
const sSock = await connect(st);
sSock.emit('room:join', { sessionId: sid });
await new Promise((r) => setTimeout(r, 400));
let studentLeaked = false;
sSock.on('submission:new', () => { studentLeaked = true; });

// Student submits code over HTTP; instructor should get submission:new live.
const gotPush = waitFor(iSock, 'submission:new', (p) => p.assignmentId === assignment.id);
const submission = await req('POST', `/assignments/${assignment.id}/submissions`, st, {
  content: 'def reverse(head):\n    prev = None\n    while head:\n        head.next, prev, head = prev, head, head.next\n    return prev\n',
  language: 'python',
});
check('student submission accepted', !!submission.id, JSON.stringify(submission).slice(0, 80));

const push = await gotPush.catch((e) => ({ _err: e.message }));
check('instructor receives submission:new live', push.submissionId === submission.id, JSON.stringify(push).slice(0, 120));
check('push carries language + student name', push.language === 'python' && !!push.studentName, `lang=${push.language}, name=${push.studentName}`);

await new Promise((r) => setTimeout(r, 300));
check('peer student did NOT receive the staff push', studentLeaked === false);

// Tracking endpoint surfaces the code + language for the review UI.
const tracking = await req('GET', `/courses/${courseId}/assignments/tracking`, it);
const row = Array.isArray(tracking) ? tracking.find((a) => a.id === assignment.id) : null;
const sub = row?.submitted?.[0];
check('tracking returns code content + language', !!sub && sub.language === 'python' && sub.content.includes('reverse'), sub ? `lang=${sub.language}` : 'no submission');

for (const s of [iSock, sSock]) s.disconnect();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
