/**
 * Shared helper: fetch the client bundle the running DSH GUI actually serves.
 *
 * The e2e tests must exercise the artifact the browser loads, not the file on
 * disk — that is what proves the host delivered the plugin rather than merely
 * that the source exists. The bundle URL is revisioned and the revision changes
 * whenever the file does, so it is discovered from the live boot graph instead
 * of hardcoded.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387';
const AUTHORITY = new URL(BASE).host;

/** The browser-session cookie DSH's trust fence expects, minted from storage. */
export function sessionCookie() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  const text = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  const match = text.match(/browser-session:[\s\S]*?secret:\s*(\S+)/);
  if (match === null) throw new Error('no browser-session secret found');
  // The stored value is base64url and must be decoded to its raw key bytes.
  const secret = Buffer.from(match[1], 'base64url');
  if (secret.length !== 32) throw new Error(`browser-session secret is ${secret.length} bytes, expected 32`);
  const b64u = (value) => Buffer.from(value).toString('base64url');
  const name = `dsh-auth-${b64u(crypto.createHash('sha256').update(AUTHORITY).digest())}`;
  const now = Date.now();
  const payload = { version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 3_600_000 };
  const body = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${signature}`;
}

/**
 * Fetch the plugin's served client bundle.
 * @returns {Promise<{source: string, revision: string}>}
 */
export async function fetchClientBundle() {
  const cookie = sessionCookie();
  const index = await fetch(`${BASE}/`, { headers: { cookie } });
  if (!index.ok) throw new Error(`could not read the boot graph: HTTP ${index.status}`);
  const html = await index.text();
  const revisions = [...new Set(
    [...html.matchAll(/dsh-cost-breakdown\/client\.js(?:&amp;|&)rev=([0-9a-f]+)/g)].map((match) => match[1]),
  )];
  if (revisions.length === 0) throw new Error('the boot graph does not advertise dsh-cost-breakdown — is the plugin enabled?');
  // More than one revision can appear during a rebuild window; the served one is
  // whichever actually answers, so try each before giving up.
  for (const revision of revisions) {
    const response = await fetch(`${BASE}/plugins/??dsh-cost-breakdown/client.js&rev=${revision}`);
    if (response.ok) return { source: await response.text(), revision };
  }
  throw new Error(`no advertised revision answered: ${revisions.join(', ')}`);
}

export { BASE };
