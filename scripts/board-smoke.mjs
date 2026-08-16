/**
 * Chalkboard (/board namespace) smoke test. Requires the API on :3000 + Redis.
 *
 *   node scripts/board-smoke.mjs
 *
 * Exercises: authed join, instructor Yjs updates fanning out to students,
 * read-only enforcement, awareness relay, and snapshot persistence across
 * everyone leaving.
 */
import { io } from 'socket.io-client';
import * as Y from 'yjs';

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
    const s = io(`${API}/board`, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const bytes = (data) => new Uint8Array(data);

// ---------- Setup via REST ----------

// Driven by scripts/code-test-setup.cjs output (pass its JSON as argv[2]): an
// instructor-owned course, an enrolled student, and a second instructor who is
// NOT the owner (grace) for the forbidden-join check.
const setup = JSON.parse(process.argv[2] ?? process.env.SETUP ?? '{}');
const [it, st, ot] = await Promise.all([
  login(setup.instructor ?? 'instructor@livetich.dev'),
  login(setup.student ?? 'seedstudent1@livetich.dev'),
  login(setup.plainInstructor ?? 'grace@livetich.dev'),
]);
const courseId = setup.codeCourseId ?? (await req('GET', '/courses', it))[0].id;
const session = await req('POST', '/sessions', it, {
  courseId,
  scheduledAt: new Date().toISOString(),
});
await req('POST', `/sessions/${session.id}/start`, it);
const sid = session.id;

// ---------- Join + initial state ----------

const [iSock, sSock, oSock] = await Promise.all([it, st, ot].map(connect));
check('board sockets connected', true);

const iState = waitFor(iSock, 'board:state');
iSock.emit('board:join', { sessionId: sid });
await iState;
check('instructor receives initial board state', true);

const sState = waitFor(sSock, 'board:state');
sSock.emit('board:join', { sessionId: sid });
await sState;
check('student receives initial board state', true);

// Non-owner instructor is rejected
const forbidden = waitFor(oSock, 'error', (e) => e.code === 'FORBIDDEN');
oSock.emit('board:join', { sessionId: sid });
await forbidden;
check('non-owner instructor cannot join board', true);

// ---------- Instructor draws, student receives ----------

const iDoc = new Y.Doc();
const sDoc = new Y.Doc();
iDoc.on('update', (update) => {
  iSock.emit('board:update', { sessionId: sid, update });
});

const sGotUpdate = waitFor(sSock, 'board:update');
iDoc.getMap('shapes').set('rect-1', { x: 10, y: 20, w: 100, h: 50 });
Y.applyUpdate(sDoc, bytes((await sGotUpdate).update));
const rect = sDoc.getMap('shapes').get('rect-1');
check('student receives live Yjs update', rect?.w === 100, JSON.stringify(rect));

// ---------- Read-only enforcement ----------

const readonly = waitFor(sSock, 'error', (e) => e.code === 'FORBIDDEN');
const rogue = new Y.Doc();
rogue.getMap('shapes').set('hack', true);
sSock.emit('board:update', {
  sessionId: sid,
  update: Y.encodeStateAsUpdate(rogue),
});
await readonly;
check('student writes are rejected', true);

// ---------- Awareness relay ----------

const cursorSeen = waitFor(sSock, 'board:awareness');
iSock.emit('board:awareness', {
  sessionId: sid,
  update: new Uint8Array([1, 2, 3]),
});
const cursor = bytes((await cursorSeen).update);
check('awareness relays to others', cursor.length === 3);

// ---------- Persistence across everyone leaving ----------

iDoc.getMap('shapes').set('rect-2', { x: 5, y: 5, w: 7, h: 7 });
await new Promise((r) => setTimeout(r, 300)); // let the update land server-side
iSock.emit('board:leave', { sessionId: sid });
sSock.emit('board:leave', { sessionId: sid });
await new Promise((r) => setTimeout(r, 500)); // release -> flush -> evict

const rejoinState = waitFor(sSock, 'board:state');
sSock.emit('board:join', { sessionId: sid });
const reloaded = new Y.Doc();
Y.applyUpdate(reloaded, bytes((await rejoinState).update));
const shapes = reloaded.getMap('shapes');
check(
  'snapshot survives everyone leaving',
  shapes.get('rect-1')?.w === 100 && shapes.get('rect-2')?.w === 7,
  `${shapes.size} shapes reloaded from disk`,
);
check('rogue student write never landed', shapes.get('hack') === undefined);

// ---------- Summary ----------

for (const s of [iSock, sSock, oSock]) s.disconnect();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
