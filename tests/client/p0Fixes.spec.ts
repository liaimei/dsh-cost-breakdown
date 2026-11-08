/**
 * Regression tests for four P0 client defects.
 *
 * Each of these bugs was invisible in the previous suite because the unit under test had never been
 * exercised through the path that broke:
 *   1. the Context surface re-created its error-boundary class on every render, remounting the subtree;
 *   2. the dock readout priced its subscription block at the schema-default tier, ignoring the setting;
 *   3. a subscription platform's quota credits were printed with a currency symbol;
 *   4. the per-turn pill printed a USD amount with the yuan symbol, understating it by the fixed rate.
 */

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { createElement as h, useEffect } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundaryFor } from '../../src/client/ui/context/ErrorBoundary'
import { DockReadout, usePlanTier } from '../../src/client/ui/dock/DockReadout'
import { readingOf } from '../../src/client/ui/dock/reading'
import { StatsCostBlock, StatsPlatformBlock } from '../../src/client/ui/dock/blocks'
import { turnSpendText } from '../../src/client/ui/turnSpend'
import type { PreferencesState, PreferencesStore } from '../../src/client/shell/preferences'
import type { ContextSeatProps } from '../../src/client/shell/contracts'
import type { Snapshot } from '../../src/wire/model'

/** A translator that names its key and joins params, so assertions can name keys instead of copy. */
const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${Object.values(params).join(',')}`

/** A preferences store at `planTier`, with a working subscription so the hook can be exercised. */
function preferencesAt(planTier: number): PreferencesStore {
  let state: PreferencesState = {
    status: 'ready',
    writable: true,
    defaultPlacement: 'all',
    defaultGranularity: 'step',
    defaultTrendMode: 'total',
    defaultToolSort: 'count',
    defaultFileSort: 'count',
    insightsEntry: 'show',
    defaultDurationCurve: 'show',
    defaultPlanTier: planTier,
  }
  const listeners = new Set<() => void>()
  return {
    store: {
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => state,
    },
    get: () => state,
    attach: () => () => {},
    set: (field, value: unknown) => {
      state = { ...state, [field]: value } as PreferencesState
      for (const listener of listeners) listener()
    },
  }
}

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
  vi.restoreAllMocks()
})

function mount(element: ReturnType<typeof h>): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root?.render(element) })
}

describe('the context surface keeps one error boundary', () => {
  it('reuses the class for the same translator', () => {
    expect(boundaryFor(t)).toBe(boundaryFor(t))
    const other = (key: string): string => key
    expect(boundaryFor(other)).not.toBe(boundaryFor(t))
  })

  it('does not remount the subtree when the parent re-renders', () => {
    let mounts = 0
    function Child(): ReturnType<typeof h> {
      useEffect(() => { mounts += 1 }, [])
      return h('span', null, 'child')
    }
    function Parent(): ReturnType<typeof h> {
      // Exactly how ContextView builds it: looked up during render, stable by translator.
      const Boundary = boundaryFor(t)
      return h(Boundary, null, h(Child))
    }
    mount(h(Parent))
    expect(mounts).toBe(1)
    act(() => { root?.render(h(Parent)) })
    // A class re-created per render would change the element type and remount Child (mounts would be 2).
    expect(mounts).toBe(1)
  })
})

describe('the dock readout prices the selected subscription tier', () => {
  it('reads the tier through the preferences store and follows an edit', () => {
    const preferences = preferencesAt(2)
    function Probe(): ReturnType<typeof h> {
      return h('span', null, String(usePlanTier(preferences)))
    }
    mount(h(Probe))
    expect(document.body.textContent).toBe('2')
    act(() => { preferences.set('defaultPlanTier', 0) })
    expect(document.body.textContent).toBe('0')
  })

  it('prices the plan family at that tier', () => {
    const top = readingOf(planSnapshot(), null, null, 2)
    const entry = readingOf(planSnapshot(), null, null, 0)
    expect(top.plan?.tier?.label).toBe('Max')
    expect(entry.plan?.tier?.label).toBe('Lite')
  })
})

describe('a subscription is never printed as money', () => {
  it('renders quota credits in the cost block', () => {
    const reading = readingOf(planSnapshot(), null, null, 2)
    const markup = renderToStaticMarkup(h(StatsCostBlock, { t, reading }))
    expect(markup).toContain('costStat.unit.plan')
    expect(markup).toContain('6.9')
    expect(markup).not.toContain('$')
  })

  it('renders quota credits in the platform block', () => {
    const reading = readingOf(planSnapshot(), null, null, 2)
    const wallet = { balance: null, credits: null, planQuotas: null }
    const markup = renderToStaticMarkup(h(StatsPlatformBlock, { t, reading, wallet }))
    expect(markup).toContain('dock.planSpent')
    expect(markup).not.toContain('$')
  })

  it('renders the collapsed dock row without a currency symbol', () => {
    const markup = renderToStaticMarkup(h(DockReadout, {
      ...seat(planSnapshot()),
      t,
      locale: () => 'zh',
      preferences: preferencesAt(2),
    }))
    expect(markup).toContain('dock.planSpent')
    expect(markup).not.toContain('$')
  })
})

describe('the per-turn pill converts into the display currency', () => {
  it('converts a USD amount before printing the yuan symbol', () => {
    // 0.02 USD ≈ 0.133 CNY; printing "0.020 ¥" would understate the bill by 1/USD_PER_CNY.
    expect(turnSpendText({ value: 0.02, credits: false }, 'usd', t)).toBe('0.020 $')
    expect(turnSpendText({ value: 0.02, credits: false }, 'cny', t)).toBe('0.13 ¥')
  })

  it('keeps a credit-billed turn in credits, regardless of language', () => {
    expect(turnSpendText({ value: 12, credits: true }, 'cny', t)).toBe('turnSpend.credits:12')
  })
})

/** A session snapshot whose only platform is a GLM subscription route. */
function planSnapshot(): Snapshot {
  return {
    ok: true,
    model: 'glm-5.3',
    provider: 'zai-coding-cn',
    contextWindow: 200_000,
    current: { system: 100, tools: 50, user: 20, inject: 10, skill: 5, assistant: 30, tool: 15, total: 230 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    // 10000 uncached tokens × 6.9 input coefficients ÷ 10000 = 6.9 credits.
    cost: {
      'zai-coding-cn': {
        'glm-5.3': { peak: { uncached: 10_000, cacheRead: 0, cacheWrite: 0, output: 0 } },
      },
    },
    calls: { 'zai-coding-cn': { 'glm-5.3': 1 } },
    answers: 0,
  }
}

/** The seat props the dock reads. */
function seat(value: Snapshot): ContextSeatProps {
  return {
    sessionId: 's1',
    useProjection: (key: string) => (key === 'contextTimeline' ? value : undefined),
  } as unknown as ContextSeatProps
}
