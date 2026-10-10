/**
 * A minimal React implementation for driving the real client bundle outside a
 * browser.
 *
 * Every e2e test used to carry its own copy of this stub, and they drifted: the
 * bundle gained a `useReducer` and three suites broke at once. One definition
 * keeps them honest, and it implements the hook semantics the bundle relies on —
 * persistent hook slots plus real dependency comparison — because a stub that
 * re-runs every effect cannot observe a dependency-identity bug.
 */

/** Create one React stand-in with per-render hook state. */
export function createReact() {
  const hooks = [];
  const state = { cursor: 0, effects: [] };

  const sameDeps = (a, b) =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

  const hookAt = () => {
    const index = state.cursor++;
    if (hooks[index] === undefined) hooks[index] = {};
    return hooks[index];
  };

  const React = {
    // React passes positional children to a component as `props.children`.
    // Omitting that made any component receiving its body that way render empty,
    // which silently hid card bodies in the harness while the real app drew them.
    createElement: (type, props, ...kids) => {
      const flat = kids.flat().filter((kid) => kid !== null && kid !== undefined);
      const given = props ?? {};
      const children = flat.length === 0
        ? given.children
        : flat.length === 1
          ? flat[0]
          : flat;
      return { __el: true, type, props: { ...given, children }, kids: flat };
    },
    useState: (init) => {
      const slot = hookAt();
      if (!('value' in slot)) slot.value = typeof init === 'function' ? init() : init;
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; }];
    },
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

  /** Begin a render pass: reset the hook cursor and collect its effects. */
  const beginRender = () => {
    state.cursor = 0;
    state.effects = [];
  };

  /** Each effect this render requested, already dependency-filtered. */
  const pendingEffects = () => state.effects;

  /**
   * Expand a rendered element tree, resolving function components down to host
   * nodes.
   */
  const expand = async (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (Array.isArray(node)) return Promise.all(node.map(expand));
    if (node.__el && typeof node.type === 'function') return expand(node.type(node.props));
    if (node.__el) return { ...node, kids: (await Promise.all(node.kids.map(expand))).flat() };
    return node;
  };

  /** Every string in a rendered tree, in document order. */
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

  /** The first host element of one tag in a rendered tree. */
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

  return { React, beginRender, pendingEffects, expand, textsOf, findByType };
}

/** A `window` stand-in covering what the client half touches. */
export function createWindow(moduleLoader) {
  const listeners = new Map();
  return {
    __ModuleLoader__: moduleLoader,
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener(type, handler) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(handler);
      listeners.set(type, bucket);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    /** Fire every listener of one type; used to exercise repositioning. */
    dispatch(type) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler();
    },
  };
}

/** A `document` stand-in covering what the client half touches. */
export function createDocument() {
  return {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', dataset: {} }),
    head: { appendChild() {} },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
}

/**
 * Load the plugin's client bundle in a sandbox and return its exported module.
 *
 * @param {object} vm - the `node:vm` module (passed in so this file holds no
 *   global state and the caller controls the sandbox lifetime).
 * @param {string} source - the bundle text (fetch it with `fetchClientBundle`).
 * @param {(url: string) => Promise<object>} fetchImpl - canned route responses.
 * @param {string} requireName - the external to hand back: `react`.
 * @param {object} reactExport - what `require('react')` returns.
 * @returns {{exports: object, calls: string[]}}
 */
export function loadBundle(vm, source, fetchImpl, requireName, reactExport) {
  let registration = null;
  const calls = [];
  const sandbox = {
    window: createWindow({ load: (entry) => { registration = entry; } }),
    document: createDocument(),
    console,
    // Timers are captured, never scheduled: a test drives time explicitly.
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async (url) => {
      calls.push(url);
      return fetchImpl(url);
    },
    Promise, setTimeout, Date, Math, JSON, Number, String, Array, Object,
    isNaN, parseInt, parseFloat, AbortSignal, Request, Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  if (registration === null) throw new Error('the bundle did not register a module');
  const exports = registration.factory((name) => {
    if (name === requireName) return reactExport;
    throw new Error(`unexpected require: ${name}`);
  });
  return { exports, calls };
}

/**
 * Mount one component the bundle registered into a slot, run its effects, let
 * async reads settle, and render again so assertions read the settled state.
 *
 * @returns {Promise<object>} the rendered host-element tree.
 */
export async function renderComponent(react, component, props) {
  const pass = async () => {
    react.beginRender();
    return react.expand(component(props));
  };
  await pass();
  const pending = react.pendingEffects().map((fn) => {
    const result = fn();
    return result && typeof result.then === 'function' ? result : null;
  });
  await Promise.all(pending);
  // One macrotask so the store's follow-up publishes land before we re-render.
  await new Promise((resolve) => setTimeout(resolve, 40));
  const tree = await pass();
  // The settled pass's own effects must RUN, as React would: an effect whose
  // dependencies only become non-null after data lands (the countdown ticker,
  // which needs `period.next.at`) arms here and nowhere else.
  for (const fn of react.pendingEffects()) fn();
  return tree;
}
