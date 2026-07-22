/**
 * Realtime gateway smoke test. Requires the API running on :3000 with Redis.
 *
 *   node scripts/gateway-smoke.mjs
 *
 * Exercises: join/presence, chat + lock, hands, random pick, and the full
 * buzzer round (wrong answer -> correct answer wins -> points + leaderboard).
 */
import { io } from 'socket.io-client';

const API = 'http://localhost:3000';
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
  return res.json();
};

const login = async (email) =>
  (await req('POST', '/auth/login', null, { email, password: 'password123' }))
    .accessToken;

const waitFor = (socket, event, pred = () => true, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${event}`)),
      ms,
    );
    const handler = (payload) => {
      if (!pred(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(API, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

// ---------- Setup via REST ----------

const [it, st, s2] = await Promise.all([
  login('instructor@livetich.dev'),
  login('student@livetich.dev'),
  login('student2@livetich.dev'),
]);
const courses = await req('GET', '/courses', it);
const courseId = courses[0].id;

// Fresh session for a clean room
const session = await req('POST', '/sessions', it, {
  courseId,
  scheduledAt: new Date().toISOString(),
});
await req('POST', `/sessions/${session.id}/start`, it);
const sid = session.id;

// Buzzer quiz attached to this session (short timer for the timeout test)
const quiz = await req('POST', '/quizzes', it, {
  sessionId: sid,
  type: 'BUZZER',
  questions: [
    {
      body: 'Which pattern forwards streams once to many subscribers?',
      options: ['Mesh', 'SFU', 'MCU'],
      correctIndex: 1,
      timeLimitSec: 30,
    },
    {
      body: 'Timeout test question',
      options: ['a', 'b'],
      correctIndex: 0,
      timeLimitSec: 5,
    },
  ],
});
const [q1, q2] = quiz.questions.map((q) => q.id);

// ---------- Connect sockets ----------

const [iSock, sSock, s2Sock] = await Promise.all(
  [it, st, s2].map(connect),
);
check('sockets connected', true);

// join: instructor + both students
const presence3 = waitFor(iSock, 'room:presence', (p) => p.users.length === 3);
iSock.emit('room:join', { sessionId: sid });
sSock.emit('room:join', { sessionId: sid });
s2Sock.emit('room:join', { sessionId: sid });
const pres = await presence3;
check('presence shows 3 users', pres.users.length === 3,
  pres.users.map((u) => u.name).join(', '));

// chat broadcast
const chatSeen = waitFor(s2Sock, 'chat:message');
sSock.emit('chat:send', { sessionId: sid, body: 'hello class' });
const msg = await chatSeen;
check('chat broadcast reaches others', msg.body === 'hello class', msg.user.name);

// chat lock: instructor locks, student blocked, instructor can still talk
const lockSeen = waitFor(sSock, 'chat:locked', (p) => p.locked === true);
iSock.emit('chat:lock', { sessionId: sid, locked: true });
await lockSeen;
const blocked = waitFor(sSock, 'error', (e) => e.code === 'CHAT_LOCKED');
sSock.emit('chat:send', { sessionId: sid, body: 'am I muted?' });
await blocked;
check('locked chat blocks student', true);
const instructorMsg = waitFor(sSock, 'chat:message');
iSock.emit('chat:send', { sessionId: sid, body: 'quiet please' });
check('instructor can chat while locked', (await instructorMsg).body === 'quiet please');
iSock.emit('chat:lock', { sessionId: sid, locked: false });

// hands
const hands2 = waitFor(iSock, 'hands:update', (p) => p.raised.length === 2);
sSock.emit('hand:raise', { sessionId: sid });
s2Sock.emit('hand:raise', { sessionId: sid });
const hands = await hands2;
check('two hands raised', hands.raised.length === 2);

// random pick
const picked = waitFor(iSock, 'student:picked');
iSock.emit('student:pick-random', { sessionId: sid });
check('random pick returns a raised hand', Boolean((await picked).user.userId));

// buzzer: student without hand is not eligible — lower s... both raised. Start round.
const buzzerOpen = waitFor(sSock, 'buzzer:state', (p) => p.state.phase === 'QUESTION_OPEN');
iSock.emit('buzzer:start', { sessionId: sid, questionId: q1 });
const open = await buzzerOpen;
check('buzzer opens with 2 eligible', open.state.eligibleUserIds.length === 2);

// student1 answers wrong
const wrong = waitFor(sSock, 'quiz:answer-result');
sSock.emit('quiz:answer', { sessionId: sid, questionId: q1, answerIndex: 0 });
check('wrong answer reported privately', (await wrong).isCorrect === false);

// student1 tries again -> rejected
const rejected = waitFor(sSock, 'error', (e) => e.code === 'ALREADY_ANSWERED');
sSock.emit('quiz:answer', { sessionId: sid, questionId: q1, answerIndex: 1 });
await rejected;
check('second attempt rejected', true);

// student2 answers correct -> winner + points + leaderboard.
// The ledger accumulates across runs, so assert the delta rather than a total.
const lbBefore = await req('GET', `/points/leaderboard?courseId=${courseId}`, it);
const s2Before = lbBefore.find((e) => e.name === 'Second Student')?.points ?? 0;
const winnerSeen = waitFor(iSock, 'buzzer:state', (p) => p.state.phase === 'WINNER');
const lbSeen = waitFor(iSock, 'leaderboard:update');
s2Sock.emit('quiz:answer', { sessionId: sid, questionId: q1, answerIndex: 1 });
const winner = await winnerSeen;
check('correct answer wins buzzer', winner.state.winner.name === 'Second Student',
  winner.state.winner.name);
const lb = await lbSeen;
const s2Row = lb.entries.find((e) => e.name === 'Second Student');
check('buzzer win awards +25 on leaderboard', s2Row.points === s2Before + 25,
  `points=${s2Row.points} (was ${s2Before})`);

// timeout path: raise a hand again, open 5s question, let it expire
sSock.emit('hand:raise', { sessionId: sid });
await waitFor(iSock, 'hands:update', (p) => p.raised.length === 1);
const timedOut = waitFor(iSock, 'buzzer:state', (p) => p.state.phase === 'TIMEOUT', 8000);
iSock.emit('buzzer:start', { sessionId: sid, questionId: q2 });
await timedOut;
check('unanswered question times out', true);

// non-instructor cannot lock chat
const forbidden = waitFor(sSock, 'error', (e) => e.code === 'FORBIDDEN');
sSock.emit('chat:lock', { sessionId: sid, locked: true });
await forbidden;
check('student cannot lock chat', true);

// ---------- Summary ----------

for (const s of [iSock, sSock, s2Sock]) s.disconnect();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
