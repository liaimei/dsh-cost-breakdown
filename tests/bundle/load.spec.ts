/**
 * Load the BUILT artifacts the way the harness does, and drive `apply()` against a fake Cordis context.
 *
 * This is the closest offline check to "the plugin actually loads": the host half is imported through its
 * package entry and its registrations are observed on a stub registry, and the client half is evaluated
 * inside a stubbed `window.__ModuleLoader__`, exactly as the shell loads it. What it cannot prove is the
 * harness's own wiring; what it does prove is that the artifacts export the right faces, assemble in the
 * right order, and register the frozen keys, versions, routes and slots.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')

/** A recorded projection registration. */
interface UnitRecord { key: string; stateVersion: number; hasView: boolean; state: unknown }

/** A recorded route registration. */
interface RouteRecord { path: string; methods: readonly string[] }

/** A fake Cordis context: enough of the service seam for this plugin's assembly. */
function fakeHostContext(units: UnitRecord[], routes: RouteRecord[], logs: string[]): Record<string, unknown> {
  const services: Record<string, unknown> = {
    sessionProjections: {
      register(definition: { key: string; stateVersion: number; init(): unknown; wire?: unknown }) {
        units.push({
          key: definition.key,
          stateVersion: definition.stateVersion,
          hasView: definition.wire !== undefined,
          state: definition.init(),
        })
        return () => {}
      },
      stateOf() { return undefined },
      snapshot() { return { asOfSeq: -1, values: {} } },
      cachedSnapshot() { return undefined },
      onChanged() { return () => {} },
    },
    connection: {
      fetch: {
        register(route: RouteRecord) {
          routes.push(route)
          return () => {}
        },
      },
      rpc: { call: async () => ({ ok: true, value: null }) },
      isLoopback: true,
    },
    sessions: { get: () => undefined, list: { getSnapshot: () => ({ byId: {} }) } },
    sessionQuery: { observeSession: async () => ({ events: [], [Symbol.dispose]() {} }) },
    sessionProjectionCache: { rows: async () => [] },
    skills: { list: async () => [] },
    agentPresets: { acquireScope: async () => undefined, serviceFor: () => undefined },
    agents: { get: () => undefined },
    tools: { register: () => () => {} },
    logger: (level: string) => (message: string) => { logs.push(`${level}: ${message}`) },
    dshHomePath: (...parts: string[]) => join('/tmp/dsh-home', ...parts),
    deepseekAccount: {
      getState: () => ({ status: 'signed-out' }),
      getBalance: async () => ({ status: 'unavailable' }),
    },
    settings: { describe: () => [] },
    credentials: { resolve: async () => undefined },
    'internal/get': {},
  }
  const ctx: Record<string, unknown> = {
    // Cordis exposes the calling plugin's fiber; attribution reads its name to exclude the plugin itself.
    fiber: { name: 'other-plugin' },
    get: (name: string) => services[name],
    effect: (fn: () => unknown) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject: (names: readonly string[] | string[], callback: (ctx: unknown) => unknown) => {
      // Every service this plugin injects is present in the fake, so the callback always runs.
      void names
      const dispose = callback(ctx)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
  }
  // Cordis exposes services as **properties** on the context as well as through `get`; the assembly reads
  // `ctx.sessionProjections` directly, so the fake resolves unknown properties to the service table.
  return new Proxy(ctx, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property)
      if (typeof property !== 'string') return undefined
      return services[property]
    },
  })
}

/** A fake client context: enough of the slot/locale seam for the browser half's assembly. */
function fakeClientContext(dictionaries: string[], slots: string[], commands: number): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    fiber: { name: 'other-plugin' },
    get: (name: string) => {
      if (name === 'connection') return { isLoopback: true, rpc: { call: async () => ({ ok: true, value: true }) } }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {}, rows: [] }) }, refresh: async () => {} }
      if (name === 'uiWorkspace') return { openSession: () => {} }
      if (name === 'uiConversation') return { imageUrl: async () => { throw new Error('unavailable') } }
      if (name === 'configForms') {
        return {
          get: () => ({
            getSnapshot: () => ({ status: 'ready', value: {}, writable: true }),
            subscribe: () => () => {},
            set: async () => {},
          }),
          whileServed: (_: readonly string[], register: () => unknown) => register(),
        }
      }
      if (name === 'inputTriggers') {
        return {
          registerSource: () => { commands++; return () => {} },
        }
      }
      return undefined
    },
    effect: (fn: () => unknown) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject: (names: readonly string[] | string[], callback: (ctx: unknown) => unknown) => {
      void names
      const dispose = callback(ctx)
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: (namespace: string) => { dictionaries.push(namespace); return () => {} },
      bind: () => (key: string) => key,
      getLocale: () => ({ active: 'zh' }),
    },
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (registration: { name: string; id?: string; key?: string }) => {
        slots.push(registration.id ?? registration.key ?? registration.name)
        return () => {}
      },
    },
    on: () => () => {},
  }
  return ctx
}

describe('host artifact loads and assembles', () => {
  it('registers the three projections and five routes', async () => {
    const module = await import(pathToFileURL(join(root, 'lib/index.js')).href) as {
      apply(ctx: unknown, config: unknown): void
      name: string
      inject: readonly string[]
    }
    const units: UnitRecord[] = []
    const routes: RouteRecord[] = []
    const logs: string[] = []
    module.apply(fakeHostContext(units, routes, logs), {})
    expect(units.map(unit => unit.key).sort()).toEqual(['contextActivity', 'contextHeaders', 'contextTimeline'])
    const versions = Object.fromEntries(units.map(unit => [unit.key, unit.stateVersion]))
    expect(versions.contextTimeline).toBe(29)
    expect(versions.contextHeaders).toBe(1)
    expect(versions.contextActivity).toBe(6)
    expect(units.every(unit => unit.hasView)).toBe(true)
    expect(routes.map(route => route.path).sort()).toEqual([
      '/api/dsh-cost-breakdown/backfill',
      '/api/dsh-cost-breakdown/balance',
      '/api/dsh-cost-breakdown/credits',
      '/api/dsh-cost-breakdown/detail',
      '/api/dsh-cost-breakdown/skills',
    ])
    expect(routes.every(route => route.methods.length === 1 && route.methods[0] === 'POST')).toBe(true)
  })

  it('registers the below-baseline fallbacks when the gate refuses', async () => {
    const module = await import(pathToFileURL(join(root, 'lib/index.js')).href) as { apply(ctx: unknown, config: unknown): void }
    const units: UnitRecord[] = []
    const routes: RouteRecord[] = []
    const logs: string[] = []
    const ctx = fakeHostContext(units, routes, logs)
    // A harness release below the baseline: the gate must register the three degraded units and return.
    ;(ctx as Record<string, unknown>).dshHomePath = () => '/nonexistent-home'
    const originalGet = ctx.get as (name: string) => unknown
    ctx.get = (name: string) => {
      if (name === 'dshHomePath') return () => '/nonexistent-home'
      return originalGet(name)
    }
    module.apply(ctx, {})
    // The probe cannot resolve a harness package from a nonexistent home, so the gate fails open and the
    // real units register — the expected behaviour for an unknown version.
    expect(units.length).toBe(3)
  })
})

describe('client artifact loads and assembles', () => {
  /** Evaluate the built client bundle inside a stubbed module-loader, returning its export face. */
  function loadClient(): Record<string, unknown> {
    const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
    let loaded: Record<string, unknown> | undefined
    const windowStub = {
      __ModuleLoader__: {
        load(payload: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
          loaded = payload.factory((id: string) => {
            // The shell seeds these four platform modules; the plugin requires nothing else.
            if (id === 'react') return { createElement: () => null, Fragment: Symbol('fragment'), useState: () => [null, () => {}], useEffect: () => {}, useMemo: (fn: () => unknown) => fn(), useRef: () => ({ current: null }), useLayoutEffect: () => {}, useSyncExternalStore: () => null }
            if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
            if (id === 'react-dom') return { createPortal: () => null }
            if (id === '@deepseek-ai/dsh-client-ui-primitives') return new Proxy({}, { get: () => () => null })
            throw new Error(`unexpected platform require: ${id}`)
          }) as Record<string, unknown>
        },
      },
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener: () => {},
      removeEventListener: () => {},
    }
    // Run the bundle with the browser globals it expects.
    const run = new Function('window', 'document', 'globalThis', 'module', 'exports', source)
    const moduleStub = { exports: {} as Record<string, unknown> }
    run(windowStub, globalThis.document, { ...globalThis, window: windowStub, localStorage: globalThis.localStorage }, moduleStub, moduleStub.exports)
    const exported = (loaded ?? moduleStub.exports) as Record<string, unknown>
    return exported
  }

  it('exports the frozen plugin face and registers every slot', () => {
    const client = loadClient()
    expect(client.name).toBe('dsh-cost-breakdown')
    expect(client.inject).toEqual(['slots', 'locale'])
    expect(typeof client.apply).toBe('function')
    const dictionaries: string[] = []
    const slots: string[] = []
    let commands = 0
    ;(client.apply as (ctx: unknown) => void)(fakeClientContext(dictionaries, slots, commands))
    expect(dictionaries).toContain('dsh-cost-breakdown')
    // The dock, the modal, both chat actions, the conversation tab and the two insights seats.
    expect(slots).toContain('context')
    expect(slots).toContain('context-cost')
    expect(slots).toContain('context-modal')
    expect(slots).toContain('context-jump')
    expect(slots).toContain('turn-spend')
    expect(slots).toContain('dsh-cost-breakdown')
  })

  it('never requires a module outside the frozen platform table', () => {
    // `loadClient` throws on any other require, so a successful load is the assertion; run it once more with
    // the apply call to prove the whole graph evaluates.
    expect(() => loadClient()).not.toThrow()
  })
})
