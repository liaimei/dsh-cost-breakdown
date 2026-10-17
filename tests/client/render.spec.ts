/**
 * Render smoke tests for the browser surfaces.
 *
 * These render to static markup — hooks run, effects do not — which is exactly the check a rewrite needs:
 * every surface must turn a wire payload into markup without throwing. A component that reads a missing
 * field or calls a hook conditionally fails here, long before a browser does.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { describe, expect, it } from 'vitest'
import type { Snapshot } from '../../src/wire/model'
import type { ClientContext, ContextSeatProps } from '../../src/client/shell/contracts'
import { DockReadout } from '../../src/client/ui/dock/DockReadout'
import { PluginSettingsCard } from '../../src/client/ui/settings'
import { InsightsPage } from '../../src/client/ui/insights/InsightsPage'
import { ContextView } from '../../src/client/ui/context/ContextView'
import type { PreferencesStore } from '../../src/client/shell/preferences'

/** A translator that returns the key, so assertions can name keys instead of copied strings. */
const t = (key: string): string => key

/** A preferences store at its schema defaults. */
function preferences(): PreferencesStore {
  const state = {
    status: 'ready' as const,
    writable: true,
    defaultPlacement: 'all' as const,
    defaultGranularity: 'step' as const,
    defaultTrendMode: 'total' as const,
    defaultDeltaBase: 'step' as const,
    defaultToolSort: 'count' as const,
    defaultFileSort: 'count' as const,
    insightsEntry: 'show' as const,
    defaultDurationCurve: 'show' as const,
  }
  return {
    store: { subscribe: () => () => {}, getSnapshot: () => state },
    get: () => state,
    attach: () => () => {},
    set: () => {},
  }
}

/** A snapshot with a little of everything the surfaces read. */
function snapshot(): Snapshot {
  return {
    ok: true,
    model: 'deepseek-flash',
    provider: 'deepseek-official',
    contextWindow: 128_000,
    current: { system: 100, tools: 50, user: 20, inject: 10, skill: 5, assistant: 30, tool: 15, total: 230 },
    requests: [
      { time: 1, seq: 2, system: 1, tools: 0, user: 10, inject: 0, assistant: 5, tool: 0, total: 16, turn: 1, step: 1 },
    ],
    events: [{ seq: 3, time: 2, kind: 'model', from: 'a', to: 'b' }],
    nodes: [
      { seq: 2, cat: 'user', tokens: 10, text: 'hello' },
      { seq: 4, cat: 'assistant', tokens: 5, text: 'hi' },
    ],
    droppedNodes: 0,
    archive: [],
    cost: { 'deepseek-official': { 'deepseek-flash': { peak: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 10 } } } },
    calls: { 'deepseek-official': { 'deepseek-flash': 1 } },
    fileOps: [{ seq: 5, path: '/a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
    timing: { wallMs: 1000, ttftMs: 100, genMs: 800, calls: 1, toolsMs: 50, toolCalls: 1, tools: { read: { calls: 1, ms: 50 } } },
    answers: 1,
  }
}

/** A client context with only the services these surfaces touch. */
function clientContext(): ClientContext {
  return {
    get: (name: string) => {
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) }, refresh: async () => {} }
      if (name === 'connection') return { isLoopback: false }
      if (name === 'uiWorkspace') return { openSession: () => {} }
      return undefined
    },
    effect: (fn: () => unknown) => { fn(); return () => {} },
    inject: (_names: unknown, cb: (ctx: unknown) => unknown) => { cb({}); return () => {} },
    fiber: { name: 'other' },
    locale: { register: () => () => {}, bind: () => t },
    slots: { inject: () => () => {}, register: () => () => {} },
  } as unknown as ClientContext
}

/** The session seat props the surfaces receive from the harness. */
function seat(overrides: Partial<ContextSeatProps> = {}): ContextSeatProps {
  const value = snapshot()
  return { sessionId: 's1', useProjection: (key: string) => (key === 'contextTimeline' ? value : undefined), ...overrides }
}

describe('dock readout', () => {
  it('renders the collapsed row from the session snapshot', () => {
    const markup = renderToStaticMarkup(h(DockReadout, { ...seat(), t, locale: () => 'zh' }))
    // The current route's spend and the peak/off badge are both present.
    expect(markup).toContain('cb-dock')
    expect(markup).toContain('dock.moneySpent')
    expect(markup).toContain('dock.peak')
  })

  it('renders nothing before the first projection value arrives', () => {
    const markup = renderToStaticMarkup(h(DockReadout, { sessionId: 's1', useProjection: () => undefined, t, locale: () => 'en' }))
    expect(markup).toBe('')
  })
})

describe('settings card', () => {
  it('renders a row per preference and follows the writable flag', () => {
    const markup = renderToStaticMarkup(h(PluginSettingsCard, { t, store: preferences() }))
    expect(markup).toContain('settings.placement')
    expect(markup).toContain('settings.insightsEntry')
    expect(markup).toContain('cb-set-row')
    expect(markup).not.toContain('settings.readOnly')
  })

  it('renders nothing when the host serves no scope', () => {
    const unwritable = { ...preferences(), get: () => ({ ...preferences().get(), status: 'unavailable' as const }) }
    const markup = renderToStaticMarkup(h(PluginSettingsCard, { t, store: unwritable }))
    expect(markup).toBe('')
  })
})

describe('stats page', () => {
  it('renders the unavailable state when the session list is not served', () => {
    const markup = renderToStaticMarkup(h(InsightsPage, {
      t,
      ctx: clientContext(),
      preferences: preferences(),
      sessionId: 's1',
    }))
    expect(markup).toContain('ov.unavailable')
  })
})

describe('context view', () => {
  it('renders the composition, trend, browser, events, files, agent and timing sections', () => {
    const markup = renderToStaticMarkup(h(ContextView, {
      ...seat(),
      t,
      ctx: clientContext(),
      preferences: preferences(),
    }))
    expect(markup).toContain('overview.title')
    expect(markup).toContain('trend.title')
    expect(markup).toContain('browser.title')
    expect(markup).toContain('events.title')
    expect(markup).toContain('files.title')
    expect(markup).toContain('agents.title')
    expect(markup).toContain('timing.title')
  })

  it('renders the loading state before the timeline arrives', () => {
    const markup = renderToStaticMarkup(h(ContextView, {
      sessionId: 's1',
      useProjection: () => undefined,
      t,
      ctx: clientContext(),
      preferences: preferences(),
    }))
    expect(markup).toContain('cb-root')
    expect(markup).toContain('loading')
  })
})
