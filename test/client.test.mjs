/**
 * Client-half tests.
 *
 * The client bundle is a factory-form CJS module, so it is executed the way the
 * DSH loader executes it: `window.__ModuleLoader__.load({ id, factory })`, with
 * `react` supplied as an external.
 *
 * This harness renders the real component tree. That matters because the defects
 * worth catching here are structural — an unstable hook dependency that refetches
 * forever, a slot registered under the wrong key — and a text-only assertion on
 * the source cannot see them.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

import { createDocument, createWindow } from './e2e/react-stub.mjs';

const BUNDLE = path.join(import.meta.dirname, '..', 'lib', 'client.js');

/**
 * Load the client bundle with a controllable React and fetch.
 * @param {{status?: object, session?: object}} data - canned route payloads.
 */
function loadClient(data = {}, observers = {}) {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  let registration = null;
  const calls = [];

  const document = createDocument();
  const sandbox = {
    window: createWindow({ load: (entry) => { registration = entry; } }),
    document,
    console,
    setInterval: (fn, ms) => { observers.onInterval?.(ms, fn); return 1; },
    clearInterval: () => {},
    fetch: async (url) => {
      calls.push(url);
      // A payload may be given directly or as a thunk, so a test can vary the
      // response over time (a period that flips mid-test, for instance).
      const source_ = url.includes('/status')
        ? (data.status ?? { ok: true, value: {} })
        : (data.session ?? { ok: true, value: null });
      const body = typeof source_ === 'function' ? source_() : source_;
      return { ok: true, status: 200, json: async () => body };
    },
    Promise, setTimeout, Date, Math, JSON, Number, String, Array, Object,
    isNaN, parseInt, parseFloat, AbortSignal, Request, Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  assert.ok(registration !== null, 'the bundle must register a module');
  assert.equal(registration.id, 'dsh-cost-breakdown');

  // A React whose hooks persist across renders, with real dependency comparison
  // for effects — without that, a dependency-identity bug cannot be observed.
  const hooks = [];
  const state = { cursor: 0, effects: [] };
  const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hookAt = () => {
    const index = state.cursor++;
    if (hooks[index] === undefined) hooks[index] = {};
    return hooks[index];
  };
  const React = {
    // React hands positional children to a component as `props.children`; the
    // stub must do the same, or a body passed that way renders empty.
    createElement: (type, props, ...kids) => {
      const flat = kids.flat().filter((kid) => kid !== null && kid !== undefined);
      const given = props ?? {};
      const children = flat.length === 0 ? given.children : flat.length === 1 ? flat[0] : flat;
      return { __el: true, type, props: { ...given, children }, kids: flat };
    },
    useState: (init) => {
      const slot = hookAt();
      if (!('value' in slot)) slot.value = typeof init === 'function' ? init() : init;
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
    // The shared store re-renders its subscribers through a reducer bump.
    useReducer: (reducer, init) => {
      const slot = hookAt();
      if (!('value' in slot)) slot.value = init;
      return [slot.value, (action) => { slot.value = reducer(slot.value, action); }];
    },
    useEffect: (fn, deps) => {
      const slot = hookAt();
      if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps?.slice();
        state.effects.push(fn);
      }
    },
    useCallback: (fn, deps) => {
      const slot = hookAt();
      if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps?.slice();
        slot.value = fn;
      }
      return slot.value;
    },
    useMemo: (fn, deps) => {
      const slot = hookAt();
      if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps?.slice();
        slot.value = fn();
      }
      return slot.value;
    },
    useRef: (init) => {
      const slot = hookAt();
      if (!('value' in slot)) slot.value = { current: init };
      return slot.value;
    },
    Fragment: 'Fragment',
  };
  const exports = registration.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected require: ${name}`);
  });

  // Drive apply() and capture what it registers.
  const tabs = [];
  const slots = [];
  const localeNamespaces = [];
  exports.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: {
      register: (ns) => { localeNamespaces.push(ns); return () => {}; },
      bind: () => (key) => key,
    },
    inject: (services, callback) => {
      callback({
        sidebarRightTabs: { register: (definition) => { tabs.push(definition); return () => {}; } },
        slots: {
          inject: (key, fn) => { fn(); return () => {}; },
          register: (options, component) => {
            slots.push({ options, component });
            return () => {};
          },
        },
      });
      return () => {};
    },
  });

  /**
   * Render one registered component: expand function components, run the
   * effects this render requested, let async reads settle, then render again so
   * assertions read the settled state. Effects whose dependencies stayed equal
   * do not re-run, which is what makes a dependency-identity bug observable.
   */
  const renderComponent = async (component, props, { runEffects = true } = {}) => {
    const expand = async (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return node;
      if (Array.isArray(node)) return Promise.all(node.map(expand));
      if (node.__el && typeof node.type === 'function') return expand(node.type(node.props));
      if (node.__el) return { ...node, kids: (await Promise.all(node.kids.map(expand))).flat() };
      return node;
    };
    const pass = async () => {
      state.cursor = 0;
      state.effects = [];
      return expand(component(props));
    };
    let tree = await pass();
    if (!runEffects) return tree;
    const pending = state.effects.map((fn) => {
      const result = fn();
      return result && typeof result.then === 'function' ? result : null;
    });
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The settled re-render. Its effects must RUN too, exactly as React would:
    // effects whose dependencies changed on account of the new state (a countdown
    // deadline appearing once status loads, for instance) only arm here.
    state.cursor = 0;
    state.effects = [];
    tree = await expand(component(props));
    for (const fn of state.effects) fn();
    return tree;
  };

  /** Render the right-Sidebar panel body. */
  const render = async (props, options) => {
    const panel = slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab')?.component;
    assert.ok(panel !== undefined, 'the panel must register into sidebar.right.pane.tab');
    return renderComponent(panel, props, options);
  };

  /** Every string in a rendered tree. */  /** The first element of one host tag in a rendered tree. */
  const findByType = (tree, type) => {
    let hit = null;
    (function walk(node) {
      if (hit !== null || node === null || node === undefined) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      if (node.__el === true && node.type === type) { hit = node; return; }
      if (Array.isArray(node.kids)) node.kids.forEach(walk);
    })(tree);
    return hit ?? undefined;
  };

  /** Every string in a rendered tree. */
  const textsOf = (tree) => {
    const out = [];
    (function walk(node) {
      if (node === null || node === undefined) return;
      if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return; }
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      if (Array.isArray(node.kids)) node.kids.forEach(walk);
    })(tree);
    return out;
  };

  /** Every host element of one tag in a rendered tree. */
  const findAllByType = (tree, type) => {
    const out = [];
    (function walk(node) {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      if (node.__el === true && node.type === type) out.push(node);
      if (Array.isArray(node.kids)) node.kids.forEach(walk);
    })(tree);
    return out;
  };

  return { exports, tabs, slots, localeNamespaces, calls, render, renderComponent, textsOf, state, findByType, findAllByType };
}

/** A status payload shaped like the host half's. */
const STATUS = {
  ok: true,
  value: {
    balance: { source: 'account', isAvailable: true, balances: [{ currency: 'CNY', total: 38.12, granted: 7.62, toppedUp: 30.5 }] },
    period: { peak: false, label: '空闲时段', next: { at: Date.now() + 3_600_000, peak: true } },
    prices: [
      { id: 'deepseek-flash', label: 'DeepSeek-V4.1-Flash', offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }, peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 } },
      { id: 'deepseek-v4-pro', label: 'DeepSeek-V4-Pro', offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 } },
    ],
    currency: 'CNY',
  },
};

/** A session payload shaped like the host half's. */
const SESSION = {
  ok: true,
  value: {
    sessionId: 'session-demo',
    title: 'demo',
    combined: {
      cost: 1.234, requests: 7, unpriced: 0, unpricedModels: [],
      tokens: { input: 1000, cacheRead: 90000, output: 500, total: 91500 },
      byModel: [], byPeriod: { peak: 0.5, offPeak: 0.734 }, turns: [],
    },
    own: { cost: 1.1, requests: 6, unpriced: 0, unpricedModels: [], tokens: { input: 900, cacheRead: 80000, output: 400, total: 81300 }, byModel: [], byPeriod: { peak: 0.4, offPeak: 0.7 }, turns: [
      { seq: 1, time: Date.now(), model: 'deepseek-flash', known: true, peak: false, cost: 0.01, tokens: { input: 10, cacheRead: 20, output: 5 } },
    ] },
    children: [{ sessionId: 'session-kid', title: 'subagent', cost: 0.134, requests: 1, tokens: { input: 100, cacheRead: 10000, output: 100, total: 10200 } }],
    sessionsWalked: 2, lineageTruncated: false, missing: 0, inheritedEventsSkipped: 0,
  },
};

/** A session payload carrying a full token breakdown, for the dashboard checks. */
const SESSION_WITH_TOKENS = {
  ok: true,
  value: {
    ...SESSION.value,
    combined: {
      ...SESSION.value.combined,
      tokens: { input: 490333, cacheRead: 183603456, output: 432697, reasoning: 432697, total: 184526486 },
      byPeriod: { peak: 0.31, offPeak: 5.89 },
    },
  },
};

test('the bundle registers the plugin contract', () => {
  const client = loadClient();
  assert.equal(client.exports.name, 'dsh-cost-breakdown');
  assert.equal(typeof client.exports.apply, 'function');
  assert.ok(Array.isArray(client.exports.inject));
});

test('apply contributes the locale namespace, the dock cell, and the tab bodies', () => {
  const client = loadClient();
  assert.deepEqual(client.localeNamespaces, ['dsh-cost-breakdown']);
  assert.equal(client.tabs.length, 1);
  assert.equal(client.tabs[0].id, 'dsh-cost-breakdown');
  assert.equal(client.tabs[0].kind, 'dsh-cost-breakdown');
  assert.equal(client.tabs[0].guide.length, 1);
  assert.equal(client.tabs[0].guide[0].id, 'dsh-cost-breakdown', 'a guide entry needs a stable id for its list key');

  const names = client.slots.map((slot) => slot.options.name).sort();
  assert.deepEqual(names, [
    'conversation.composer.dock',
    // The account overview: its page body plus the nav-row glyph that selects
    // it. Both are contributed under ONE id, which is the shell's pairing.
    'main',
    'sidebar.panellist',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ]);

  // The dock cell is a list entry: it needs a fresh `id` (NOT the tab's key) so
  // it lands beside the shipped stats cell instead of replacing it.
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  assert.equal(typeof dock.options.id, 'string');
  assert.notEqual(dock.options.id, 'stats', 'must not take over the shipped stats cell');
  assert.equal(dock.options.locale, 'dsh-cost-breakdown');

  // Tab bodies register under the tab TYPE id. The `main` page is keyed by its
  // own panel id instead (that is what selects which panel the nav row opens),
  // so this contract covers only the sidebar-right tab slots.
  for (const slot of client.slots.filter((entry) => entry.options.key !== undefined && entry.options.name.startsWith('sidebar.'))) {
    assert.equal(slot.options.key, 'dsh-cost-breakdown', 'each tab body registers under the tab type id');
    assert.equal(slot.options.locale, 'dsh-cost-breakdown');
  }

  // The overview pairs one id across the page body and its nav glyph; if those
  // two ever diverge, the nav row would open nothing.
  const page = client.slots.find((slot) => slot.options.name === 'main');
  const nav = client.slots.find((slot) => slot.options.name === 'sidebar.panellist');
  assert.equal(typeof page.options.key, 'string');
  assert.equal(page.options.key, nav.options.id, 'the page key and the nav id must match');
});

test('the tab title renders without a live session', () => {
  const client = loadClient();
  const title = client.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab.title').component;
  // The chip is a wrapper; expand it down to host nodes before reading text.
  const expand = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(expand);
    if (node.__el && typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, kids: (node.kids ?? []).map(expand) };
  };
  const texts = client.textsOf(expand(title({ t: (key) => key })));
  assert.ok(texts.includes('tab.title'), 'the chip shows its label');
});

test('the panel renders the balance, period and price table', async () => {
  const client = loadClient({ status: STATUS });
  const tree = await client.render({ t: (key) => key, sessionId: 'session-demo' }, { runEffects: true });
  const texts = client.textsOf(tree).join(' | ');
  assert.ok(texts.includes('38.12'), 'the balance total is rendered');
  assert.ok(texts.includes('7.62'), 'the granted part is rendered');
  assert.ok(texts.includes('30.50') || texts.includes('30.5'), 'the topped-up part is rendered');
  assert.ok(texts.includes('period.offPeak'), 'the period is rendered');
  assert.ok(texts.includes('0.02') && texts.includes('4.5'), 'both price rows are rendered');
});

test('the panel renders the session cost and its descendants', async () => {
  const client = loadClient({ status: STATUS, session: SESSION });
  const tree = await client.render({ t: (key) => key, sessionId: 'session-demo' }, { runEffects: true });
  const texts = client.textsOf(tree).join(' | ');
  // Totals and splits live in the cost card; the section below adds only the
  // per-child detail, so no figure is printed twice.
  assert.ok(texts.includes('1.23'), 'the combined cost is rendered');
  assert.ok(texts.includes('1.10'), 'the own-session cost is rendered in the cost card');
  assert.ok(texts.includes('0.13'), 'the descendant cost is rendered');
  assert.ok(texts.includes('subagent'), 'the descendant is listed');
  // The recent-request table was removed at the user's request: the card reports
  // totals, not a per-request log.
  assert.ok(!texts.includes('turns.title'), 'no per-request table is rendered');
});

test('the expanded card does not repeat the subtitle figures as plain rows', async () => {
  // The dashboard cards superseded several plain rows. A leftover duplicate reads
  // as two separate measurements that happen to agree, so assert the split lines
  // are gone: the total may appear in the collapsed cell AND the card header, but
  // the per-scope amounts must appear exactly once each.
  // Two children whose amounts differ, so an aggregate can be told apart from a
  // per-child line — with a single child the two coincide and prove nothing.
  const twoKids = {
    ok: true,
    value: {
      ...SESSION.value,
      children: [
        { sessionId: 'kid-a', title: 'alpha', cost: 0.3, requests: 3, tokens: {} },
        { sessionId: 'kid-b', title: 'beta', cost: 0.07, requests: 1, tokens: {} },
      ],
    },
  };
  const client = loadClient({ status: STATUS, session: twoKids });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const closed = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  client.findByType(closed, 'button').props.onClick();
  const texts = client.textsOf(await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' }));
  const joined = texts.join(' | ');

  // Each child's own amount appears once, in the per-child list.
  for (const [label, figure] of [['alpha', '0.300'], ['beta', '0.070']]) {
    const count = joined.split(figure).length - 1;
    assert.equal(count, 1, `${label}'s amount must appear exactly once, appeared ${count} times`);
  }
  // The aggregate (0.37) appears once, in the legend line.
  assert.equal(joined.split('0.370').length - 1, 1, 'the descendant aggregate appears once');
  // The combined total appears twice by design: collapsed cell + card header.
  assert.equal(joined.split('1.23').length - 1, 2, 'the total shows in the collapsed cell and the card header only');
});

test('the panel reads each route exactly once on open', async () => {
  // The poll effect must not fire on mount on top of the load effect: that
  // would double every open into two status reads.
  const client = loadClient({ status: STATUS, session: SESSION });
  await client.render({ t: (key) => key, sessionId: 'session-demo' }, { runEffects: true });
  const statusCalls = client.calls.filter((url) => url.includes('/status')).length;
  const sessionCalls = client.calls.filter((url) => url.includes('/session')).length;
  assert.equal(statusCalls, 1, `expected one status read, saw ${statusCalls}`);
  assert.equal(sessionCalls, 1, `expected one session read, saw ${sessionCalls}`);
});

test('an absent translate seat does not re-run the read effects', async () => {
  // The regression: an inline `(key) => key` fallback is a new function on every
  // render, so as an effect dependency it would refetch forever. Rendering twice
  // without the `t` seat and re-running effects must not add calls.
  const client = loadClient({ status: STATUS, session: SESSION });
  await client.render({ sessionId: 'session-demo' }, { runEffects: true });
  const afterFirst = client.calls.length;
  await client.render({ sessionId: 'session-demo' }, { runEffects: true });
  assert.equal(client.calls.length, afterFirst, 'the second render must not refetch');
});

test('a session with no billed requests says so instead of rendering nothing', async () => {
  const empty = {
    ok: true,
    value: {
      sessionId: 'session-demo', title: null,
      combined: { cost: 0, requests: 0, unpriced: 0, unpricedModels: [], tokens: { input: 0, cacheRead: 0, output: 0, total: 0 }, byModel: [], byPeriod: { peak: 0, offPeak: 0 }, turns: [] },
      own: { cost: 0, requests: 0, unpriced: 0, unpricedModels: [], tokens: { input: 0, cacheRead: 0, output: 0, total: 0 }, byModel: [], byPeriod: { peak: 0, offPeak: 0 }, turns: [] },
      children: [], sessionsWalked: 1, lineageTruncated: false, missing: 0, inheritedEventsSkipped: 0,
    },
  };
  const client = loadClient({ status: STATUS, session: empty });
  const tree = await client.render({ t: (key) => key, sessionId: 'session-demo' }, { runEffects: true });
  assert.ok(client.textsOf(tree).join(' ').includes('session.none'));
});

test('a failed read is explained instead of rendering blank', async () => {
  // `fetch` resolving non-JSON/null leaves the panel with no data; it must say
  // the log was unreadable rather than showing an empty card.
  const client = loadClient({ status: { ok: false }, session: { ok: false } });
  const tree = await client.render({ t: (key) => key, sessionId: 'session-demo' }, { runEffects: true });
  const texts = client.textsOf(tree).join(' ');
  assert.ok(texts.includes('common.error'), 'the failure is surfaced');
  assert.ok(texts.includes('session.unavailable'), 'the unreadable log is explained');
});

test('no session selected shows a neutral message, not a spinner', async () => {
  const client = loadClient({ status: STATUS });
  const tree = await client.render({ t: (key) => key, sessionId: '' }, { runEffects: true });
  const texts = client.textsOf(tree).join(' ');
  assert.ok(texts.includes('session.noSession'));
  assert.equal(client.calls.filter((url) => url.includes('/session')).length, 0, 'no session read without an id');
});

test('unknown models are marked unpriced rather than shown as free', async () => {
  const withUnknown = {
    ok: true,
    value: {
      ...SESSION.value,
      combined: { ...SESSION.value.combined, unpriced: 2, unpricedModels: ['glm-5'] },
    },
  };
  const client = loadClient({ status: STATUS, session: withUnknown });
  const tree = await client.render({ t: (key) => key, sessionId: 'session-demo' }, { runEffects: true });
  const texts = client.textsOf(tree).join(' ');
  assert.ok(texts.includes('glm-5'), 'the unlisted model is named');
});

test('an HTTP error on the session route degrades, keeping balance and prices', async () => {
  // Modelled on the real failure shape: the status route answers 200 while the
  // session route answers a bare HTTP 400 with an empty body. `post()` returns
  // null there, which must cost the panel only the session card.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  let registration = null;
  const document = createDocument();
  const sandbox = {
    window: createWindow({ load: (entry) => { registration = entry; } }),
    document, console, setInterval: () => 0, clearInterval: () => {},
    fetch: async (url) => (url.includes('/status')
      ? { ok: true, status: 200, json: async () => STATUS }
      : { ok: false, status: 400, json: async () => { throw new Error('empty body'); } }),
    Promise, setTimeout, Date, Math, JSON, Number, String, Array, Object,
    isNaN, parseInt, parseFloat, AbortSignal, Request, Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  const hooks = []; let effects = []; let cursor = 0;
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hookAt = () => { const i = cursor++; if (hooks[i] === undefined) hooks[i] = {}; return hooks[i]; };
  const React = {
    // React hands positional children to a component as `props.children`; the
    // stub must do the same, or a body passed that way renders empty.
    createElement: (type, props, ...kids) => {
      const flat = kids.flat().filter((kid) => kid !== null && kid !== undefined);
      const given = props ?? {};
      const children = flat.length === 0 ? given.children : flat.length === 1 ? flat[0] : flat;
      return { __el: true, type, props: { ...given, children }, kids: flat };
    },
    useState: (init) => { const slot = hookAt(); if (!('value' in slot)) slot.value = typeof init === 'function' ? init() : init;
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }]; },
    useReducer: (reducer, init) => { const slot = hookAt(); if (!('value' in slot)) slot.value = init;
      return [slot.value, (action) => { slot.value = reducer(slot.value, action); }]; },
    useEffect: (fn, deps) => { const slot = hookAt(); if (!same(slot.deps, deps)) { slot.deps = deps?.slice(); effects.push(fn); } },
    useCallback: (fn, deps) => { const slot = hookAt(); if (!same(slot.deps, deps)) { slot.deps = deps?.slice(); slot.value = fn; } return slot.value; },
    useMemo: (fn, deps) => { const slot = hookAt(); if (!same(slot.deps, deps)) { slot.deps = deps?.slice(); slot.value = fn(); } return slot.value; },
    useRef: (init) => { const slot = hookAt(); if (!('value' in slot)) slot.value = { current: init }; return slot.value; },
    Fragment: 'Fragment',
  };
  const exports = registration.factory((name) => { if (name === 'react') return React; throw new Error(`unexpected require: ${name}`); });
  let panel = null;
  exports.apply({
    effect: (fn) => { fn(); return () => {}; },
    locale: { register: () => () => {}, bind: () => (key) => key },
    inject: (services, callback) => {
      callback({
        sidebarRightTabs: { register: () => () => {} },
        slots: { inject: (key, fn) => { fn(); return () => {}; },
          register: (options, component) => { if (options.name === 'sidebar.right.pane.tab') panel = component; return () => {}; } },
      });
      return () => {};
    },
  });
  const expand = async (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (Array.isArray(node)) return Promise.all(node.map(expand));
    if (node.__el && typeof node.type === 'function') return expand(node.type(node.props));
    if (node.__el) return { ...node, kids: (await Promise.all(node.kids.map(expand))).flat() };
    return node;
  };
  const pass = async () => { cursor = 0; effects = []; return expand(panel({ t: (key) => key, sessionId: 'session-live' })); };
  await pass();
  await Promise.all(effects.map((fn) => { const r = fn(); return r && typeof r.then === 'function' ? r : null; }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  const tree = await pass();

  const texts = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return; }
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    if (Array.isArray(node.kids)) node.kids.forEach(walk);
  })(tree);
  const joined = texts.join(' ');
  assert.ok(joined.includes('38.12'), 'the balance survives the session failure');
  assert.ok(joined.includes('0.02'), 'the price table survives it');
  assert.ok(joined.includes('session.unavailable'), 'the unreadable session is explained');
  assert.ok(!joined.includes('dcb-hero'), 'no cost hero is drawn from missing data');
});

test('the dock cell shows this session cost, and expands to the details', async () => {
  // This is the surface the user asked for: spend under the composer, clicking
  // it reveals balance, the pricing period, and the cost breakdown.
  const client = loadClient({ status: STATUS, session: SESSION });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  assert.ok(dock !== undefined, 'the dock cell must be contributed');

  // Collapsed: the three headline figures, and none of the detail content.
  const texts = client.textsOf(await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' }));
  const collapsed = texts.join(' ');
  assert.ok(collapsed.includes('1.23'), 'the collapsed cell shows the session cost');
  assert.ok(collapsed.includes('38.12'), 'the collapsed cell shows the account balance');
  assert.ok(
    collapsed.includes('period.peak') || collapsed.includes('period.offPeak'),
    'the collapsed cell shows the pricing period',
  );
  assert.ok(!collapsed.includes('balance.title'), 'the detail card stays closed until clicked');

  // The trigger is a real button with popup semantics.
  const trigger = client.findByType(await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' }), 'button');
  assert.ok(trigger !== undefined, 'the cell renders a button');
  assert.equal(trigger.props['aria-haspopup'], 'dialog');
  assert.equal(trigger.props['aria-expanded'], false);

  // Expanded: the click toggles open state, and the detail card carries the rest.
  trigger.props.onClick();
  const opened = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  const open = client.textsOf(opened).join(' ');
  assert.ok(open.includes('balance.title'), 'balance appears in the detail card');
  assert.ok(open.includes('period.offPeak'), 'the pricing period appears');
  assert.ok(open.includes('0.02') && open.includes('4.5'), 'the price table appears');
  assert.ok(open.includes('session.own'), 'the own/descendant breakdown appears');
});

test('the dock cell does not show a misleading zero before the first read', async () => {
  // An optimistic ¥0.00 would flash on every mount and read as "free", so the
  // cell must say it is still reading until a report actually arrives.
  const client = loadClient({ status: STATUS, session: SESSION });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  // Render WITHOUT running effects: this is the pre-read frame.
  const texts = client.textsOf(await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' }, { runEffects: false }));
  const joined = texts.join(' ');
  assert.ok(joined.includes('dock.loading'), 'it says it is still reading');
  assert.ok(!joined.includes('¥0.00'), 'it never claims a zero cost it has not measured');
});

test('both surfaces share one store, so a session is read once', async () => {
  // Two independent pollers would double the (expensive) session fold and could
  // show different numbers side by side.
  const client = loadClient({ status: STATUS, session: SESSION });
  const panel = client.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab').component;
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock').component;
  await client.renderComponent(panel, { t: (key) => key, sessionId: 'session-demo' });
  const afterPanel = client.calls.length;
  await client.renderComponent(dock, { t: (key) => key, sessionId: 'session-demo' });
  assert.equal(client.calls.length, afterPanel, 'the second surface reuses the first read');
});

test('the collapsed dock row shows all three figures with separators', async () => {
  // The requested readout: session spend, account balance, and the pricing
  // period, all visible without opening anything.
  const client = loadClient({ status: STATUS, session: SESSION });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const withLabels = (key) =>
    ({ 'period.peak': '高峰时段', 'period.offPeak': '空闲时段' })[key] ?? key;
  const texts = client.textsOf(
    await client.renderComponent(dock.component, { t: withLabels, sessionId: 'session-demo' }),
  ).join(' ');
  // Order matters: spend, then balance, then the period badge.
  const order = [texts.indexOf('¥1.23'), texts.indexOf('¥38.12'), texts.indexOf('空闲时段')];
  assert.ok(order.every((at) => at >= 0), `all three figures render: ${texts}`);
  assert.ok(order[0] < order[1] && order[1] < order[2], 'they appear in spend → balance → period order');
  assert.ok(texts.includes('·'), 'the figures are separated by a dot');
});

test('the detail card uses the shipped menu surface, not an ad-hoc background', () => {
  // The user asked for the expanded panel to match the rest of the app. It
  // reuses DSH's own menu tokens rather than a hand-picked colour, so it tracks
  // the light/dark theme and matches the shipped Token-usage popover exactly.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const rule = /\.dcb-detail\{([^}]*)\}/.exec(source);
  assert.ok(rule !== null, 'the detail-card rule must exist');
  const css = rule[1];
  assert.ok(css.includes('background:var(--dsw-specific-menu)'), 'menu surface token');
  assert.ok(css.includes('box-shadow:var(--dsw-elevation-prominent)'), 'prominent elevation token');
  assert.ok(css.includes('border-radius:var(--dsw-radius-lg)'), 'large radius token');
  assert.ok(css.includes('backdrop-filter:var(--dsw-menu-backdrop-filter)'), 'menu backdrop token');
  assert.ok(css.includes('position:fixed'), 'fixed, so the composer cannot clip it');
  assert.ok(!/background:#/.test(css), 'no hard-coded colour');
});

test('the detail card presents token usage in the dashboard idiom', async () => {
  // The user asked for the expanded detail to read like the shipped Context
  // dashboard: a labelled total, a semantic ring, and a legend with shares.
  const client = loadClient({ status: STATUS, session: SESSION_WITH_TOKENS });
  // The dock's expanded card is the surface the user reads; render that.
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const closed = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  client.findByType(closed, 'button').props.onClick();
  const tree = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  const joined = client.textsOf(tree).join(' | ');
  assert.ok(joined.includes('tokens.title'), 'the token section is titled');
  assert.ok(joined.includes('tokens.hitRate'), 'the cache-hit rate is shown');
  assert.ok(joined.includes('tokens.cacheHit') && joined.includes('tokens.cacheMiss') && joined.includes('tokens.output'),
    'all three billed buckets are listed');
  assert.ok(joined.includes('184.53M'), `the total token count is rendered: ${joined.slice(0, 200)}`);
  assert.ok(joined.includes('cost.title'), 'the cost breakdown is titled');

  // The ring is drawn with one circle per non-zero bucket, coloured by the
  // semantic scale rather than an ad-hoc hue.
  const circles = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    if (node.type === 'circle' && node.props?.stroke !== undefined) circles.push(node.props);
    if (Array.isArray(node.kids)) node.kids.forEach(walk);
  })(tree);
  assert.equal(circles.length, 3, 'three ring segments');
  for (const circle of circles) {
    assert.match(circle.stroke, /var\(--dcb-[a-z]+\)/, 'segments use this plugin\'s own colour scale');
    assert.equal(circle.r, 15.9155, 'the radius that makes the circumference 100');
  }
  // Dash lengths are percentages of the ring, so they must sum to 100.
  const sum = circles.reduce((acc, circle) => acc + Number(String(circle.strokeDasharray).split(' ')[0]), 0);
  assert.ok(Math.abs(sum - 100) < 1e-6, `dashes must cover the ring exactly (got ${sum})`);
});

test('the dashboard sections are absent when there is nothing measured', async () => {
  // No billed requests means no token data; the card must not draw an empty ring
  // or a 0% legend, which would read as measured zeros.
  const empty = {
    ok: true,
    value: {
      sessionId: 'session-demo', combined: null, own: null, children: [],
      sessionsWalked: 1, lineageTruncated: false, missing: 0, inheritedEventsSkipped: 0,
    },
  };
  const client = loadClient({ status: STATUS, session: empty });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const tree = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  client.findByType(tree, 'button').props.onClick();
  const opened = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  const joined = client.textsOf(opened).join(' ');
  assert.ok(!joined.includes('tokens.title'), 'no token ring without token data');
  assert.ok(!joined.includes('cost.title'), 'no cost breakdown without cost data');
});

test('both surfaces show the same dashboard cards', async () => {
  // The panel and the dock share the card builders, so a figure can never be
  // formatted one way in one place and another way in the other.
  const client = loadClient({ status: STATUS, session: SESSION_WITH_TOKENS });
  const panel = client.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab').component;
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock').component;

  const panelProps = { t: (key) => key, sessionId: 'session-demo' };
  const panelText = client.textsOf(await client.renderComponent(panel, panelProps)).join(' ');
  // The dock's detail is a popover: it starts closed, so open its trigger. Its
  // cards inside are never folded, so nothing further needs clicking.
  const closed = await client.renderComponent(dock, panelProps);
  client.findByType(closed, 'button').props.onClick();
  const dockText = client.textsOf(await client.renderComponent(dock, panelProps)).join(' ');

  for (const [name, text] of [['panel', panelText], ['dock', dockText]]) {
    assert.ok(text.includes('tokens.title'), `${name} shows the token card`);
    assert.ok(text.includes('cost.title'), `${name} shows the cost card`);
    assert.ok(text.includes('184.53M'), `${name} shows the same token total`);
    assert.ok(text.includes('99.5%'), `${name} shows the same cache-hit rate`);
  }
});

test('the ring omits a bucket that billed nothing rather than drawing a zero arc', async () => {
  // A zero-value arc is invisible anyway, but leaving it in makes the ring's
  // segment count lie about how many buckets were actually billed.
  const noCache = {
    ok: true,
    value: {
      ...SESSION_WITH_TOKENS.value,
      combined: { ...SESSION_WITH_TOKENS.value.combined, tokens: { input: 1000, cacheRead: 0, output: 500, reasoning: 0, total: 1500 } },
    },
  };
  const client = loadClient({ status: STATUS, session: noCache });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const closed = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  client.findByType(closed, 'button').props.onClick();
  const tree = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  const circles = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    if (node.type === 'circle' && node.props?.stroke !== undefined) circles.push(node.props);
    if (Array.isArray(node.kids)) node.kids.forEach(walk);
  })(tree);
  assert.equal(circles.length, 2, 'only the two billed buckets get an arc');
  const sum = circles.reduce((acc, circle) => acc + Number(String(circle.strokeDasharray).split(' ')[0]), 0);
  assert.ok(Math.abs(sum - 100) < 1e-6, 'the remaining arcs still cover the ring');
});

test('the pricing period reads 峰/谷, with peak red and valley green', async () => {
  // The requested convention: short labels, and the expensive window marked in
  // red while the cheap one is green.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /'period\.peak': '峰'/, 'the peak label is 峰');
  assert.match(source, /'period\.offPeak': '谷'/, 'the valley label is 谷');
  assert.match(source, /peak: 'var\(--dcb-red\)'/, 'peak is red');
  assert.match(source, /offPeak: 'var\(--dcb-green\)'/, 'valley is green');
  // The badge must agree with the ring, not contradict it.
  const badge = /\.dcb-badge-peak\{([^}]*)\}/.exec(source);
  assert.ok(badge !== null, 'the peak badge rule exists');
  assert.ok(badge[1].includes('state-error-primary'), 'the peak badge is the error (red) tone');
});

test('the period badge does not inherit the composer row height', async () => {
  // The regression: `.dcb-badge` set its own 11px font but no line-height, so it
  // inherited `.dcb-dockTrigger`'s 20px line-height (that rule is sized for 13px
  // text). The pill then measured 20 + 2*2 + 2*1 = 26px tall inside a 20px row —
  // taller than the row it sits in, and visibly oversized beside 9px digits.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const badge = /\.dcb-badge\{([^}]*)\}/.exec(source);
  assert.ok(badge !== null, 'the badge rule exists');
  const css = badge[1];
  assert.ok(css.includes('line-height:'), 'the badge declares its own line-height');

  const lineHeight = Number(/(?:^|;)line-height:(\d+(?:\.\d+)?)px/.exec(css)?.[1] ?? NaN);
  const padding = /(?:^|;)padding:(\d+(?:\.\d+)?)px (\d+(?:\.\d+)?)px/.exec(css);
  assert.ok(Number.isFinite(lineHeight), `parsable badge line-height (got ${css})`);
  assert.ok(padding !== null, 'the badge padding is parsable');
  // One 1px border per side is part of the box.
  const height = lineHeight + Number(padding[1]) * 2 + 2;
  const rowLineHeight = Number(/\.dcb-dockTrigger\{[^}]*line-height:calc\((\d+)px/.exec(source)?.[1] ?? NaN);
  assert.ok(Number.isFinite(rowLineHeight), 'the composer row line-height is parsable');
  assert.ok(
    height <= rowLineHeight,
    `the badge (${height}px) must not exceed the composer row (${rowLineHeight}px)`,
  );
});

test('the period badge and legend colours agree in both periods', async () => {
  const withPeriod = (peak) => ({
    ok: true,
    value: {
      ...STATUS.value,
      period: { peak, label: peak ? '高峰时段' : '空闲时段', next: { at: Date.now() + 3_600_000, peak: !peak } },
    },
  });
  const labels = { 'period.peak': '峰', 'period.offPeak': '谷' };
  const t = (key) => labels[key] ?? key;

  for (const [peak, label, colour, badge] of [
    [true, '峰', 'var(--dcb-red)', 'dcb-badge-peak'],
    [false, '谷', 'var(--dcb-green)', 'dcb-badge-off'],
  ]) {
    const client = loadClient({ status: withPeriod(peak), session: SESSION });
    const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
    const closed = await client.renderComponent(dock.component, { t, sessionId: 'session-demo' });
    const collapsed = client.textsOf(closed).join(' ');
    assert.ok(collapsed.includes(label), `the collapsed cell reads ${label}`);

    // The legend lives in the expanded card, so open it first.
    client.findByType(closed, 'button').props.onClick();
    const tree = await client.renderComponent(dock.component, { t, sessionId: 'session-demo' });
    const marks = [];
    (function walk(node) {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      if (node.props?.style?.background) marks.push(node.props.style.background);
      if (typeof node.props?.className === 'string' && node.props.className.includes('dcb-badge')) marks.push(node.props.className);
      if (Array.isArray(node.kids)) node.kids.forEach(walk);
    })(tree);
    assert.ok(marks.includes(colour), `the period legend uses ${colour}`);
    assert.ok(marks.some((mark) => typeof mark === 'string' && mark.includes(badge)), `the badge uses the ${badge} tone`);
  }
});

test('every colour the charts use is declared by this plugin', () => {
  // The bug this guards: the chart palette (`--color-*-500`) is NOT part of DSH's
  // token set — it came from another plugin's global `:root`. Referencing it left
  // this plugin coloured only while that plugin happened to be installed.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const used = new Set([...source.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
  const foreign = [...used].filter((name) => name.startsWith('--color-'));
  assert.deepEqual(foreign, [], `these variables are not DSH tokens: ${foreign.join(', ')}`);

  // Coloured text must stay legible when the light theme is in force: the 500
  // steps are too light on a pale surface (yellow especially), so a light-theme
  // override block has to re-declare them at a darker step.
  assert.match(source, /body:not\(\[data-ds-dark-theme\]\)\{/, 'light-theme overrides exist');
  const lightBlock = /body:not\(\[data-ds-dark-theme\]\)\{([^}]*)\}/.exec(source);
  for (const name of ['--dcb-yellow', '--dcb-blue', '--dcb-purple', '--dcb-red', '--dcb-green']) {
    assert.ok(lightBlock[1].includes(`${name}:`), `${name} is overridden for the light theme`);
  }

  // Every chart colour must be declared in this bundle's own stylesheet.
  const declared = new Set([...source.matchAll(/^\s*(--dcb-[a-z]+):/gm)].map((match) => match[1]));
  const needed = ['--dcb-red', '--dcb-green', '--dcb-amber', '--dcb-blue', '--dcb-purple', '--dcb-yellow', '--dcb-orange', '--dcb-violet', '--dcb-teal', '--dcb-neutral'];
  for (const name of needed) {
    assert.ok(declared.has(name), `${name} must be declared by this plugin`);
  }
});

test('the countdown ticker is armed by whichever surface is mounted', async () => {
  // The regression: the 1-second ticker lived inside the panel component, so the
  // dock's "距离切换到…还有…" line froze between minute-long balance polls. The
  // ticker now belongs to the shared store, so mounting EITHER surface arms it.
  const scheduled = [];
  const client = loadClient({ status: STATUS, session: SESSION }, {
    onInterval: (ms) => scheduled.push(ms),
  });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  assert.ok(scheduled.includes(1000), `the dock must arm a 1s ticker (saw ${JSON.stringify(scheduled)})`);

  // And the sidebar panel must not arm a second one: one store, one ticker.
  const before = scheduled.filter((ms) => ms === 1000).length;
  const panel = client.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab').component;
  await client.renderComponent(panel, { t: (key) => key, sessionId: 'session-demo' });
  const after = scheduled.filter((ms) => ms === 1000).length;
  assert.equal(after, before, 'the second surface reuses the store\'s existing ticker');
});

test('the balance rows are colour-coded: total yellow, granted blue, topped up purple', async () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /balance: 'var\(--dcb-yellow\)'/, 'the balance total is yellow');
  assert.match(source, /granted: 'var\(--dcb-blue\)'/, 'the granted part is blue');
  assert.match(source, /toppedUp: 'var\(--dcb-purple\)'/, 'the topped-up part is purple');

  const client = loadClient({ status: STATUS, session: SESSION });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const closed = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  client.findByType(closed, 'button').props.onClick();
  const tree = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });

  // Each of the three figures leads with its own colour dot.
  const dots = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    if (typeof node.props?.className === 'string' && node.props.className.includes('dcb-ldot') && node.props.style?.background) {
      dots.push(node.props.style.background);
    }
    if (Array.isArray(node.kids)) node.kids.forEach(walk);
  })(tree);
  for (const [label, colour] of [['total', 'var(--dcb-yellow)'], ['granted', 'var(--dcb-blue)'], ['topped-up', 'var(--dcb-purple)']]) {
    assert.ok(dots.includes(colour), `the ${label} row carries its dot (${colour})`);
  }

  // The figures themselves are tinted to match.
  const texts = client.textsOf(tree).join(' ');
  assert.ok(texts.includes('38.12'), 'the total renders');
  assert.ok(texts.includes('7.62'), 'the granted part renders');
});

test('the price table names the period it is quoting', async () => {
  // Showing one period's rates without saying which invites reading the wrong row.
  for (const [peak, label, colour] of [[false, '谷', 'var(--dcb-green)'], [true, '峰', 'var(--dcb-red)']]) {
    const status = {
      ok: true,
      value: {
        ...STATUS.value,
        period: { peak, label: peak ? '高峰时段' : '空闲时段', next: { at: Date.now() + 3_600_000, peak: !peak } },
      },
    };
    const labels = { 'period.peak': '峰', 'period.offPeak': '谷' };
    const t = (key) => labels[key] ?? key;
    const client = loadClient({ status, session: SESSION });
    const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
    const closed = await client.renderComponent(dock.component, { t, sessionId: 'session-demo' });
    client.findByType(closed, 'button').props.onClick();
    const tree = await client.renderComponent(dock.component, { t, sessionId: 'session-demo' });

    const joined = client.textsOf(tree).join(' ');
    assert.ok(joined.includes(`price.title · ${label}`), `the price header names ${label}: ${joined.slice(0, 160)}`);

    // And the quoted rates are the ones for that period.
    const flash = STATUS.value.prices.find((row) => row.id === 'deepseek-flash');
    const rates = flash[peak ? 'peak' : 'offPeak'];
    for (const rate of [rates.cacheHit, rates.cacheMiss, rates.output]) {
      assert.ok(joined.includes(String(rate)), `${label} table quotes ${rate}`);
    }
  }
});

test('the remaining-time text actually counts down', async () => {
  // The property the user cares about: the string must move. Assert the value,
  // not merely that a ticker was armed.
  const realNow = Date.now;
  const start = realNow.call(Date);
  const labels = {
    'period.until': '距离切换到「{next}」还有 {time}',
    'period.peak': '峰',
    'period.offPeak': '谷',
  };
  const t = (key) => labels[key] ?? key;
  const status = {
    ok: true,
    value: {
      ...STATUS.value,
      period: { peak: false, label: '空闲时段', next: { at: start + 3 * 3_600_000 + 25_000, peak: true } },
    },
  };
  const client = loadClient({ status, session: SESSION });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const closed = await client.renderComponent(dock.component, { t, sessionId: 'session-demo' });
  client.findByType(closed, 'button').props.onClick();
  // The countdown moved into a tile: the label names the target, the value holds
  // the remaining time, so read both and compare the time part.
  const readCountdown = (tree) => {
    const texts = client.textsOf(tree).map(String);
    const at = texts.findIndex((text) => text.startsWith('距离切换到'));
    return at < 0 ? '' : [texts[at], texts[at + 1]].filter(Boolean).join(' ');
  };

  const first = readCountdown(await client.renderComponent(dock.component, { t, sessionId: 'session-demo' }));
  assert.match(first, /还有 .+/, `the countdown renders: ${first}`);

  // Advance the clock past a minute and re-render: the text must differ.
  Date.now = () => start + 61_000;
  let second;
  try {
    second = readCountdown(await client.renderComponent(dock.component, { t, sessionId: 'session-demo' }));
  } finally {
    Date.now = realNow;
  }
  assert.match(second, /还有 .+/, `the countdown still renders: ${second}`);
  assert.notEqual(second, first, 'the remaining time must change as the clock advances');
  assert.ok(!first.includes('3 小时 0 分') || !second.includes('3 小时 0 分'), 'the minutes must move, not just re-render');
});

test('every section is a card carrying a colour accent', async () => {
  // The requested shape: carded sections with colour, not a wall of plain rows.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  // The accent now tints the card's HEADING rather than drawing a bar down its
  // side; each accent must still resolve to a hue from this plugin's own scale.
  assert.ok(!source.includes('.dcb-card2::before'), 'no coloured spine is drawn');
  for (const [accent, colour] of [
    ['balance', '--dcb-yellow'], ['granted', '--dcb-blue'], ['toppedUp', '--dcb-purple'],
    ['peak', '--dcb-red'], ['offPeak', '--dcb-green'], ['tokens', '--dcb-green'],
    ['cost', '--dcb-blue'], ['price', '--dcb-teal'],
  ]) {
    assert.ok(
      new RegExp(`\\.dcb-card2\\[data-accent="${accent}"\\]>\\.dcb-head2\\{--dcb-accent:var\\(${colour}\\)\\}`).test(source),
      `the ${accent} heading tints to ${colour}`,
    );
  }

  const client = loadClient({ status: STATUS, session: SESSION_WITH_TOKENS });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const closed = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
  client.findByType(closed, 'button').props.onClick();
  const tree = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });

  const accents = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    if (node.props?.['data-accent'] !== undefined) accents.push(node.props['data-accent']);
    if (Array.isArray(node.kids)) node.kids.forEach(walk);
  })(tree);
  // The three data-heavy sections are cards; the balance and the pricing period
  // are deliberately compact rows, so they carry a colour dot rather than a card.
  for (const accent of ['tokens', 'cost', 'price']) {
    assert.ok(accents.includes(accent), `the ${accent} card is rendered`);
  }
  assert.ok(!accents.includes('balance'), 'the balance stays a compact row');
});

test('a peak period turns the badge red, a valley period green', async () => {
  // The period is a compact row whose badge carries the colour, so switching to a
  // peak window must swap the tone rather than leave an off-peak green behind.
  for (const [peak, badge, other] of [
    [true, 'dcb-badge-peak', 'dcb-badge-off'],
    [false, 'dcb-badge-off', 'dcb-badge-peak'],
  ]) {
    const status = {
      ok: true,
      value: {
        ...STATUS.value,
        period: { peak, label: peak ? '高峰时段' : '空闲时段', next: { at: Date.now() + 3_600_000, peak: !peak } },
      },
    };
    const client = loadClient({ status, session: SESSION });
    const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
    const closed = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });
    client.findByType(closed, 'button').props.onClick();
    const tree = await client.renderComponent(dock.component, { t: (key) => key, sessionId: 'session-demo' });

    const badges = [];
    (function walk(node) {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      if (typeof node.props?.className === 'string' && node.props.className.includes('dcb-badge')) {
        badges.push(node.props.className);
      }
      if (Array.isArray(node.kids)) node.kids.forEach(walk);
    })(tree);
    assert.ok(badges.some((name) => name.includes(badge)), `peak=${peak} uses the ${badge} tone`);
    assert.ok(!badges.some((name) => name.includes(other)), `peak=${peak} must not also use the ${other} tone`);

    // The legend that reports the split uses the matching hue, so the badge and
    // the chart agree on which period is which.
    const colours = [];
    (function walk(node) {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      if (node.props?.style?.background) colours.push(node.props.style.background);
      if (Array.isArray(node.kids)) node.kids.forEach(walk);
    })(tree);
    const expected = peak ? 'var(--dcb-red)' : 'var(--dcb-green)';
    assert.ok(colours.includes(expected), `the peak legend uses ${expected}`);
  }
});

test('no function is defined twice in the bundle', () => {
  // The bug this guards: earlier edits left a whole dead copy of the component
  // region. JavaScript keeps the LAST definition, so the live behaviour came from
  // the second copy while the first sat there looking authoritative — editing it
  // would silently change nothing. Duplicates are always a mistake here.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const seen = new Map();
  const duplicates = [];
  for (const match of source.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
    const name = match[1];
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 2) duplicates.push(name);
  }
  assert.deepEqual(duplicates, [], `these functions are defined more than once: ${duplicates.join(', ')}`);

  // The same hazard for the region markers that delimit the file's sections.
  for (const marker of ['#region dashboard cards', '#region dashboard parts', '#region bottom bar', '#region apply']) {
    const hits = source.split(marker).length - 1;
    assert.equal(hits, 1, `${marker} must appear exactly once, appeared ${hits} times`);
  }
});

test('detail cards are always expanded — no folded state', async () => {
  // The user asked to keep the card headings but drop the folding, so every
  // figure a card reports must be on screen without any interaction.
  const client = loadClient({ status: STATUS, session: SESSION_WITH_TOKENS });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const props = { t: (key) => key, sessionId: 'session-demo' };

  const closed = await client.renderComponent(dock.component, props);
  client.findByType(closed, 'button').props.onClick();
  const tree = await client.renderComponent(dock.component, props);
  const texts = client.textsOf(tree).join(' ');

  // The headings are text, not controls: nothing inside a card is a button.
  const headingButtons = client
    .findAllByType(tree, 'button')
    .filter((node) => String(node.props.className ?? '').includes('dcb-head2'));
  assert.deepEqual(headingButtons, [], 'the card headings are not buttons');

  const chevrons = client
    .findAllByType(tree, 'span')
    .filter((node) => String(node.props.className ?? '').includes('dcb-chev'));
  assert.deepEqual(chevrons, [], 'no chevron is rendered');

  // Every heading AND its detail are visible at once.
  for (const needle of ['tokens.title', '184.53M', 'cost.title', 'price.title', 'price.model']) {
    assert.ok(texts.includes(needle), `${needle} is visible without any interaction`);
  }
});


test('the period switches by itself when the window flips', async () => {
  // The user asked whether 峰/谷 is hardcoded. It is computed from the clock, and
  // the panel must follow the flip without a reload: the countdown ticker, on
  // reaching the deadline, re-reads the host and the badge changes.
  const realNow = Date.now;
  const start = realNow.call(Date);
  const flipAt = start + 3_000;
  let hostPeak = false;
  const intervals = [];

  const status = () => ({
    ok: true,
    value: {
      ...STATUS.value,
      period: hostPeak
        ? { peak: true, label: '高峰时段', next: { at: flipAt + 3_600_000, peak: false } }
        : { peak: false, label: '空闲时段', next: { at: flipAt, peak: true } },
    },
  });

  const client = loadClient({ status, session: SESSION }, { onInterval: (ms, fn) => intervals.push({ ms, fn }) });
  const labels = { 'period.peak': '峰', 'period.offPeak': '谷', 'period.until': '距离切换到「{next}」还有 {time}' };
  const t = (key) => labels[key] ?? key;
  const props = { t, sessionId: 'session-demo' };
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');

  const badgeOf = (tree) => {
    let found = null;
    (function walk(node) {
      if (found !== null || node === null || node === undefined) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;
      if (typeof node.props?.className === 'string' && node.props.className.includes('dcb-badge')) found = node.props.className;
      if (Array.isArray(node.kids)) node.kids.forEach(walk);
    })(tree);
    return found ?? '';
  };

  // The period row lives in the dock's expanded detail card.
  const closed = await client.renderComponent(dock.component, props);
  client.findByType(closed, 'button').props.onClick();
  let tree = await client.renderComponent(dock.component, props);
  assert.ok(badgeOf(tree).includes('dcb-badge-off'), `starts in the valley (badge=${badgeOf(tree)})`);

  // A 1s ticker must be armed so the countdown can notice the deadline.
  const ticker = intervals.find((entry) => entry.ms === 1_000);
  assert.ok(ticker !== undefined, `a 1s ticker is armed (saw ${JSON.stringify(intervals.map((x) => x.ms))})`);

  // Move past the flip, let the host report peak, and fire the ticker.
  Date.now = () => start + 4_000;
  hostPeak = true;
  try {
    ticker.fn();
    await new Promise((resolve) => setTimeout(resolve, 60));
    tree = await client.renderComponent(dock.component, props);
  } finally {
    Date.now = realNow;
  }
  assert.ok(badgeOf(tree).includes('dcb-badge-peak'), 'the badge switches to peak on its own');
});

test('the sidebar panel colours its balance, period and rates', async () => {
  // The dock was tinted but the panel was not, so the same figures looked plain on
  // one surface and highlighted on the other. Assert both, by rendering the panel.
  const client = loadClient({ status: STATUS, session: SESSION });
  const panel = client.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab').component;
  const tree = await client.renderComponent(panel, { t: (key) => key, sessionId: 'session-demo' });

  const tinted = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    const style = node.props?.style;
    if (style?.color !== undefined || style?.background !== undefined) {
      tinted.push({ cls: String(node.props.className ?? ''), colour: style.color ?? style.background });
    }
    if (Array.isArray(node.kids)) node.kids.forEach(walk);
  })(tree);

  const has = (colour, cls) => tinted.some((t) => t.colour === colour && (cls === undefined || t.cls.includes(cls)));
  assert.ok(has('var(--dcb-yellow)'), 'the balance total is yellow');
  assert.ok(has('var(--dcb-blue)'), 'the granted part is blue');
  assert.ok(has('var(--dcb-purple)'), 'the topped-up part is purple');
  assert.ok(has('var(--dcb-green)', 'dcb-hint'), 'the countdown carries the valley colour');

  // Peak must tint the countdown red instead.
  const peakStatus = {
    ok: true,
    value: { ...STATUS.value, period: { peak: true, label: '高峰时段', next: { at: Date.now() + 3_600_000, peak: false } } },
  };
  const peakClient = loadClient({ status: peakStatus, session: SESSION });
  const peakPanel = peakClient.slots.find((slot) => slot.options.name === 'sidebar.right.pane.tab').component;
  const peakTree = await peakClient.renderComponent(peakPanel, { t: (key) => key, sessionId: 'session-demo' });
  const peakTinted = [];
  (function walk(node) {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    if (node.props?.style?.color !== undefined) peakTinted.push({ cls: String(node.props.className ?? ''), colour: node.props.style.color });
    if (Array.isArray(node.kids)) node.kids.forEach(walk);
  })(peakTree);
  assert.ok(
    peakTinted.some((t) => t.colour === 'var(--dcb-red)' && t.cls.includes('dcb-hint')),
    'a peak window tints the countdown red',
  );
});

test('the price table aligns its numbers under their headings', () => {
  // The headers were right-aligned and the values were not, so every column's
  // label and its numbers sat on opposite edges.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const th = /\.dcb-table th\{([^}]*)\}/.exec(source);
  const td = /\.dcb-table td\{([^}]*)\}/.exec(source);
  assert.ok(th !== null && td !== null, 'both table rules exist');
  assert.ok(th[1].includes('text-align:right'), 'headings are right-aligned');
  assert.ok(td[1].includes('text-align:right'), 'values are right-aligned too');

  // The first column stays left-aligned on BOTH, so the model names line up as well.
  const first = /\.dcb-table th:first-child,\.dcb-table td:first-child\{([^}]*)\}/.exec(source);
  assert.ok(first !== null, 'the first-column rule exists');
  assert.ok(first[1].includes('text-align:left'), 'the model column is left-aligned');

  // Each rate column carries its bucket's colour.
  for (const [index, colour] of [[0, '--dcb-green'], [1, '--dcb-amber'], [2, '--dcb-blue']]) {
    assert.ok(
      new RegExp(`\\.dcb-table td\\.dcb-rate-${index}\\{color:var\\(${colour}\\)\\}`).test(source),
      `rate column ${index} is tinted ${colour}`,
    );
  }
});

test('a hot-reloaded bundle refreshes its stylesheet instead of going stale', () => {
  // The bug this guards: `apply()` runs again in a page that still holds the
  // PREVIOUS version's <style> tag. Skipping an existing tag left every CSS fix
  // invisible until a full page reload — a correctly shipped change that still
  // looked broken on screen.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const styles = [];
  const doc = {
    getElementById: (id) => styles.find((tag) => tag.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '', dataset: {} }),
    head: { appendChild: (tag) => styles.push(tag) },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };

  const activate = () => {
    let registration = null;
    const sandbox = {
      window: { __ModuleLoader__: { load: (entry) => { registration = entry; } } },
      document: doc,
      console: { log() {}, warn() {}, info() {} },
      setInterval: () => 0,
      clearInterval: () => {},
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }),
      Promise, setTimeout, Date, Math, JSON, Number, String, Array, Object,
      isNaN, parseInt, parseFloat, AbortSignal, Request, Response,
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const React = {
      createElement: (type, props, ...kids) => ({ __el: true, type, props: props ?? {}, kids: kids.flat().filter(Boolean) }),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useReducer: (reducer, init) => [init, () => {}],
      useEffect: () => {},
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      useRef: (init) => ({ current: init }),
      Fragment: 'Fragment',
    };
    const exports_ = registration.factory((name) => {
      if (name === 'react') return React;
      throw new Error(`unexpected require: ${name}`);
    });
    exports_.apply({
      effect: (fn) => { fn(); return () => {}; },
      locale: { register: () => () => {}, bind: () => (key) => key },
      inject: (services, callback) => {
        callback({
          sidebarRightTabs: { register: () => () => {} },
          slots: { inject: (key, fn) => { fn(); return () => {}; }, register: () => () => {} },
        });
        return () => {};
      },
    });
  };

  activate();
  assert.equal(styles.length, 1, 'one stylesheet tag is injected');
  const injected = styles[0].textContent;
  assert.ok(injected.includes('.dcb-table td{text-align:right'), 'the injected CSS is this bundle version');

  // Emulate the page still holding the previous version's stylesheet.
  styles[0].textContent = 'OLD-CSS-MARKER';
  activate();

  assert.equal(styles.length, 1, 're-activation must not stack a second tag');
  assert.notEqual(styles[0].textContent, 'OLD-CSS-MARKER', 'the stale CSS is replaced');
  assert.equal(styles[0].textContent, injected, 'the tag carries the current bundle CSS');
});

test('the dock countdown carries the period colour, like the panel does', async () => {
  // The panel tinted its countdown but the dock left it grey, so the same line
  // looked different on the two surfaces.
  for (const [peak, colour] of [[false, 'var(--dcb-green)'], [true, 'var(--dcb-red)']]) {
    const status = {
      ok: true,
      value: {
        ...STATUS.value,
        period: { peak, label: peak ? '高峰时段' : '空闲时段', next: { at: Date.now() + 3_600_000, peak: !peak } },
      },
    };
    const client = loadClient({ status, session: SESSION });
    const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
    const props = { t: (key) => key, sessionId: 'session-demo' };
    const closed = await client.renderComponent(dock.component, props);
    client.findByType(closed, 'button').props.onClick();
    const tree = await client.renderComponent(dock.component, props);

    const lines = client
      .findAllByType(tree, 'div')
      .filter((node) => String(node.props.className ?? '').includes('dcb-until'));
    assert.equal(lines.length, 1, 'the countdown renders as one labelled line');
    const dots = client
      .findAllByType(lines[0], 'span')
      .filter((node) => String(node.props.className ?? '').includes('dcb-ldot') && node.props.style?.background);
    assert.equal(dots.length, 1, 'it carries one period dot');
    assert.equal(dots[0].props.style.background, colour, `peak=${peak} tints ${colour}`);
  }
});

test('the per-child list is labelled, and repeats no aggregate', async () => {
  // An unlabelled row with an amount and a bar reads as an orphan. The heading
  // names the group; the aggregate stays in the cost card's legend only.
  //
  // Two children whose amounts DIFFER: with a single child the aggregate and that
  // child's own figure coincide, and "appears once" cannot tell them apart.
  const twoKids = {
    ok: true,
    value: {
      ...SESSION.value,
      children: [
        { sessionId: 'kid-a', title: 'alpha', cost: 0.3, requests: 3, tokens: {} },
        { sessionId: 'kid-b', title: 'beta', cost: 0.07, requests: 1, tokens: {} },
      ],
    },
  };
  const client = loadClient({ status: STATUS, session: twoKids });
  const dock = client.slots.find((slot) => slot.options.name === 'conversation.composer.dock');
  const props = { t: (key) => key, sessionId: 'session-demo' };
  const closed = await client.renderComponent(dock.component, props);
  client.findByType(closed, 'button').props.onClick();
  const tree = await client.renderComponent(dock.component, props);

  const texts = client.textsOf(tree);
  const labelAt = texts.indexOf('session.children');
  const firstChildAt = texts.indexOf('alpha');
  assert.ok(labelAt >= 0, 'the group is labelled');
  assert.ok(firstChildAt > labelAt, 'the label precedes the child rows');

  // Each child's own amount appears once; the aggregate (0.37) appears once too.
  const joined = texts.join(' ');
  assert.equal(joined.split('0.300').length - 1, 1, 'alpha appears once');
  assert.equal(joined.split('0.070').length - 1, 1, 'beta appears once');
  assert.equal(joined.split('0.370').length - 1, 1, 'the aggregate is reported once, in the legend');
});

test('the child-session list is a card on both surfaces', async () => {
  // It used to be a bare label plus loose rows, which read as stray lines under
  // the cost card rather than a section like the others.
  const client = loadClient({ status: STATUS, session: SESSION });
  const props = { t: (key) => key, sessionId: 'session-demo' };

  for (const [name, slotName, needsOpen] of [
    ['dock', 'conversation.composer.dock', true],
    ['panel', 'sidebar.right.pane.tab', false],
  ]) {
    const component = client.slots.find((slot) => slot.options.name === slotName).component;
    let tree = await client.renderComponent(component, props);
    if (needsOpen) {
      client.findByType(tree, 'button').props.onClick();
      tree = await client.renderComponent(component, props);
    }

    const cards = client
      .findAllByType(tree, 'div')
      .filter((node) => String(node.props.className ?? '').includes('dcb-card2'));
    const childCard = cards.find((node) => node.props['data-accent'] === 'children');
    assert.ok(childCard !== undefined, `${name} renders the child list as a card`);

    // The card carries a heading and the child's own row inside its body.
    const heading = client.textsOf(childCard).slice(0, 2).join(' ');
    assert.ok(heading.includes('session.children'), `${name} labels the card`);
    assert.ok(client.textsOf(childCard).join(' ').includes('subagent'), `${name} lists the child`);
    // And the amount is priced, like every other figure in the panel.
    assert.ok(client.textsOf(childCard).join(' ').includes('¥'), `${name} prices the child amount`);
  }
});

test('the child card shares the other cards chrome', () => {
  // Same surface, radius and accent mechanism as the token/cost/price cards, so
  // it reads as one family rather than a special case.
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(
    /\.dcb-card2\[data-accent="children"\]>\.dcb-head2\{--dcb-accent:var\(--dcb-purple\)\}/.test(source),
    'the child card takes the descendant hue',
  );
  assert.ok(source.includes('.dcb-childRow{'), 'child rows stack as label + share bar');
});
