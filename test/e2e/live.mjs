/**
 * Live verification against the running DSH GUI.
 *
 * Probes the plugin's two host routes through the real browser trust fence, so
 * it proves what the panel will actually receive. Run it after any change that
 * needs a DSH restart:
 *
 *   node test/e2e/live.mjs
 *
 * The trust fence needs a browser-session cookie. This script mints one from
 * the credential record DSH itself stores (`client-connection/browser-session`)
 * — the same value the browser holds — and never writes it anywhere.
 *
 * Exit code 0 means both routes answer correctly. A non-zero exit prints which
 * route failed and what it returned, which is how a stale host half shows up:
 * DSH caches host modules by URL, so an edited `lib/index.js` keeps serving the
 * previous code until the application restarts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
const AUTHORITY = new URL(BASE).host;
const STATUS = '/api/dsh-cost-breakdown/status';
const SESSION = '/api/dsh-cost-breakdown/session';

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

/** Mint the authority-bound browser-session cookie DSH's fence expects. */
function sessionCookie() {
  const file = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), '.credentials.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/browser-session:[\s\S]*?secret:\s*(\S+)/);
  if (match === null) throw new Error(`no browser-session secret in ${file}`);
  // The stored secret is base64url and must be decoded to its raw bytes.
  const secret = Buffer.from(match[1], 'base64url');
  if (secret.length !== 32) throw new Error(`browser-session secret is ${secret.length} bytes, expected 32`);
  const b64u = (value) => Buffer.from(value).toString('base64url');
  const name = `dsh-auth-${b64u(crypto.createHash('sha256').update(AUTHORITY).digest())}`;
  const now = Date.now();
  const payload = { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${sig}`;
}

/** POST one route, returning `{ status, json }`. */
async function post(route, payload, cookie) {
  const response = await fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(payload),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* a non-JSON body is itself a finding */
  }
  return { status: response.status, json };
}

/** The most recently written session directory for the current workspace. */
function latestSessionId() {
  const workspaces = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions');
  const candidates = [];
  for (const group of fs.readdirSync(workspaces)) {
    const dir = path.join(workspaces, group);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      const log = path.join(dir, entry, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(log)) continue;
      candidates.push({ id: entry, mtime: fs.statSync(log).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.id ?? null;
}

console.log(`target: ${BASE}`);
const cookie = sessionCookie();

console.log('\n== trust fence ==');
const bare = await fetch(`${BASE}${STATUS}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
check('rejects a request with no session cookie (401)', bare.status === 401, `got ${bare.status}`);

console.log('\n== status route ==');
const status = await post(STATUS, {}, cookie);
check('answers 200 with a session cookie', status.status === 200, `got ${status.status}`);
const value = status.json?.value ?? {};
const balances = Array.isArray(value.balance?.balances) ? value.balance.balances : [];
check('reports a balance', balances.length > 0, balances.length === 0 ? 'no wallet returned' : `${balances[0].total} ${balances[0].currency}`);
// A wallet whose parts sum to the total is the signature of the current code;
// the earlier version reported the two parts as zero.
const split = balances.length > 0 && (balances[0].granted > 0 || balances[0].toppedUp > 0);
check(
  'splits granted and topped-up (stale host half reports both as 0)',
  balances.length === 0 || split,
  balances.length === 0 ? 'n/a' : `granted=${balances[0].granted} toppedUp=${balances[0].toppedUp}`,
);
check('reports the current pricing period', typeof value.period?.peak === 'boolean', value.period?.label ?? 'missing');
check('serves the price table', Array.isArray(value.prices) && value.prices.length === 2, `${value.prices?.length ?? 0} rows`);

console.log('\n== session route ==');
const sessionId = latestSessionId();
if (sessionId === null) {
  console.log('  SKIP  no session log found on disk');
} else {
  const session = await post(SESSION, { sessionId }, cookie);
  // The earlier version returned a bare object, which broke the fetch contract
  // and surfaced as an empty 400.
  check('answers 200 (a bare 400 means the stale host half is still loaded)', session.status === 200, `got ${session.status}`);
  const report = session.json?.value ?? null;
  check('returns a session report', report !== null, report === null ? 'value was null' : `cost=${report.combined?.cost?.toFixed(6)}`);
  if (report !== null) {
    check('counts billed requests', (report.combined?.requests ?? 0) > 0, `${report.combined?.requests ?? 0} requests`);
    check('reports a cost', (report.combined?.cost ?? 0) > 0, `CNY ${report.combined?.cost ?? 0}`);
    check('splits cost by period', typeof report.combined?.byPeriod?.peak === 'number', `peak=${report.combined?.byPeriod?.peak?.toFixed(6) ?? 'n/a'}`);
    check('walks the session lineage', typeof report.sessionsWalked === 'number', `${report.sessionsWalked} session(s)`);
  }
  // The bad-request path is an in-band envelope, not a transport failure.
  const malformed = await post(SESSION, {}, cookie);
  check('refuses a body without a sessionId in-band', malformed.status === 200 && malformed.json?.ok === false, `http ${malformed.status}`);
}

console.log();
if (failures === 0) {
  console.log('LIVE VERIFICATION PASSED — the running host half serves what the panel needs.');
} else {
  console.log(`LIVE VERIFICATION FAILED (${failures}) — restart DSH so the host half reloads, then run this again.`);
}
process.exit(failures === 0 ? 0 : 1);
