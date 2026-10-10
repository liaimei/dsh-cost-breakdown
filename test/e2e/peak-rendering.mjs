/**
 * Peak-branch rendering proof: the same real client bundle, but with a status
 * payload whose period is PEAK, must highlight the peak column (0.04/2/8 and
 * 0.3/9/27) instead of the off-peak one.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import { fetchClientBundle } from './bundle.mjs';
import { createReact, loadBundle, renderComponent } from './react-stub.mjs';

// The served artifact, fetched from the running GUI (not the file on disk).
const { source, revision } = await fetchClientBundle();
console.log(`bundle: served revision ${revision}`);
const statusJson = JSON.parse(fs.readFileSync('/tmp/status.json', 'utf8'));
const sessionJson = JSON.parse(fs.readFileSync('/tmp/sess.json', 'utf8'));

// Flip the payload to peak, keeping the real price table.
statusJson.value.period = { peak: true, label: '高峰时段', next: { at: Date.now() + 3600_000, peak: false } };

let reg = null;
// The same shared stand-in the other suites use.
const r = createReact();
const fetchStub = async (u) => ({ ok: true, status: 200, json: async () => (u.includes('/status') ? statusJson : sessionJson) });
const loaded = loadBundle(vm, source, fetchStub, 'react', r.React);

let Comp = null;
loaded.exports.apply({ effect: (f) => { f(); return () => {}; }, locale: { register: () => () => {}, bind: () => (k) => k },
  inject: (s, cb) => cb({ sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (k, f) => { f(); return () => {}; }, register: (o, c) => { if (o.name === 'sidebar.right.pane.tab') Comp = c; return () => {}; } } }) });
if (Comp === null) throw new Error('panel component not registered');
const tree = await renderComponent(r, Comp, { t: (k) => k, sessionId: 'session-x' });

const rows = [];
(function c(n){ if(!n||typeof n!=='object')return; if(Array.isArray(n))return n.forEach(c); if(n.type==='tr')rows.push(n); if(Array.isArray(n.kids))n.kids.forEach(c); })(tree);
const cells = (row) => { const o=[]; (function w(n){ if(n==null)return; if(typeof n==='string'||typeof n==='number'){o.push(String(n));return;} if(Array.isArray(n))return n.forEach(w); if(typeof n!=='object')return; if(Array.isArray(n.kids))n.kids.forEach(w); })(row); return o; };
const priceRows = rows.map(cells).filter((r) => r.length === 4);
const text = []; (function w(n){ if(n==null)return; if(typeof n==='string'||typeof n==='number'){text.push(String(n));return;} if(Array.isArray(n))return n.forEach(w); if(typeof n!=='object')return; if(Array.isArray(n.kids))n.kids.forEach(w); })(tree);
const joined = text.join(' ');

console.log('peak rows:', JSON.stringify(priceRows));
const flash = priceRows.find((r) => r[0] === 'DeepSeek-V4.1-Flash');
const pro = priceRows.find((r) => r[0] === 'DeepSeek-V4-Pro');
const checks = [
  // The harness `t` is the identity on keys, so the badge renders its key.
  // Per-turn rows legitimately still say off-peak: those turns really were
  // billed off-peak, and the captured session payload is from then.
  ['peak badge shown (period.peak present)', joined.includes('period.peak')],
  ['flash row = peak rates 0.04/2/8', flash && flash[1] === '0.04' && flash[2] === '2' && flash[3] === '8'],
  ['pro row = peak rates 0.3/9/27', pro && pro[1] === '0.3' && pro[2] === '9' && pro[3] === '27'],
];
console.log('period-related keys in text:', text.filter((x) => /period|peak/i.test(x)).join(', '));
let ok = true;
for (const [l, p] of checks) { console.log(`${p ? 'PASS' : 'FAIL'}  ${l}`); if (!p) ok = false; }
if (!ok) throw new Error('peak rendering failed');
console.log('PEAK BRANCH VERIFIED: the table follows the period in force');
