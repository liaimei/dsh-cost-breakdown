import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeOverviewUsage, usageWindowOf } from '../../../src/client/components/overviewUsage'
import type { DayTotals } from '../../../src/client/overview'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const OverviewUsage = makeOverviewUsage(kit)

// 2026-09-16 was a Wednesday; the window is its seven-day tail.
const TODAY = '2026-09-16'

function day(over: Partial<DayTotals> = {}): DayTotals {
  return { tokens: 0, requests: 0, sessions: 0, cost: null, ...over }
}

describe('usageWindowOf', () => {
  test('walks today and the six days before it, oldest first', () => {
    assert.deepEqual(usageWindowOf(TODAY), [
      '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16',
    ])
  })

  test('a corrupt today key reads as an empty window (the card degrades to its note)', () => {
    assert.deepEqual(usageWindowOf('junk'), [])
  })
})

describe('OverviewUsage — tokens only', () => {
  test('an all-empty window renders the empty note, no bars', async () => {
    const m = await mount(h(OverviewUsage, { days: {}, today: TODAY }))
    assert.ok(text(m.container).includes('No usage in the last 7 days'))
    assert.equal(queryAll(m.container, '.lc-ov-usage-bar').length, 0)
    await m.unmount()
  })

  test('a corrupt today key degrades to the empty note', async () => {
    const m = await mount(h(OverviewUsage, { days: { '2026-09-16': day({ tokens: 5 }) }, today: 'junk' }))
    assert.ok(text(m.container).includes('No usage in the last 7 days'))
    await m.unmount()
  })

  test('seven columns draw, out-of-window days are ignored, and the key names the token series', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1200, cost: 0.5 }),
        '2026-09-10': day({ tokens: 300 }),
        '2026-09-09': day({ tokens: 999_999 }),
        '2026-09-01': day({ tokens: 50_000_000 }),
      },
      today: TODAY,
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 7)
    const days = queryAll(m.container, '.lc-ov-usage-day').map(el => el.textContent)
    assert.deepEqual(days, ['09-10', '09-11', '09-12', '09-13', '09-14', '09-15', '09-16'])
    assert.ok(text(m.container).includes('Tokens'))
    await m.unmount()
  })

  test('the chart carries no money at all: cost lives in its own section', async () => {
    // Token and cost are different quantities; drawing both into one frame invites
    // comparing them. A day with a real cost must still draw only a token bar.
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 1000, cost: 12.5 }) },
      today: TODAY,
    }))
    assert.equal(text(m.container).includes('Cost'), false)
    assert.equal(queryAll(m.container, '.lc-ov-usage-cost').length, 0)
    assert.equal(queryAll(m.container, '.lc-ov-usage-rail-r').length, 0)
    // Seven day columns (each draws a token bar, however short) plus the key swatch.
    assert.equal(queryAll(m.container, '.lc-ov-usage-tokens').length, 8)
    await m.unmount()
  })

  test('bar heights scale on the token window maximum, with a floor for tiny days', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1000 }),
        '2026-09-15': day({ tokens: 100 }),
        '2026-09-14': day({ tokens: 1 }),
      },
      today: TODAY,
    }))
    const heightOf = (col: number): string =>
      (queryAll(m.container, '.lc-ov-usage-col')[col].querySelector('.lc-ov-usage-tokens') as HTMLElement).style.height
    // Columns run oldest first: 09-16 (col 6) is the maximum, 09-15 half-ish,
    // 09-14 the sliver under the 4% floor.
    assert.equal(heightOf(6), '100%')
    assert.equal(heightOf(5), '10%')
    assert.equal(heightOf(4), '4%')
    await m.unmount()
  })

  test('the frame: five gridlines with a solid baseline, and a tick rail off that maximum', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1000 }),
        '2026-09-15': day({ tokens: 250 }),
      },
      today: TODAY,
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-line').length, 5)
    assert.ok(query(m.container, '.lc-ov-usage-line-0') !== null)
    const baseline = query(m.container, '.lc-ov-usage-line-0') as HTMLElement
    assert.equal(baseline.style.bottom, '0%')
    const left = queryAll(m.container, '.lc-ov-usage-rail-l .lc-ov-usage-tick').map(el => el.textContent)
    assert.deepEqual(left, ['0', '250', '500', '750', '1.0k'])
    await m.unmount()
  })

  test('a day with requests but no tokens is the genuinely empty reading', async () => {
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 0, requests: 2, cost: 0 }) },
      today: TODAY,
    }))
    assert.equal(text(m.container).includes('No usage in the last 7 days'), true)
    await m.unmount()
  })
})
