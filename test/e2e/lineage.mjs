/**
 * End-to-end descendant aggregation against REAL logs: drive the fixed host
 * half's session route for a session that genuinely has a subagent child, and
 * confirm the child's own requests are added to the parent's total.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
// Resolve the host half relative to THIS file, so the test works from any clone
// rather than only the machine it was written on.
const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const host = await import(`${ROOT}/lib/index.js`);
const { foldEvents } = await import(`${ROOT}/lib/pricing.mjs`);


const base = path.join(os.homedir(), '.dsh/sessions');
const magic = Buffer.from([0x28,0xb5,0x2f,0xfd]);
// Discover a real parent/child pair rather than hardcoding ids, so this test
// stays meaningful on any machine that has run a subagent at least once.
const DISCOVER = () => {
  const found = [];
  for (const group of fs.readdirSync(base)) {
    const dir = path.join(base, group);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      const f = path.join(dir, entry, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const d = fs.readFileSync(f);
      let head = null;
      try { head = JSON.parse(zlib.zstdDecompressSync(d).toString('utf8').split('\n')[0]); } catch {
        // Multi-frame logs need the frame walk performed by load().
        const offs = []; let i = 0;
        while (true) { const j = d.indexOf(magic, i); if (j < 0) break; offs.push(j); i = j + 1; }
        let out = '';
        for (let k = 0; k < offs.length; k++) {
          const s2 = offs[k], e2 = k + 1 < offs.length ? offs[k + 1] : d.length;
          try { out += zlib.zstdDecompressSync(d.subarray(s2, e2)).toString('utf8'); } catch {}
        }
        try { head = JSON.parse(out.split('\n')[0]); } catch {}
      }
      if (head?.parentSession) found.push({ childId: head.id, parentId: head.parentSession });
    }
  }
  return found[0] ?? null;
};
const pair = DISCOVER();
if (pair === null) {
  console.log('SKIP: no subagent session found on disk — run a subagent once, then re-run this test');
  process.exit(0);
}
const PARENT = pair.parentId;
const load = (id) => {
  for (const group of fs.readdirSync(base)) {
    const dir = path.join(base, group);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      const f = path.join(dir, entry, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(f)) continue;
      const d = fs.readFileSync(f);
      const offs = []; let i = 0;
      while (true) { const j = d.indexOf(magic, i); if (j < 0) break; offs.push(j); i = j + 1; }
      let out = '';
      for (let k = 0; k < offs.length; k++) {
        const s = offs[k], e = k + 1 < offs.length ? offs[k + 1] : d.length;
        try { out += zlib.zstdDecompressSync(d.subarray(s, e)).toString('utf8'); } catch {}
      }
      const lines = out.split('\n').filter(Boolean);
      let header = null; try { header = JSON.parse(lines[0]); } catch {}
      if (header?.id === id) {
        return { header, events: lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
      }
    }
  }
  return null;
};

const parent = load(PARENT);
const childId = pair.childId;
const child = load(childId);
if (!parent || !child) { console.log('fixture missing'); process.exit(1); }
console.log('pair:', PARENT, '->', childId);
console.log('parent events:', parent.events.length, '| child events:', child.events.length);

// The corpus must LIST the child so the walk can discover it.
const routes = new Map();
const ctx = {
  get(n) {
    if (n === 'sessionQuery') return {
      listSessions: async () => [{ header: parent.header }, { header: child.header }],
      observeSession: async (id) => {
        const src = id === PARENT ? parent : id === childId ? child : null;
        if (!src) throw new Error('unknown ' + id);
        return { events: src.events, inheritedEventCount: 0, source: 'log', [Symbol.dispose]() {} };
      },
    };
    if (n === 'connection') return { fetch: { register: (r) => { routes.set(r.path, r); return () => {}; } } };
    return undefined;
  },
  inject(s, cb) { cb(this); return () => {}; },
  effect(fn) { const r = fn(); return typeof r === 'function' ? r : () => {}; },
};
host.apply(ctx, {});
const res = await routes.get('/api/dsh-cost-breakdown/session').fetch(
  new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: PARENT }) }),
);
const v = (await res.json()).value;

const ownExpected = foldEvents(parent.events, { turnLimit: 30 }).cost;
const childExpected = foldEvents(child.events, { turnLimit: 30 }).cost;
console.log('\n--- aggregated report ---');
console.log('sessionsWalked:', v.sessionsWalked, '| children found:', v.children.length);
console.log('own cost          : CNY', v.own.cost.toFixed(6), '(expected', ownExpected.toFixed(6) + ')');
console.log('child cost        : CNY', (v.children[0]?.cost ?? 0).toFixed(6), '(expected', childExpected.toFixed(6) + ')');
console.log('combined cost     : CNY', v.combined.cost.toFixed(6));
console.log('combined requests :', v.combined.requests);
const sumOk = Math.abs(v.combined.cost - (ownExpected + childExpected)) < 1e-9;
const childFound = v.children.length === 1 && v.children[0].sessionId === childId;
console.log('\nchild discovered via parentSession:', childFound ? '✓' : '✗');
console.log('combined == own + child          :', sumOk ? '✓' : '✗');
console.log('child requests counted           :', v.children[0]?.requests > 0 ? '✓ (' + v.children[0].requests + ')' : '✗');
process.exit(childFound && sumOk ? 0 : 1);
