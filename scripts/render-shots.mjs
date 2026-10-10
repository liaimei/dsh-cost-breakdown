/**
 * Render the plugin's real UI to HTML for screenshots.
 *
 * This does not mock anything: it evaluates `lib/client.js` (the artifact DSH
 * actually serves), renders its components through the same React harness the
 * tests use, then serializes the resulting element tree to HTML with the
 * plugin's own stylesheet plus DSH's real theme tokens.
 *
 * Usage: node scripts/render-shots.mjs <outdir>
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createReact, loadBundle, renderComponent } from '../test/e2e/react-stub.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OUT = process.argv[2] ?? path.join(ROOT, 'docs/assets');
fs.mkdirSync(OUT, { recursive: true });

const bundle = fs.readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8');

/** The plugin's own stylesheet, lifted verbatim out of the bundle. */
const pluginCss = /const CSS = `([\s\S]*?)`;/.exec(bundle)[1];
/**
 * DSH's real theme token layers. The served stylesheet only *consumes* these
 * tokens; their definitions are injected at runtime, so they are extracted from
 * the theme plugin's own string chunks (see docs/ in the repo for how).
 */
const themeCss = fs.readFileSync(path.join(ROOT, 'scripts/theme-tokens.css'), 'utf8');

const STATUS = {
  ok: true,
  value: {
    balance: { source: 'account', isAvailable: true, balances: [{ currency: 'CNY', total: 38.12, granted: 7.24, toppedUp: 30.88 }] },
    period: { peak: false, label: '空闲时段', next: { at: Date.now() + 45 * 3600_000 + 6 * 60_000, peak: true } },
    prices: [
      { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }, peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 } },
      { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro', offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 } },
    ],
  },
};

/**
 * The account-overview payload fixture.
 *
 * Days are derived from a fixed base so the chart has a believable shape; the
 * session titles are synthetic (never a real workspace path).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const at = (offsetDays) => {
  const d = new Date(Date.now() - offsetDays * DAY_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const shape = [2.4, 6.1, 3.2, 0, 0, 8.4, 5.5, 1.1, 4.3, 7.7, 2.2, 0, 6.9, 9.3, 3.6, 1.4, 5.1, 4.8, 7.1, 2.6, 0.9, 3.3, 6.4, 8.8, 4.1, 1.8, 5.9, 7.3, 3.7, 2.1];
const dayRows = shape.map((cost, i) => ({
  date: at(shape.length - 1 - i),
  cost,
  requests: Math.round(cost * 34),
  byPeriod: { peak: cost * 0.72, offPeak: cost * 0.28 },
  tokens: { input: 2_100_000, cacheRead: 88_000_000, output: 420_000, reasoning: 60_000, total: 91_000_000 },
}));
const sessionRows = [
  ['session-8234dc7b', '重构计价模块的缓存层', 6.4879, 602, false],
  ['session-954575d7', '排查上传接口的超时', 9.2757, 377, false],
  ['session-78d35f01', '设计插件市场收录流程', 17.7168, 1198, false],
  ['654a7c8f-f7b1', '调研 DSH 会话日志结构', 0.9553, 148, true],
  ['session-719ef8e9', '整理发布检查清单', 0.0433, 12, false],
  ['session-1226c5e2', '修复峰谷边界的取整', 0.0951, 11, false],
  ['01963a97-790c', '补齐衍生会话去重用例', 1.0993, 80, true],
  ['56912216-5fcf', '校对价目表数值', 0.6707, 48, true],
  ['53dbb2cd-ca58', '优化面板渲染性能', 0.4386, 40, true],
  ['e7e0c015-ed06', '补充 README 截图脚本', 0.4788, 42, true],
].map(([id, title, cost, requests, isChild]) => ({
  sessionId: id,
  title,
  createdAt: Date.now() - 3 * DAY_MS,
  lastActivity: Date.now() - DAY_MS,
  cost,
  requests,
  unpriced: 0,
  tokens: { input: 2_100_000, cacheRead: 88_000_000, output: 420_000, reasoning: 60_000, total: 91_000_000 },
  byPeriod: { peak: cost * 0.7, offPeak: cost * 0.3 },
  isChild,
}));

const OVERVIEW = {
  ok: true,
  value: {
    days: dayRows,
    sessions: sessionRows,
    totals: {
      cost: dayRows.reduce((sum, d) => sum + d.cost, 0),
      requests: dayRows.reduce((sum, d) => sum + d.requests, 0),
      unpriced: 0,
      byPeriod: {
        peak: dayRows.reduce((sum, d) => sum + d.byPeriod.peak, 0),
        offPeak: dayRows.reduce((sum, d) => sum + d.byPeriod.offPeak, 0),
      },
      tokens: { input: 63_000_000, cacheRead: 2_640_000_000, output: 12_600_000, reasoning: 1_800_000, total: 2_730_000_000 },
    },
    windowDays: 30,
    since: Date.now() - 30 * DAY_MS,
    sessionsRead: sessionRows.length,
    sessionsSkipped: 0,
    truncated: false,
    missing: 0,
    elapsedMs: 42,
  },
};

const SESSION = {
  ok: true,
  value: {
    sessionId: 'session-demo',
    own: {
      cost: 9.2757, requests: 377, unpriced: 0, unpricedModels: [],
      tokens: { input: 2_250_000, cacheRead: 105_820_000, output: 0, reasoning: 0, total: 108_530_000 },
      byPeriod: { peak: 11.5145, offPeak: 0.4552 },
    },
    children: [
      { sessionId: 'c1', title: 'Fix the flaky upload test', cost: 1.099, requests: 84 },
      { sessionId: 'c2', title: 'Refactor the pricing module', cost: 0.671, requests: 52 },
      { sessionId: 'c3', title: 'Investigate the memory spike', cost: 0.479, requests: 41 },
      { sessionId: 'c4', title: 'Draft the release notes', cost: 0.439, requests: 33 },
    ],
    combined: {
      cost: 11.9637, requests: 587, unpriced: 0, unpricedModels: [],
      tokens: { input: 2_250_000, cacheRead: 105_820_000, output: 0, reasoning: 0, total: 108_530_000 },
      byPeriod: { peak: 11.5145, offPeak: 0.4552 },
    },
    lineageTruncated: false,
  },
};

/** Escape text for HTML. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * React prop name -> HTML attribute name.
 *
 * React's `className` and `htmlFor` are the two props whose DOM names are not
 * just a case change; every other camelCase prop (SVG's `strokeDasharray`,
 * `strokeWidth`, `strokeDashoffset`) is kebab-cased. Getting `className` wrong
 * produced markup with `class-name="..."`, which parses as an unknown attribute
 * and leaves every selector unmatched — the page renders unstyled.
 */
function attrName(prop) {
  if (prop === 'className') return 'class';
  if (prop === 'htmlFor') return 'for';
  return prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** Serialize one rendered element tree into HTML. */
function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return esc(node);
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node !== 'object') return '';
  if (node.__el !== true) return '';
  const type = typeof node.type === 'string' ? node.type : 'span';
  const props = node.props ?? {};
  const attrs = [];
  // React's `style` object becomes an inline style string.
  if (props.style && typeof props.style === 'object') {
    const css = Object.entries(props.style)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${attrName(k)}:${v}`)
      .join(';');
    attrs.push(`style="${esc(css)}"`);
  }
  for (const [k, v] of Object.entries(props)) {
    if (k === 'children' || k === 'style' || v === undefined || v === null || typeof v === 'function') continue;
    const name = attrName(k);
    if (name === 'key' || name === 'ref') continue;
    attrs.push(`${name}="${esc(v)}"`);
  }
  const inner = toHtml(node.kids ?? props.children);
  const VOID = new Set(['circle', 'path', 'input', 'br', 'hr', 'img', 'rect', 'line']);
  if (VOID.has(type)) return `<${type} ${attrs.join(' ')}>`;
  return `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>${inner}</${type}>`;
}

/**
 * Drive the real bundle: apply() into the harness, then render a surface.
 *
 * The translate seat is built from the plugin's OWN registered dictionaries
 * rather than an identity stub: `apply()` calls `ctx.locale.register(NS, {zh,en})`,
 * so capturing that registration is what makes the screenshots show the shipped
 * Chinese copy instead of raw keys like `balance.title`.
 */
async function buildClient(locale = 'zh') {
  const harness = createReact();
  const client = loadBundle(vm, bundle, async (url) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (url.includes('/overview')) return OVERVIEW;
      if (url.includes('/status')) return STATUS;
      return SESSION;
    },
  }), 'react', harness.React);
  const slots = [];
  let dictionary = {};
  const surface = {
    effect: (fn) => { fn(); return () => {}; },
    locale: {
      register: (_ns, dictionaries) => { dictionary = dictionaries?.[locale] ?? {}; return () => {}; },
      bind: () => (key) => dictionary[key] ?? key,
    },
    inject: (_s, cb) => cb({
      sidebarRightTabs: { register: () => () => {} },
      slots: { inject: (_k, f) => f(), register: (options, component) => { slots.push({ options, component }); return () => {}; } },
    }),
  };
  client.exports.apply(surface);
  // `{name}` placeholders are how the plugin formats every count/amount.
  const t = (key, vars) => {
    let text = dictionary[key] ?? key;
    for (const [k, v] of Object.entries(vars ?? {})) text = text.replaceAll(`{${k}}`, String(v));
    return text;
  };
  const render = async (component, props) => renderComponent(harness, component, props);
  return { slots, t, render, dictionary };
}

/** The composer dock, optionally clicked open so the floating card renders. */
async function renderDock({ open }) {
  const { slots, t, render } = await buildClient();
  const dock = slots.find((s) => s.options.name === 'conversation.composer.dock');
  const props = { t, sessionId: 'session-demo' };
  let tree = await render(dock.component, props);
  if (open) {
    const find = (n) => {
      if (!n || typeof n !== 'object') return null;
      if (Array.isArray(n)) { for (const k of n) { const r = find(k); if (r) return r; } return null; }
      if (n.__el === true) {
        if (n.type === 'button' && typeof n.props?.onClick === 'function') return n;
        for (const k of n.kids ?? []) { const r = find(k); if (r) return r; }
      }
      return null;
    };
    const button = find(tree);
    if (button) button.props.onClick();
    tree = await render(dock.component, props);
  }
  return { slots, tree };
}

/** The right-sidebar panel body, rendered on its own. */
async function renderPanel() {
  const { slots, t, render } = await buildClient();
  const panel = slots.find((s) => s.options.name === 'sidebar.right.pane.tab');
  const tree = await render(panel.component, { t, sessionId: 'session-demo' });
  return tree;
}

/** The account overview page, rendered on its own. */
async function renderOverview() {
  const { slots, t, render } = await buildClient();
  const found = slots.find((s) => s.options.name === 'main');
  const tree = await render(found.component, { t });
  return tree;
}

/**
 * A full HTML page: real theme tokens, the plugin's own stylesheet, and the
 * rendered markup.
 *
 * `data-ds-dark-theme` goes on `<body>`, not `<html>`: DSH defines the token
 * layers on `body[data-ds-dark-theme]` while the plugin's light-theme override
 * is `body:not([data-ds-dark-theme])`. Putting the attribute on `<html>` leaves
 * both rules unmatched, so the render would silently fall back to the raw
 * 500-step palette instead of the legible 600/700 one.
 */
function page({ html, dark, width, extraCss = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
${themeCss}
${pluginCss}
html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base);}
body{width:${width}px;}
.dcb-dockTrigger{background:0 0;border:none;font-family:inherit;}
${extraCss}
</style></head><body${dark ? ' data-ds-dark-theme' : ''}>${html}</body></html>`;
}

const shots = [];

/**
 * The sidebar pane is roughly 670 CSS px wide in the shipped app (measured off
 * a 2x-DPR capture of the real panel), so the screenshots use that width rather
 * than an arbitrary one: at the wrong width the cards rewrap and the shot stops
 * representing what a user sees.
 */
const PANE_WIDTH = 670;

// 1. Sidebar panel, dark + light.
for (const dark of [true, false]) {
  const tree = await renderPanel();
  const name = `panel-${dark ? 'dark' : 'light'}.html`;
  fs.writeFileSync(path.join(OUT, name), page({
    html: `<div style="width:${PANE_WIDTH}px;padding:0;background:var(--dsw-specific-sidebar-fill)">${toHtml(tree)}</div>`,
    dark, width: PANE_WIDTH,
  }));
  shots.push(name);
}

// 2. Composer dock: collapsed readout, and expanded card.
//
// In the app the detail card is `position:fixed` and floats above the trigger.
// Here it is stacked below instead: simply making it static would leave it as a
// sibling inside the dock's `inline-flex` row, so the row would grow as wide as
// the card and the shot would clip. Stacking keeps the card at its real 380px.
for (const open of [false, true]) {
  const { tree } = await renderDock({ open });
  const name = `dock-${open ? 'expanded' : 'collapsed'}.html`;
  fs.writeFileSync(path.join(OUT, name), page({
    html: `<div style="padding:26px 22px">${toHtml(tree)}</div>`,
    dark: true, width: 460,
    extraCss: open
      ? '.dcb-dock{display:flex;flex-direction:column;align-items:flex-start;gap:14px}'
        + '.dcb-detail{position:static !important;visibility:visible !important;max-height:none !important}'
      : '',
  }));
  shots.push(name);
}

// 3. The account overview page, in both themes. It fills the central panel, so
// it is rendered a realistic width rather than the sidebar's.
for (const dark of [true, false]) {
  const tree = await renderOverview();
  const name = `overview-${dark ? 'dark' : 'light'}.html`;
  fs.writeFileSync(path.join(OUT, name), page({
    html: `<div style="width:1000px">${toHtml(tree)}</div>`,
    dark, width: 1000,
  }));
  shots.push(name);
}

console.log('wrote:\n' + shots.map((s) => '  ' + path.join(OUT, s)).join('\n'));
