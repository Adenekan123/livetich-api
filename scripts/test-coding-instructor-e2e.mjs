/**
 * Comprehensive End-to-End Test for the Coding Instructor Plugin.
 * Exercises:
 *  1. Data provisioning & Pack Entitlement Gating
 *  2. Real-time Collaborative Code Editor (/code namespace with Yjs CRDT)
 *  3. REST Coding Instructor Endpoints (authoring, launch, submit, dashboard, feedback, decision)
 *  4. Real-time Classroom Submission Notification
 */
import { io } from 'socket.io-client';
import * as Y from 'yjs';
import AdmZip from 'adm-zip';
import { execSync } from 'child_process';

const API = process.env.API_URL ?? 'http://127.0.0.1:3005';
const results = [];

const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  const badge = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${badge}  ${name}${detail ? ` — \x1b[90m${detail}\x1b[0m` : ''}`);
};

const req = async (method, path, token, body) => {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    ...(body && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, data: JSON.parse(text) };
  } catch {
    return { status: res.status, ok: res.ok, text };
  }
};

const login = async (email, password = 'password123') => {
  const r = await req('POST', '/auth/login', null, { email, password });
  return r.data?.accessToken;
};

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

const connectNamespace = (namespace, token) =>
  new Promise((resolve, reject) => {
    const s = io(`${API}${namespace}`, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });

const bytes = (data) => new Uint8Array(data);

async function main() {
  console.log('\n============================================================');
  console.log('  CODING INSTRUCTOR PLUGIN — END-TO-END VERIFICATION');
  console.log('============================================================\n');

  // Step 1: Provision test data
  console.log('\x1b[36m[Phase 1] Provisioning Test Data & Entitlements\x1b[0m');
  const setupRaw = execSync('node scripts/code-test-setup.cjs', { encoding: 'utf8' });
  const setup = JSON.parse(setupRaw);
  check('Provisioned test orgs, users, courses, and sessions', !!setup.codeSessionId);

  const [instructorToken, studentToken, plainInstructorToken] = await Promise.all([
    login(setup.instructor),
    login(setup.student),
    login(setup.plainInstructor),
  ]);
  check('Authenticated instructor, student, and plain-org instructor', !!(instructorToken && studentToken && plainInstructorToken));

  // Step 2: Negative Pack Gate on /code WebSocket
  console.log('\n\x1b[36m[Phase 2] Pack Gating & Real-time Shared Code Editor (/code)\x1b[0m');
  const plainSocket = await connectNamespace('/code', plainInstructorToken);
  const gateFail = waitFor(plainSocket, 'error', (e) => e.code === 'FORBIDDEN');
  plainSocket.emit('code:join', { sessionId: setup.plainSessionId });
  const gateErr = await gateFail;
  check('Negative Gate: Org WITHOUT code-instruction pack is forbidden on /code', /not enabled/i.test(gateErr.message), gateErr.message);
  plainSocket.disconnect();

  // Step 3: Collaborative Real-Time Editor Sync (Yjs)
  const [iSock, sSock] = await Promise.all([
    connectNamespace('/code', instructorToken),
    connectNamespace('/code', studentToken),
  ]);

  const iState = waitFor(iSock, 'code:state');
  iSock.emit('code:join', { sessionId: setup.codeSessionId });
  await iState;
  check('Instructor joins /code editor session', true);

  const sState = waitFor(sSock, 'code:state');
  sSock.emit('code:join', { sessionId: setup.codeSessionId });
  await sState;
  check('Student joins /code editor session', true);

  // Instructor writes code -> student receives
  const iDoc = new Y.Doc();
  const sDoc = new Y.Doc();
  iDoc.on('update', (u) => iSock.emit('code:update', { sessionId: setup.codeSessionId, update: u }));

  const sGotCode = waitFor(sSock, 'code:update');
  const sampleCode = 'function calculateFibonacci(n) {\n  return n <= 1 ? n : calculateFibonacci(n - 1) + calculateFibonacci(n - 2);\n}\n';
  iDoc.getText('code').insert(0, sampleCode);
  Y.applyUpdate(sDoc, bytes((await sGotCode).update));
  check('Live Code Sync: Student receives instructor code edits', sDoc.getText('code').toString().includes('calculateFibonacci'));

  // Language change sync
  const sGotLang = waitFor(sSock, 'code:update');
  iDoc.getMap('meta').set('lang', 'javascript');
  Y.applyUpdate(sDoc, bytes((await sGotLang).update));
  check('Language Sync: Language update syncs to student', sDoc.getMap('meta').get('lang') === 'javascript');

  // Read-only enforcement for student
  const readonly = waitFor(sSock, 'error', (e) => e.code === 'FORBIDDEN');
  const rogueDoc = new Y.Doc();
  rogueDoc.getText('code').insert(0, 'student_unauthorized_edit();\n');
  sSock.emit('code:update', { sessionId: setup.codeSessionId, update: Y.encodeStateAsUpdate(rogueDoc) });
  const roErr = await readonly;
  check('Read-only Enforcement: Student writes to shared editor are rejected', /read-only/i.test(roErr.message), roErr.message);

  // Persistence across disconnect
  await new Promise((r) => setTimeout(r, 200));
  iSock.emit('code:leave', { sessionId: setup.codeSessionId });
  sSock.emit('code:leave', { sessionId: setup.codeSessionId });
  await new Promise((r) => setTimeout(r, 600));

  const rejoin = waitFor(sSock, 'code:state');
  sSock.emit('code:join', { sessionId: setup.codeSessionId });
  const reloaded = new Y.Doc();
  Y.applyUpdate(reloaded, bytes((await rejoin).update));
  check(
    'Persistence: Buffer & language survive when participants leave and return',
    reloaded.getText('code').toString().includes('calculateFibonacci') && reloaded.getMap('meta').get('lang') === 'javascript'
  );

  iSock.disconnect();
  sSock.disconnect();

  // Step 4: REST Coding Instructor Plugin API
  console.log('\n\x1b[36m[Phase 3] REST Coding Instructor Endpoints\x1b[0m');

  // Authoring Context
  const authCtx = await req('GET', '/coding/authoring-context', instructorToken);
  check('Authoring Context: Instructor retrieves course list & active sessions', authCtx.ok && Array.isArray(authCtx.data));

  // Teaching list
  const teaching = await req('GET', '/coding/teaching', instructorToken);
  check('Teaching Assignments: Instructor retrieves teaching assignment list', teaching.ok && Array.isArray(teaching.data));

  // Create Coding Assignment
  const newAssignment = await req('POST', `/coding/courses/${setup.codeCourseId}/assignments`, instructorToken, {
    title: 'Algorithm Sprint: Binary Search Tree',
    description: 'Implement insert, search, and inorder traversal in TypeScript. Submit as a zip or via VSCode.',
    language: 'typescript',
    passingScore: 80,
    maxAttempts: 3,
    allowResubmit: true,
    aiAutoReview: false,
    requirements: [
      { text: 'Insert adds elements correctly preserving BST property', mandatory: true },
      { text: 'Search returns true for present keys and false otherwise', mandatory: true },
    ],
    rubric: [
      { criterion: 'Correctness', weight: 60 },
      { criterion: 'Code Quality & Typing', weight: 40 },
    ],
  });
  check('Create Coding Assignment: Successfully created with rubric & requirements', newAssignment.ok && newAssignment.data?.id, JSON.stringify(newAssignment.data ?? newAssignment.text));
  const codingAssignmentId = newAssignment.data?.id;

  // Launch assignment to live session
  const launched = await req('POST', `/coding/assignments/${codingAssignmentId}/launch`, instructorToken, {
    sessionId: setup.codeSessionId,
  });
  check('Launch Assignment: Instructor launches coding task to live session', launched.ok && launched.data?.sessionId === setup.codeSessionId);

  // Student views assignment list (now that it is LIVE, student sees it)
  const mine = await req('GET', '/coding/mine', studentToken);
  check('Student Mine: Enrolled student sees the launched coding assignment', mine.ok && mine.data?.some((a) => a.id === codingAssignmentId));

  // Student Project Submission (.zip archive) using AdmZip
  const zip = new AdmZip();
  zip.addFile('src/bst.ts', Buffer.from(`
export class BinarySearchTree<T> {
  root: any = null;
  insert(value: T): void {
    // BST Insert implementation
  }
  search(value: T): boolean {
    return true;
  }
}
`));
  zip.addFile('README.md', Buffer.from('# BST Implementation\nPassed local unit tests.'));
  const zipBuffer = zip.toBuffer();

  // Create Multipart Form Data
  const formData = new FormData();
  formData.append('file', new Blob([zipBuffer], { type: 'application/zip' }), 'bst-solution.zip');

  const submitRes = await fetch(`${API}/coding/assignments/${codingAssignmentId}/submit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${studentToken}`,
    },
    body: formData,
  });
  const submitData = await submitRes.json();
  check('Student Submission: Project .zip uploaded as attempt #1', submitRes.ok && submitData?.submission?.id, JSON.stringify(submitData));
  const submissionId = submitData?.submission?.id;

  // Instructor Dashboard
  const dashboard = await req('GET', `/coding/assignments/${codingAssignmentId}/dashboard`, instructorToken);
  check('Instructor Dashboard: Shows student attempt, status & roster', dashboard.ok && dashboard.data?.rows?.some((r) => r.latest?.submissionId === submissionId));

  // Instructor Feedback
  if (submissionId) {
    const feedbackRes = await req('POST', `/coding/submissions/${submissionId}/feedback`, instructorToken, {
      body: 'Excellent BST implementation! Clean generic typing and edge cases handled.',
      filePath: 'src/bst.ts',
      line: 2,
    });
    check('Instructor Feedback: Added file & line review comment', feedbackRes.ok && feedbackRes.data?.id, JSON.stringify(feedbackRes.data ?? feedbackRes.text));

    // Instructor Final Decision
    const decisionRes = await req('POST', `/coding/submissions/${submissionId}/decision`, instructorToken, {
      decision: 'PASS',
      finalScore: 95,
      feedback: 'Full marks on core logic and TypeScript safety.',
    });
    check('Instructor Final Decision: Approved submission (PASS with 95%)', decisionRes.ok && decisionRes.data?.status === 'PASSED', JSON.stringify(decisionRes.data ?? decisionRes.text));
  }

  // Close assignment
  const closed = await req('POST', `/coding/assignments/${codingAssignmentId}/close`, instructorToken);
  check('Close Assignment: Instructor marks live assignment closed', closed.ok);

  // Summary
  const passed = results.filter((r) => r.ok).length;
  console.log('\n============================================================');
  console.log(`  RESULT: ${passed}/${results.length} checks passed`);
  console.log('============================================================\n');

  if (passed !== results.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n\x1b[31m[ERROR]\x1b[0m', err);
  process.exit(1);
});
