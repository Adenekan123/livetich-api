/**
 * Board presenter-tools relay smoke test. Requires API on :3000 + a live
 * session; run scripts/code-test-setup.cjs first and pass its JSON.
 *
 *   node scripts/board-presenter-smoke.mjs '<setup-json>'
 *
 * Proves board:presenter fans instructor camera+cursor out to students, and
 * that a student cannot broadcast it (instructor-only).
 */
import { io } from 'socket.io-client';

const API = 'http://localhost:3000';
const setup = JSON.parse(process.argv[2] ?? process.env.SETUP ?? '{}');
const results = [];
const check = (n, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`);
};

const login = async (email) =>
  (await (await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  })).json()).accessToken;

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(`${API}/board`, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const waitFor = (socket, event, ms = 1500) =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    socket.once(event, (p) => {
      clearTimeout(t);
      resolve(p);
    });
  });

const sid = setup.codeSessionId;
const [it, st] = await Promise.all([login(setup.instructor), login(setup.student)]);

const iSock = await connect(it);
iSock.emit('board:join', { sessionId: sid });
const sSock = await connect(st);
sSock.emit('board:join', { sessionId: sid });
await new Promise((r) => setTimeout(r, 500));

// Instructor broadcasts → student receives.
const got = waitFor(sSock, 'board:presenter');
iSock.emit('board:presenter', {
  sessionId: sid,
  camera: { x: 12, y: 34, z: 1.5 },
  cursor: { x: 100, y: 200 },
});
const p = await got;
check('student receives instructor presenter', !!p && p.camera?.z === 1.5, JSON.stringify(p));

// Student broadcast is rejected (instructor-only) → instructor gets nothing.
let leaked = false;
iSock.on('board:presenter', () => {
  leaked = true;
});
sSock.emit('board:presenter', {
  sessionId: sid,
  camera: { x: 0, y: 0, z: 1 },
  cursor: null,
});
await new Promise((r) => setTimeout(r, 400));
check('student cannot broadcast presenter (instructor-only)', leaked === false);

for (const s of [iSock, sSock]) s.disconnect();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
