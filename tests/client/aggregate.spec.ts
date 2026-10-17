/**
 * Cross-session aggregation: ranges, filters, ordering, and the two-figure KPI split (usage coverage vs
 * price coverage). The rule under test throughout is that a missing number sorts last and renders as a
 * dash, never as a zero that claims a measurement.
 */

import { describe, expect, it } from 'vitest'
import {
  OVERVIEW_PAGE_SIZE, UNGROUPED_KEY, dayKeyRange, filterRows, groupCountsOf, kpisOf, pageOf, rangeWindowOf,
  sortRows, usageTotalsOf, windowOfDayRange, daysOfWindow, billedOf, createdDayOf, turnsOf,
} from '../../src/client/data/aggregate'
import type { OverviewRow } from '../../src/client/data/overview'

const NOW = Date.UTC(2026, 9, 16, 12)

/** A minimal row. */
function row(id: string, overrides: Partial<OverviewRow> = {}): OverviewRow {
  return {
    id,
    title: id,
    updatedAt: NOW,
    running: false,
    timeline: null,
    activity: null,
    family: [],
    familyCost: null,
    familyCalls: null,
    familyActivity: null,
    ...overrides,
  }
}

describe('ranges', () => {
  it('treats presets as rolling windows and all as unbounded', () => {
    const today = rangeWindowOf('today', NOW)
    expect(today.start).not.toBeNull()
    expect(new Date(today.start as number).getHours()).toBe(0)
    expect(rangeWindowOf('7d', NOW).start).toBe(NOW - 7 * 86_400_000)
    expect(rangeWindowOf('all', NOW)).toEqual({ start: null, end: null })
  })

  it('reads a window back as day keys', () => {
    const range = dayKeyRange(rangeWindowOf('7d', NOW))
    expect(range).not.toBeNull()
    expect((range as { from: string; to: string }).from < (range as { to: string }).to).toBe(true)
    expect(dayKeyRange({ start: null, end: null })).toBeNull()
  })

  it('turns a picked day range into midnight-to-last-ms', () => {
    const window = windowOfDayRange({ from: '2026-10-01', to: '2026-10-02' })
    expect(window).not.toBeNull()
    expect(new Date(window?.start as number).getDate()).toBe(1)
    expect(new Date(window?.end as number).getHours()).toBe(23)
    expect(windowOfDayRange({ from: 'nope', to: '2026-10-02' })).toBeNull()
  })

  it('produces a bounded day list ending today', () => {
    const days = daysOfWindow({ start: null, end: NOW }, NOW, 7)
    expect(days).toHaveLength(7)
    expect(days.at(-1)).toBe('2026-10-16')
  })
})

describe('filtering', () => {
  it('filters by window, day activity, skill and query', () => {
    const active = row('a', {
      familyActivity: { days: { '2026-10-16': { tokens: 5, requests: 1, skills: { pdf: { n: 1, last: NOW } } } } },
      timeline: { lastUser: 'about invoices' } as never,
    })
    const idle = row('b')
    expect(filterRows([active, idle], { window: rangeWindowOf('7d', NOW), day: null, query: '' })).toHaveLength(2)
    expect(filterRows([active, idle], { window: rangeWindowOf('7d', NOW), day: '2026-10-16', query: '' })).toHaveLength(1)
    expect(filterRows([active], { window: rangeWindowOf('7d', NOW), day: null, query: '', skill: 'pdf' })).toHaveLength(1)
    expect(filterRows([active], { window: rangeWindowOf('7d', NOW), day: null, query: 'invoice' })).toHaveLength(1)
    expect(filterRows([active], { window: rangeWindowOf('7d', NOW), day: null, query: 'nothing' })).toHaveLength(0)
  })

  it('excludes rows outside the window', () => {
    const stale = row('old', { updatedAt: NOW - 30 * 86_400_000 })
    expect(filterRows([stale], { window: rangeWindowOf('7d', NOW), day: null, query: '' })).toHaveLength(0)
  })
})

describe('sorting and paging', () => {
  it('sorts descending and puts unknown numbers last', () => {
    const cheap = row('cheap', { familyCost: { p: { m: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } } })
    const unknown = row('unknown')
    const sorted = sortRows([unknown, cheap], 'tokens')
    expect(sorted[0].id).toBe('cheap')
    expect(sorted[1].id).toBe('unknown')
  })

  it('clamps the page index into range', () => {
    const rows = Array.from({ length: OVERVIEW_PAGE_SIZE + 3 }, (_, index) => row(String(index)))
    expect(pageOf(rows, 0).count).toBe(2)
    expect(pageOf(rows, 99).index).toBe(1)
    expect(pageOf(rows, -5).index).toBe(0)
  })

  it('groups rows by workspace and counts the ungrouped bucket', () => {
    const workspaces = { items: [{ path: '/w', title: 'W', sessionIds: ['a'] }] }
    const chips = groupCountsOf([row('a'), row('b')], workspaces)
    expect(chips).toEqual([{ key: '/w', count: 1 }, { key: UNGROUPED_KEY, count: 1 }])
  })
})

describe('totals', () => {
  it('sums the billed buckets, or reports absence', () => {
    expect(usageTotalsOf(null)).toBeNull()
    expect(usageTotalsOf({ p: { m: { peak: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 } } } })?.total).toBe(10)
  })

  it('splits cost coverage from usage coverage in the KPI band', () => {
    const priced = row('priced', {
      familyCost: { 'deepseek-official': { 'deepseek-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    })
    const unpriced = row('unpriced', {
      familyCost: { 'unknown-proxy': { 'mystery': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    })
    const kpis = kpisOf([priced, unpriced], 2, null, null, null, 'usd')
    expect(kpis.usageSessions).toBe(2)
    expect(kpis.costSessions).toBe(1)
    expect(kpis.sessions).toBe(2)
  })

  it('reports a missing row figure as a dash-source (null), not zero', () => {
    expect(billedOf(row('a'))).toBeNull()
    expect(turnsOf(row('a'))).toBe(0)
    expect(createdDayOf(row('a'))).toBeNull()
  })
})
