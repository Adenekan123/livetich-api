#!/usr/bin/env node
/**
 * Put the web app *and* this API on the public internet so LiveKit can film a
 * class.
 *
 * Recording the whole lesson — board, mushaf, shared media — is a *web* egress:
 * LiveKit opens a browser on its own infrastructure and points it at
 * `WEB_URL/record/<session>`. That browser needs two things to be reachable
 * from where it runs, not from here:
 *
 *   WEB_URL         the page itself
 *   API_PUBLIC_URL  every fetch and socket the page then makes
 *
 * Miss either and the recording is not "missing the board" — it is a
 * full-screen error frame, which is to say a black video, and nothing about it
 * says why. So both get a tunnel, and both get written into .env.
 *
 * Quick tunnels are issued a new random hostname on every start, and the dead
 * one stays sitting in .env pointing at nothing. That is the actual reason
 * recording keeps breaking between sessions, so this script rewrites both
 * values every run and puts the previous ones back when it stops.
 *
 *   pnpm dev:tunnel
 *
 * Leave it running for as long as you are recording.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = join(ROOT, '.env');

/** What to expose, and which .env key each one lands in. */
const TARGETS = [
  { key: 'WEB_URL', port: process.env.WEB_PORT ?? '3001', what: 'web app' },
  { key: 'API_PUBLIC_URL', port: process.env.PORT ?? '3000', what: 'API' },
];

/**
 * winget installs cloudflared without putting it on PATH, so a bare spawn finds
 * nothing on a machine where it is perfectly well installed. Look where it
 * actually lands before giving up.
 */
function findCloudflared() {
  const candidates = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    '/usr/local/bin/cloudflared',
    '/opt/homebrew/bin/cloudflared',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'cloudflared';
}

/** Replace one key in .env in place, leaving every other line untouched. */
function setEnv(key, value) {
  const before = readFileSync(ENV_FILE, 'utf8');
  const re = new RegExp(`^${key}=.*$`, 'm');
  // null means the key was absent, which restore() needs in order to tell
  // "put the old value back" apart from "take this line out again".
  const had = before.match(re)?.[0]?.slice(key.length + 1) ?? null;
  const next =
    had !== null
      ? before.replace(re, `${key}=${value}`)
      : `${before.replace(/\n*$/, '')}\n${key}=${value}\n`;
  writeFileSync(ENV_FILE, next);
  return had;
}

/** Take a key back out of .env entirely. */
function unsetEnv(key) {
  const before = readFileSync(ENV_FILE, 'utf8');
  writeFileSync(ENV_FILE, before.replace(new RegExp(`^${key}=.*\n?`, 'm'), ''));
}

if (!existsSync(ENV_FILE)) {
  console.error(`No .env at ${ENV_FILE} — copy .env.example first.`);
  process.exit(1);
}

const bin = findCloudflared();
const children = [];
const previous = new Map();
let announced = 0;

for (const target of TARGETS) {
  console.log(`Opening a tunnel to the ${target.what} on :${target.port} …`);
  const child = spawn(
    bin,
    ['tunnel', '--url', `http://localhost:${target.port}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  let claimed = false;

  /**
   * cloudflared announces the hostname once, inside an ASCII box, on stderr.
   * Everything after is request noise, so take the first match and stop looking
   * — a later trycloudflare.com string in a log line is not a new tunnel.
   */
  const scan = (chunk) => {
    const text = chunk.toString();
    if (claimed) return;
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!m) return;
    claimed = true;
    previous.set(target.key, setEnv(target.key, m[0]));
    console.log(`  ${target.key} = ${m[0]}`);
    if (++announced === TARGETS.length) {
      console.log(
        `\n  Both tunnels are up and .env is updated.\n\n` +
          `  Restart the API so it reads them — NestJS loads .env once, at boot.\n` +
          `  Record then captures the whole class instead of refusing.\n` +
          `  Leave this running; Ctrl-C restores the previous values.\n`,
      );
    }
  };

  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('error', (e) => {
    console.error(
      `\nCould not start cloudflared (${e.message}).\n` +
        `Install it with:  winget install --id Cloudflare.cloudflared\n`,
    );
    shutdown(1);
  });
  child.on('exit', (code) => {
    if (code) console.error(`cloudflared for ${target.key} exited (${code}).`);
    shutdown(code ?? 0);
  });
}

/**
 * A dead tunnel's hostname left behind in .env is exactly the failure this
 * script exists to prevent, so do not become the thing that causes it.
 */
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [key, value] of previous) {
    if (value !== null) {
      setEnv(key, value);
      console.log(`\n${key} put back to ${value}.`);
    } else {
      // The key was not there before this run. Leaving a dead tunnel hostname
      // behind is precisely the trap this script exists to close, so take it
      // out rather than let the next recording trust it.
      unsetEnv(key);
      console.log(`\n${key} removed again.`);
    }
  }
}

let exiting = false;
function shutdown(code) {
  if (exiting) return;
  exiting = true;
  restore();
  for (const c of children) c.kill();
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('exit', restore);
