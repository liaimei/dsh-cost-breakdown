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
    ok: true, status: 200, json: async () => (url.includes('/status') ? STATUS : SESSION),
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

console.log('wrote:\n' + shots.map((s) => '  ' + path.join(OUT, s)).join('\n'));
