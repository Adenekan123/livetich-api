/**
 * Board "students can draw" toggle smoke test. Requires API on :3000 + a live
 * session; run scripts/code-test-setup.cjs first and pass its JSON.
 *
 *   node scripts/board-writable-smoke.mjs '<setup-json>'
 */
import { io } from 'socket.io-client';
import * as Y from 'yjs';

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
  new Promise((res, rej) => {
    const s = io(`${API}/board`, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => res(s));
    s.on('connect_error', rej);
  });
const waitFor = (s, e, ms = 1200) =>
  new Promise((res) => {
    const t = setTimeout(() => res(null), ms);
    s.once(e, (p) => {
      clearTimeout(t);
      res(p);
    });
  });
const validUpdate = () => {
  const d = new Y.Doc();
  d.getMap('tldraw').set('probe', 1);
  return Y.encodeStateAsUpdate(d);
};

const sid = setup.codeSessionId;
const [it, st] = await Promise.all([login(setup.instructor), login(setup.student)]);
const iSock = await connect(it);
iSock.emit('board:join', { sessionId: sid });
const sSock = await connect(st);
const openOnJoin = waitFor(sSock, 'board:writable');
sSock.emit('board:join', { sessionId: sid });
const initial = await openOnJoin;
check('join reports current writable state', initial && initial.open === false, JSON.stringify(initial));

// Closed: a student board:update is rejected.
const err1 = waitFor(sSock, 'error');
sSock.emit('board:update', { sessionId: sid, update: validUpdate() });
const e1 = await err1;
check('student draw rejected while closed', !!e1 && e1.code === 'FORBIDDEN', JSON.stringify(e1));

// Instructor opens the board → student is notified.
const opened = waitFor(sSock, 'board:writable');
iSock.emit('board:writable', { sessionId: sid, open: true });
const o = await opened;
check('student notified board opened', !!o && o.open === true);

// Open: a student board:update is accepted (no error) + fans out to instructor.
let studentErr = false;
sSock.once('error', () => (studentErr = true));
const gotUpdate = waitFor(iSock, 'board:update');
sSock.emit('board:update', { sessionId: sid, update: validUpdate() });
const relayed = await gotUpdate;
await new Promise((r) => setTimeout(r, 200));
check('student draw accepted while open (no error)', studentErr === false);
check('student draw fans out to instructor', !!relayed);

for (const s of [iSock, sSock]) s.disconnect();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
