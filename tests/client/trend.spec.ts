/**
 * The trend chart's three modes and the two data rules behind them.
 *
 * DNA ordering is the subtle part: bands follow *read* order (system, tool schemas, then messages), never
 * `seq` — the harness appends `request/header` at dispatch time, so a seq sort would draw tool schemas after
 * the results they describe. Delta pairing is the other: bands match by key, so an item that moved within the
 * prompt still reports its own change.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { describe, expect, it } from 'vitest'
import { deltaBandsOf, dnaOf, trendBandsOf } from '../../src/client/ui/context/dna'
import { TrendChart } from '../../src/client/ui/context/TrendChart'
import type { Assembled } from '../../src/client/ui/context/assemble'
import type { RequestRow, Snapshot } from '../../src/wire/model'

const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}(${Object.values(params).join(',')})`

const colorOf = (): string => 'red'

/** An assembled step: one system node, one tool schema and three messages. */
function assembled(): Assembled {
  return {
    live: false,
    header: { seq: 99, time: 1, tools: [{ name: 'read', tokens: 30 }] },
    system: { seq: 1, time: 1, tokens: 10 },
    nodes: [
      { seq: 2, cat: 'user', tokens: 5, text: 'hi' },
      { seq: 3, cat: 'assistant', tokens: 7 },
      { seq: 4, cat: 'skill', tokens: 3, skill: 'pdf' },
    ],
    missingLive: 0,
    approximate: false,
  }
}

describe('dnaOf', () => {
  it('orders bands by read order, not by seq', () => {
    const items = dnaOf(assembled())
    // The header's seq (99) is larger than every message, yet its bands come first.
    expect(items.map(item => item.key)).toEqual(['sys', 'tool:read', 'n2', 'n3', 'n4'])
  })

  it('keeps a zero-token item', () => {
    const view = { ...assembled(), system: { seq: 1, time: 1, tokens: 0 } }
    expect(dnaOf(view)[0]).toMatchObject({ key: 'sys', tokens: 0 })
  })
})

describe('trendBandsOf', () => {
  it('accumulates the offset of each band', () => {
    const bands = trendBandsOf(assembled(), colorOf)
    expect(bands.map(band => band.off)).toEqual([0, 10, 40, 45, 52])
  })
})

describe('deltaBandsOf', () => {
  it('reports nothing without a baseline', () => {
    expect(deltaBandsOf(trendBandsOf(assembled(), colorOf), null)).toEqual({ up: [], down: [] })
  })

  it('pairs by key, so a moved band still reports its own change', () => {
    const before = trendBandsOf(assembled(), colorOf)
    // The same items with different sizes: the user message grew, the assistant message shrank.
    const grown = assembled()
    grown.nodes = [
      { seq: 2, cat: 'user', tokens: 15, text: 'hi' },
      { seq: 3, cat: 'assistant', tokens: 2 },
      { seq: 4, cat: 'skill', tokens: 3, skill: 'pdf' },
    ]
    const after = trendBandsOf(grown, colorOf)
    const delta = deltaBandsOf(after, before)
    expect(delta.up.find(band => band.key === 'n2')?.tokens).toBe(10)
    expect(delta.down.find(band => band.key === 'n3')?.tokens).toBe(-5)
    // The removed/added sides accumulate magnitudes from the zero line.
    expect(delta.up[0].off).toBe(0)
    expect(delta.down[0].off).toBe(0)
  })
})

describe('TrendChart', () => {
  /** Two request rows with a composition. */
  function rows(): RequestRow[] {
    return [
      { seq: 2, time: 1, turn: 1, step: 1, system: 10, tools: 5, user: 5, inject: 0, skill: 0, assistant: 5, tool: 0, total: 25, activeMs: 900, prompt: 20, cacheRead: 10, output: 5 },
      { seq: 6, time: 2, turn: 1, step: 2, system: 10, tools: 5, user: 5, inject: 2, skill: 0, assistant: 8, tool: 3, total: 33, activeMs: 400 },
    ]
  }

  const snapshot: Snapshot = {
    ok: true,
    current: { system: 10, tools: 5, user: 5, inject: 0, skill: 0, assistant: 8, tool: 0, total: 28 },
    requests: [], events: [{ seq: 3, time: 2, kind: 'compaction', tokens: 5 }],
    nodes: [], droppedNodes: 0, archive: [],
  }

  const base = {
    t,
    markers: [undefined, snapshot.events[0]],
    granularity: 'step' as const,
    selectedSeq: null,
    hoveredSeq: null,
    focusTurn: null,
    dna: null,
    hoverBand: null,
    onSelect: () => {},
    onHover: () => {},
    onHoverBand: () => {},
    durationCurve: false,
    adaptive: false,
    spans: undefined,
  }

  it('draws the old chart structure: a bar per row, a stage stack, the axis rail and the grid', () => {
    const markup = renderToStaticMarkup(h(TrendChart, { ...base, rows: rows(), mode: 'total' }))
    // One constant-width bar per row, each stacking its stage segments.
    expect((markup.match(/class="cb-bar[\s"]/g) ?? []).length).toBe(2)
    expect(markup).toContain('cb-bar-stack')
    expect(markup).toContain('cb-cat-seg')
    expect(markup).toContain('cb-bar-marker')
    // The numeric rail and the four dashed guides plus the solid baseline.
    expect(markup).toContain('cb-axis')
    expect(markup).toContain('cb-grid-top')
    expect(markup).toContain('cb-grid-zero')
    // The turn band beneath mirrors the column grid.
    expect(markup).toContain('cb-turns')
    expect(markup).toContain('cb-turn')
  })

  it('draws the delta mode as two arms around the zero line', () => {
    const markup = renderToStaticMarkup(h(TrendChart, { ...base, rows: rows(), mode: 'delta', dna: null }))
    expect(markup).toContain('cb-bar-up')
    expect(markup).toContain('cb-bar-down')
    // The axis labels the centre as zero in this mode.
    expect(markup).toContain('cb-axis-mid')
  })

  it('draws DNA bands and their legend when the mode is on', () => {
    const bands = rows().map(() => trendBandsOf(assembled(), colorOf))
    const markup = renderToStaticMarkup(h(TrendChart, { ...base, rows: rows(), mode: 'total', dna: bands }))
    expect(markup).toContain('cb-trend-dna-legend')
    expect(markup).toContain('cb-trend-dna-item')
  })

  it('draws the duration overlay when enabled', () => {
    const withCurve = renderToStaticMarkup(h(TrendChart, { ...base, rows: rows(), mode: 'total', durationCurve: true }))
    expect(withCurve).toContain('cb-duration')
    const without = renderToStaticMarkup(h(TrendChart, { ...base, rows: rows(), mode: 'total', durationCurve: false }))
    expect(without).not.toContain('cb-duration')
  })

  it('narrows the window to one screenful in adaptive mode', () => {
    const many: RequestRow[] = Array.from({ length: 200 }, (_, index): RequestRow => ({
      seq: index + 1, time: index, turn: Math.floor(index / 3) + 1, step: (index % 3) + 1,
      system: 1, tools: 1, user: 1, inject: 0, assistant: 1, tool: 0, total: 4,
    }))
    const adaptive = renderToStaticMarkup(h(TrendChart, { ...base, rows: many, mode: 'total', adaptive: true }))
    const full = renderToStaticMarkup(h(TrendChart, { ...base, rows: many, mode: 'total', adaptive: false }))
    // Count only the bar buttons: the class also appears on the active/rīse modifiers, so anchor on the
    // attribute boundary that ends the base class.
    const barsIn = (markup: string): number => (markup.match(/class="cb-bar[\s"]/g) ?? []).length
    expect(barsIn(adaptive)).toBeLessThan(barsIn(full))
    expect(barsIn(adaptive)).toBeLessThanOrEqual(40)
  })
})
