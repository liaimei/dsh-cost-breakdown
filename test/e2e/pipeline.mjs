/**
 * Full-pipeline verification: the FIXED host half's own route handlers feed the
 * REAL client bundle fetched from the running GUI. Any break between host JSON,
 * client parsing, and rendered text fails here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { fetchClientBundle } from './bundle.mjs';
import { createReact, loadBundle, renderComponent } from './react-stub.mjs';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const host = await import(`${ROOT}/lib/index.js`);

// --- 1. Decode a real session log -----------------------------------------
// Discover it under $DSH_HOME instead of pinning one absolute path: the fixture
// must exist on any machine that has run DSH, not only the one it was written on.
const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const discoverSession = () => {
  const groups = path.join(DSH_HOME, 'sessions');
  const candidates = [];
  for (const group of fs.readdirSync(groups)) {
    const dir = path.join(groups, group);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      const log = path.join(dir, entry, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(log)) continue;
      candidates.push({ id: entry, log, mtime: fs.statSync(log).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] ?? null;
};
const discovered = discoverSession();
if (discovered === null) {
  console.log('SKIP  no session log under ' + path.join(DSH_HOME, 'sessions'));
  process.exit(0);
}
const SID = discovered.id;
const d = fs.readFileSync(discovered.log);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const offs = []; let i = 0;
while (true) { const j = d.indexOf(magic, i); if (j < 0) break; offs.push(j); i = j + 1; }
let out = '';
for (let k = 0; k < offs.length; k++) {
  const s = offs[k], e = k + 1 < offs.length ? offs[k + 1] : d.length;
  try { out += zlib.zstdDecompressSync(d.subarray(s, e)).toString('utf8'); } catch {}
}
const events = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log(`fixture: ${SID} (${events.length} events)`);

// --- 2. Drive the FIXED host half's real routes ---------------------------
const routes = new Map();
const ctx = {
  get(n) {
    if (n === 'sessionQuery') return {
      listSessions: async () => [{ header: { id: SID } }, { header: { id: 'session-child-demo', parentSession: SID } }],
      // The observation contract: a lease exposing the events, released by the
      // caller. A throw here would be contained into "no data".
      observeSession: async (id) => {
        const events_ = id === 'session-child-demo'
          ? [{ type: 'assistant/message', seq: 1, time: Date.UTC(2026, 9, 12, 12, 0),
              data: { usage: { inputTokens: 12000, outputTokens: 3100, cacheReadTokens: 900000 }, message: { source: { model: 'deepseek-v4.1-flash' } } } }]
          : events;
        return { events: events_, inheritedEventCount: 0, source: 'live', [Symbol.dispose]() {} };
      },
    };
    if (n === 'deepseekAccount') return {
      getState: async () => ({ status: 'credential-stored' }),
      getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '30.50' }], bonusWallets: [{ currency: 'CNY', balance: '7.62278116' }] }),
    };
    if (n === 'connection') return { fetch: { register: (r) => { routes.set(r.path, r); return () => {}; } } };
    return undefined;
  },
  inject(s, cb) { cb(this); return () => {}; },
  effect(fn) { const r = fn(); return typeof r === 'function' ? r : () => {}; },
};
host.apply(ctx, {});

const mkReq = (body) => new Request('http://127.0.0.1:19387/api/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const statusRes = await routes.get('/api/dsh-cost-breakdown/status').fetch(mkReq('{}'));
const sessionRes = await routes.get('/api/dsh-cost-breakdown/session').fetch(mkReq(JSON.stringify({ sessionId: SID })));
if (!(statusRes instanceof Response) || !(sessionRes instanceof Response)) throw new Error('routes must return Responses');
const statusJson = await statusRes.json();
const sessionJson = await sessionRes.json();
console.log('[host] status:', statusRes.status, '| session:', sessionRes.status);
const b0 = statusJson.value.balance.balances[0];
console.log(`[host] balance total=${b0.total} granted=${b0.granted} toppedUp=${b0.toppedUp}`);
console.log(`[host] session cost=CNY ${sessionJson.value.combined.cost.toFixed(6)} requests=${sessionJson.value.combined.requests} children=${sessionJson.value.children.length}`);

// --- 3. Load the REAL client bundle served by the GUI ---------------------
// The served artifact, fetched from the running GUI (not the file on disk).
const { source: bundleSource, revision } = await fetchClientBundle();
const source = bundleSource;
console.log(`bundle: served revision ${revision}`);
// One shared React stand-in: three suites previously carried their own copies
// and drifted whenever the bundle gained a hook.
const r = createReact();
const fetchStub = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/status') ? statusJson : sessionJson) });
const loaded = loadBundle(vm, source, fetchStub, 'react', r.React);

let Comp = null;
loaded.exports.apply({
  effect: (f) => { f(); return () => {}; },
  locale: { register: () => () => {}, bind: () => (k) => k },
  inject: (s, cb) => cb({ sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (k, f) => { f(); return () => {}; }, register: (o, c) => { if (o.name === 'sidebar.right.pane.tab') Comp = c; return () => {}; } } }),
});
if (Comp === null) throw new Error('panel component not registered');
const tree = await renderComponent(r, Comp, { t: (k) => k, sessionId: SID });

const texts = [], classes = [];
(function walk(n) {
  if (n === null || n === undefined) return;
  if (typeof n === 'string' || typeof n === 'number') { texts.push(String(n)); return; }
  if (Array.isArray(n)) { n.forEach(walk); return; }
  if (typeof n !== 'object') return;
  if (n.props?.className) classes.push(n.props.className);
  if (Array.isArray(n.kids)) n.kids.forEach(walk);
})(tree);
const joined = texts.join(' ');
console.log('\n[client] classes:', [...new Set(classes)].join(' '));
console.log('[client] text:', texts.filter(Boolean).join(' | ').slice(0, 620));

// --- 4. Assertions: host numbers must reach the rendered text -------------
// Values are derived from what the host actually returned, never hardcoded:
// this session is live, so its cost grows between runs.
const costStr = sessionJson.value.combined.cost.toFixed(2);
const ownStr = sessionJson.value.own.cost.toFixed(2);
const childStr = sessionJson.value.children[0].cost.toFixed(2);
const activePeriod = statusJson.value.period.peak ? 'peak' : 'offPeak';
const flash = statusJson.value.prices.find((p) => p.id === 'deepseek-flash');
const rates = flash[activePeriod];
// The table highlights only the column of the period in force right now.
const inactive = activePeriod === 'peak' ? flash.offPeak : flash.peak;
const checks = [
  ['balance total rendered', joined.includes(statusJson.value.balance.balances[0].total.toFixed(2))],
  ['granted rendered', joined.includes('7.62')],
  ['toppedUp rendered', joined.includes('30.50') || joined.includes('30.5')],
  ['active period label rendered', joined.includes(`period.${activePeriod}`)],
  ['active-period cacheHit rate rendered', joined.includes(String(rates.cacheHit))],
  ['active-period output rate rendered', joined.includes(String(rates.output))],
  ['session total cost rendered', joined.includes(costStr)],
  ['own-session cost rendered', joined.includes(ownStr)],
  ['child session cost rendered', joined.includes(childStr)],
  ['child session listed', joined.includes('session-child-demo')],
  // The per-request table was removed at the user's request.
  ['no per-request table', !joined.includes('turns.title')],
];
// Structural check: read the price table's rows straight out of the tree, so a
// rate the table happens to share with another number cannot fake a pass.
const rows = [];
(function collect(n) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach(collect);
  if (n.type === 'tr') rows.push(n);
  if (Array.isArray(n.kids)) n.kids.forEach(collect);
})(tree);
const cellText = (row) => {
  const out = [];
  (function walk(n) { if (n === null || n === undefined) return;
    if (typeof n === 'string' || typeof n === 'number') { out.push(String(n)); return; }
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== 'object') return;
    if (Array.isArray(n.kids)) n.kids.forEach(walk);
  })(row);
  return out;
};
const priceRows = rows.map(cellText).filter((cells) => cells.length === 4);
const flashRow = priceRows.find((cells) => cells[0] === 'DeepSeek-V4.1-Flash');
const proRow = priceRows.find((cells) => cells[0] === 'DeepSeek-V4-Pro');
// Each row must carry exactly the ACTIVE period's three rates, in order.
const expectRow = (row, model) => row !== undefined &&
  row[1] === String(model[activePeriod].cacheHit) &&
  row[2] === String(model[activePeriod].cacheMiss) &&
  row[3] === String(model[activePeriod].output);
checks.push(['flash row shows active-period rates exactly', expectRow(flashRow, flash)]);
checks.push(['pro row shows active-period rates exactly', expectRow(proRow, statusJson.value.prices.find((p) => p.id === 'deepseek-v4-pro'))]);
// 2 data rows + the header row, which also yields 4 cells.
checks.push(['price table has header + 2 data rows', priceRows.length === 3 && priceRows[0][0] === 'price.model']);

console.log('\n--- assertions (derived from live host output) ---');
console.log('price table rows rendered:', JSON.stringify(priceRows));
console.log(`active period=${activePeriod}; flash rates hit=${rates.cacheHit} miss=${rates.cacheMiss} out=${rates.output}`);
console.log(`session cost=${costStr} own=${ownStr} child=${childStr}`);
let ok = true;
for (const [label, pass_] of checks) { console.log(`${pass_ ? 'PASS' : 'FAIL'}  ${label}`); if (!pass_) ok = false; }
if (!ok) throw new Error('pipeline verification failed');
console.log('\nFULL PIPELINE VERIFIED: fixed host -> real served client bundle -> correct rendered values');
