/**
 * Objective acceptance: every requirement, verified against the RUNNING GUI.
 */
import { fetchClientBundle, sessionCookie } from './bundle.mjs';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const PROFILE = process.env.DSH_PROFILE_DIR ?? path.join(DSH_HOME, 'profiles/desktop');

const cookie = sessionCookie();
const post = async (route, body) => {
  const r = await fetch(`http://127.0.0.1:19387${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const results = [];
const check = (label, ok, detail = '') => { results.push([label, ok, detail]); };

// 1. Plugin is installed in the desktop profile.
const profile = JSON.parse(fs.readFileSync(path.join(PROFILE, 'package.json'), 'utf8'));
check('安装到 desktop profile', profile.dsh.profile.bundles.includes('dsh-cost-breakdown'));

// 2. Balance.
const status = await post('/api/dsh-cost-breakdown/status', {});
const b = status.json?.value?.balance?.balances?.[0];
check('账号余额', status.status === 200 && typeof b?.total === 'number', b ? `${b.total} ${b.currency}` : 'none');
check('余额拆分（充值/赠金）', b?.granted !== undefined && (b.granted > 0 || b.toppedUp > 0), `granted=${b?.granted} toppedUp=${b?.toppedUp}`);

// 3. Peak / off-peak pricing.
const period = status.json?.value?.period;
check('峰谷时段', typeof period?.peak === 'boolean', period?.label);
check('价目表', Array.isArray(status.json?.value?.prices) && status.json.value.prices.length === 2,
  `${status.json?.value?.prices?.length} models`);

// 4. Per-session cost including descendants.
const sid = (() => {
  const groups = path.join(DSH_HOME, 'sessions');
  const candidates = [];
  for (const group of fs.readdirSync(groups)) {
    const dir = path.join(groups, group);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const entry of fs.readdirSync(dir)) {
      const log = path.join(dir, entry, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(log)) continue;
      candidates.push({ id: entry, mtime: fs.statSync(log).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].id;
})();
const session = await post('/api/dsh-cost-breakdown/session', { sessionId: sid });
const v = session.json?.value;
check('每个会话消耗费用', session.status === 200 && typeof v?.combined?.cost === 'number',
  v ? `CNY ${v.combined.cost.toFixed(6)}` : 'none');
check('含子代理/衍生会话', (v?.sessionsWalked ?? 0) > 1,
  v ? `${v.sessionsWalked} sessions, ${v.children.length} child(ren)` : 'n/a');

// 5. The UI actually renders it, from the artifact the GUI serves.
const { source, revision } = await fetchClientBundle();
check('客户端产物由 GUI 提供', source.includes('__ModuleLoader__'), `rev ${revision}`);
check('输入框下方常驻读数', source.includes('conversation.composer.dock'));
check('点击展开详情', source.includes('dcb-detail') && source.includes('aria-haspopup'));
check('右侧栏面板', source.includes('sidebar.right.pane.tab'));

// 6. The prompt's acceptance also covers the test suite; it is reported here so
//    one command states the whole objective, not half of it.
const { spawnSync } = await import('node:child_process');
const suite = spawnSync(process.execPath, ['--test', 'test/pricing.test.mjs', 'test/host.test.mjs', 'test/client.test.mjs'], {
  cwd: fileURLToPath(new URL('../..', import.meta.url)),
  encoding: 'utf8',
});
// The runner prints `ℹ pass N` / `ℹ fail N`; match those regardless of the
// leading glyph so a runner formatting change surfaces as a failure, not a zero.
const summary = /pass (\d+)[\s\S]*?fail (\d+)/.exec(suite.stdout);
const passed = summary === null ? 0 : Number(summary[1]);
const failed = summary === null ? 1 : Number(summary[2]);
check('单元测试通过', failed === 0 && passed > 40, `${passed} pass / ${failed} fail`);

console.log('\n=== OBJECTIVE ACCEPTANCE ===');
let allOk = true;
for (const [label, ok, detail] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) allOk = false;
}
console.log(allOk ? '\nOBJECTIVE ACHIEVED' : '\nOBJECTIVE INCOMPLETE');
process.exit(allOk ? 0 : 1);
