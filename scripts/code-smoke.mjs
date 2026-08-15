/**
 * Code editor (/code namespace) smoke test — the Code Instruction pack.
 * Requires the API on :3000 + Redis, and `node scripts/code-test-setup.cjs`
 * run first (pass its JSON on argv or via env).
 *
 *   node scripts/code-smoke.mjs '<setup-json>'
 *
 * Exercises: pack gate (enabled org joins, un-enabled org rejected), instructor
 * Y.Text edits fanning out to students, language sync via the Y.Map, read-only
 * enforcement, and snapshot persistence across everyone leaving.
 */
import { io } from 'socket.io-client';
import * as Y from 'yjs';

const API = 'http://localhost:3000';
const setup = JSON.parse(process.argv[2] ?? process.env.SETUP ?? '{}');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const req = async (method, path, token, body) =>
  (await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body && { body: JSON.stringify(body) }),
  })).json();

const login = async (email) =>
  (await req('POST', '/auth/login', null, { email, password: 'password123' })).accessToken;

const waitFor = (socket, event, pred = () => true, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
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
    const s = io(`${API}/code`, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const bytes = (data) => new Uint8Array(data);
const sid = setup.codeSessionId;

// ---------- Tokens ----------
const [it, st, pt] = await Promise.all([
  login(setup.instructor),
  login(setup.student),
  login(setup.plainInstructor),
]);
check('logged in instructor + student + plain-org instructor', it && st && pt);

// ---------- Negative gate: org without the pack is rejected ----------
const pSock = await connect(pt);
const gateFail = waitFor(pSock, 'error', (e) => e.code === 'FORBIDDEN');
pSock.emit('code:join', { sessionId: setup.plainSessionId });
const gateErr = await gateFail;
check('org WITHOUT code-instruction is rejected', /not enabled/i.test(gateErr.message), gateErr.message);
pSock.disconnect();

// ---------- Join the enabled session ----------
const [iSock, sSock] = await Promise.all([connect(it), connect(st)]);
const iState = waitFor(iSock, 'code:state');
iSock.emit('code:join', { sessionId: sid });
await iState;
check('instructor joins the code surface (pack enabled)', true);

const sState = waitFor(sSock, 'code:state');
sSock.emit('code:join', { sessionId: sid });
await sState;
check('student joins the code surface', true);

// ---------- Instructor types, student receives ----------
const iDoc = new Y.Doc();
const sDoc = new Y.Doc();
iDoc.on('update', (u) => iSock.emit('code:update', { sessionId: sid, update: u }));

const sGotCode = waitFor(sSock, 'code:update');
iDoc.getText('code').insert(0, 'fn main() {\n    println!("hi");\n}\n');
Y.applyUpdate(sDoc, bytes((await sGotCode).update));
check(
  'student receives live code edits',
  sDoc.getText('code').toString().includes('println!'),
  JSON.stringify(sDoc.getText('code').toString()),
);

// ---------- Language sync via the Y.Map ----------
const sGotLang = waitFor(sSock, 'code:update');
iDoc.getMap('meta').set('lang', 'python');
Y.applyUpdate(sDoc, bytes((await sGotLang).update));
check('language change syncs to student', sDoc.getMap('meta').get('lang') === 'python');

// ---------- Read-only enforcement ----------
const readonly = waitFor(sSock, 'error', (e) => e.code === 'FORBIDDEN');
const rogue = new Y.Doc();
rogue.getText('code').insert(0, 'hacked');
sSock.emit('code:update', { sessionId: sid, update: Y.encodeStateAsUpdate(rogue) });
const roErr = await readonly;
check('student writes are rejected (read-only)', /read-only/i.test(roErr.message), roErr.message);

// ---------- Persistence across everyone leaving ----------
await new Promise((r) => setTimeout(r, 300));
iSock.emit('code:leave', { sessionId: sid });
sSock.emit('code:leave', { sessionId: sid });
await new Promise((r) => setTimeout(r, 600)); // release -> flush -> evict

const rejoin = waitFor(sSock, 'code:state');
sSock.emit('code:join', { sessionId: sid });
const reloaded = new Y.Doc();
Y.applyUpdate(reloaded, bytes((await rejoin).update));
check(
  'buffer + language survive everyone leaving',
  reloaded.getText('code').toString().includes('println!') &&
    reloaded.getMap('meta').get('lang') === 'python',
  `lang=${reloaded.getMap('meta').get('lang')}, len=${reloaded.getText('code').length}`,
);
check('rogue student write never landed', !reloaded.getText('code').toString().includes('hacked'));

for (const s of [iSock, sSock]) s.disconnect();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
