/**
 * Room-gateway pack-gate smoke test. Requires the API on :3000 + Redis, and
 * `node scripts/code-test-setup.cjs` run first (pass its JSON on argv).
 *
 *   node scripts/room-gate-smoke.mjs '<setup-json>'
 *
 * Proves the shared mushaf + code stage are entitlement-gated at the socket:
 *  - code-academy org has Code Instruction but NOT Islamic Education, so:
 *      · joining emits NO quran:position (mushaf stays shut)
 *      · view:change→code succeeds; view:change→quran is rejected
 *      · quran:navigate is rejected
 *  - plain-academy org has neither pack, so view:change→code is rejected too,
 *    while the ungated board stage still works.
 */
import { io } from 'socket.io-client';

const API = 'http://localhost:3000';
const setup = JSON.parse(process.argv[2] ?? process.env.SETUP ?? '{}');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const login = async (email) => {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  return (await res.json()).accessToken;
};

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io(API, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const waitFor = (socket, event, pred = () => true, ms = 1500) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.on(event, (payload) => {
      if (!pred(payload)) return;
      clearTimeout(timer);
      resolve(payload);
    });
  });

// ---- code-academy org: Code on, Islamic Education off ----
const it = await login(setup.instructor);
const iSock = await connect(it);

// Capture any quran:position pushed during/after join.
let quranPos = null;
iSock.on('quran:position', (p) => { quranPos = p; });

iSock.emit('room:join', { sessionId: setup.codeSessionId });
await new Promise((r) => setTimeout(r, 700));
check('join on code-only org emits NO quran:position', quranPos === null,
  quranPos ? JSON.stringify(quranPos) : 'none');

// view:change -> code should succeed (pack on).
const codeView = waitFor(iSock, 'view:changed', (p) => p.view === 'code');
iSock.emit('view:change', { sessionId: setup.codeSessionId, view: 'code' });
check('view:change→code accepted (Code pack on)', !!(await codeView));

// view:change -> quran should be rejected with PLUGIN_DISABLED.
const quranErr = waitFor(iSock, 'error', (p) => p.code === 'PLUGIN_DISABLED');
iSock.emit('view:change', { sessionId: setup.codeSessionId, view: 'quran' });
const qe = await quranErr;
check('view:change→quran rejected (Islamic Ed off)', !!qe, qe ? qe.code : 'no error');

// quran:navigate should be rejected too.
const navErr = waitFor(iSock, 'error', (p) => p.code === 'PLUGIN_DISABLED');
iSock.emit('quran:navigate', { sessionId: setup.codeSessionId, surah: 2, ayah: 255 });
const ne = await navErr;
check('quran:navigate rejected (Islamic Ed off)', !!ne, ne ? ne.code : 'no error');

// Ungated board stage still works.
const boardView = waitFor(iSock, 'view:changed', (p) => p.view === 'board');
iSock.emit('view:change', { sessionId: setup.codeSessionId, view: 'board' });
check('view:change→board still works (ungated)', !!(await boardView));

// ---- plain-academy org: neither pack ----
const pit = await login(setup.plainInstructor);
const pSock = await connect(pit);
pSock.emit('room:join', { sessionId: setup.plainSessionId });
await new Promise((r) => setTimeout(r, 400));

const plainCodeErr = waitFor(pSock, 'error', (p) => p.code === 'PLUGIN_DISABLED');
pSock.emit('view:change', { sessionId: setup.plainSessionId, view: 'code' });
const pce = await plainCodeErr;
check('view:change→code rejected on plain org (Code off)', !!pce, pce ? pce.code : 'no error');

const plainBoard = waitFor(pSock, 'view:changed', (p) => p.view === 'board');
pSock.emit('view:change', { sessionId: setup.plainSessionId, view: 'board' });
check('board still works on plain org', !!(await plainBoard));

for (const s of [iSock, pSock]) s.disconnect();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
