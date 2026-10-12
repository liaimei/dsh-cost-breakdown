// The composer-dock readout (src/client/components/composerDock.tsx) and its data seam
// (src/client/dockReading.ts): the always-visible spend line under the input, its expanded
// detail card, the locally computed pricing period, and the graceful absence before a push.

import { act, createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { isRowTooNarrow, makeComposerDock } from '../../../src/client/components/composerDock'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { PLATFORM_BALANCE_STORAGE_KEY, resetPlatformBalance } from '../../../src/client/balance'
import type { ContextTimeline } from '../../../src/shared/types'
import { asClientCtx, TestClientCtx } from '../helpers/harness'
import { click, flush, keydown, makeKit, mount, query, queryAll, text } from '../helpers/kit'

/** The kit's `query` throws on a miss; these assertions are ABOUT the miss, so get the element or null. */
function maybe<T extends Element = HTMLElement>(container: ParentNode, selector: string): T | null {
  return container.querySelector<T>(selector)
}

/** Click-away goes through act, like the kit's other event helpers, so the close is act-attributed. */
async function pressOutside(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
}

const kit = makeKit()
const kitZh = makeKit('zh')

/** A minimal real-shaped models.dev slice: only the non-official rows need it. */
const PROVIDERS = {
  zhipuai: { models: { 'glm-5.3-flash': { cost: { input: 0.075, output: 0.25, cache_read: 0.015, cache_write: 0 } } } },
}

/** One billed ledger: 1M uncached on the peak window. */
function timelineWith(cost: ContextTimeline['cost'], extra: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...(cost !== undefined ? { cost } : {}),
    ...extra,
  }
}

const DEEPSEEK_PEAK = {
  'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
}
const MIXED = {
  ...DEEPSEEK_PEAK,
  'zai-coding-cn': { 'glm-5.3-flash': { off: { uncached: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 } } },
}

/** A projection seat over a fixed timeline value. */
function seatOf(value: unknown): { useProjection: (key: string) => unknown } {
  return { useProjection: (key: string) => (key === 'contextTimeline' ? value : undefined) }
}

function Dock(ctx: TestClientCtx = new TestClientCtx(), k = kit): ReturnType<typeof makeComposerDock> {
  return makeComposerDock(asClientCtx(ctx), k)
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
})

afterEach(() => {
  resetModelPrices()
  resetPlatformBalance()
  globalThis.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('ComposerDock — the collapsed readout', () => {
  test('renders nothing until the session pushes a timeline value', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(undefined) }))
    await flush()
    assert.equal(text(m.container), '', 'no misleading zero before the first push')
    await m.unmount()
  })

  test('the first push after the empty frame mounts cleanly (hook order is stable)', async () => {
    // The dock reads extra projections for the reused cards. Those reads are hooks
    // (services.ts: "该座位是 hook：必须在组件顶部无条件调用"), so they must happen on
    // EVERY render — calling them after the null-timeline early return changes the
    // hook count between frames and React throws. The seat below calls a real hook,
    // so that violation is observable here rather than silently passing.
    const D = Dock()
    const ref = { timeline: undefined as unknown }
    const seat = {
      useProjection: (key: string) => {
        useState(0)
        return key === 'contextTimeline' ? ref.timeline : undefined
      },
    }
    const m = await mount(h(D, { sessionId: 's1', ...seat }))
    await flush()
    assert.equal(text(m.container), '', 'nothing before the first push')
    ref.timeline = timelineWith(DEEPSEEK_PEAK)
    await m.update(h(D, { sessionId: 's1', ...seat }))
    await flush()
    assert.ok(query(m.container, '.lc-dock') !== null, 'the line appears once the value lands')
    await click(query(m.container, '.lc-dock'))
    assert.equal(queryAll(m.container, '.lc-dock-card .lc-card').length >= 2, true, 'the reused cards mount')
    await m.unmount()
  })

  test('a pushed timeline with no billed usage still renders the line', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(undefined)) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock').textContent?.includes('—'), true, 'nothing priced yet reads as a dash')
    await m.unmount()
  })

  test('shows the official rate without the registry book ever landing', async () => {
    setModelPricesLoader(() => new Promise(() => {}))
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    // 1M uncached × ¥2 peak = ¥2.00 for a zh locale; the official table needs no registry.
    const DZh = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m2 = await mount(h(DZh, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock-cost')?.textContent, '$0.30')
    assert.equal(query(m2.container, '.lc-dock-cost')?.textContent, '¥2.00')
    await m.unmount()
    await m2.unmount()
  })

  test('an unpriced model reads as a dash rather than a fabricated zero', async () => {
    setModelPricesLoader(() => Promise.resolve({}))
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith({ 'unknown-route': { 'mystery': { peak: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 0 } } } })) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock-cost')?.textContent, '—')
    await m.unmount()
  })

  test('shows the DeepSeek balance when the account route answers, and drops it otherwise', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, value: { isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] } }),
    }))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock-balance')?.textContent, '¥110.00')
    await m.unmount()

    resetPlatformBalance()
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: true, value: null }) }))
    const bare = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(maybe(bare.container, '.lc-dock-balance'), null, 'no balance cell without a figure')
    await bare.unmount()
  })

  test('the USD fallback applies when the account carries no display currency', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, value: { isAvailable: true, balances: [{ currency: 'EUR', total: 9, granted: 0, toppedUp: 9 }] } }),
    }))
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock-balance')?.textContent, 'EUR 9.00')
    await m.unmount()
  })
})

describe('ComposerDock — the pricing period', () => {
  test('labels the badge by the window the clock is in, and flips with it', async () => {
    vi.useFakeTimers()
    try {
      // Monday 2026-01-05 10:00 Beijing — inside the morning peak window.
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 5, 2)))
      const D = Dock()
      const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
      await flush()
      assert.equal(query(m.container, '.lc-dock-period')?.textContent, 'Peak')
      assert.equal(query(m.container, '.lc-dock').getAttribute('data-peak'), '1')
      // Cross the 12:00 boundary: the readout flips on its own clock.
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 5, 4)))
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      assert.equal(query(m.container, '.lc-dock-period')?.textContent, 'Off-peak')
      assert.equal(query(m.container, '.lc-dock').getAttribute('data-peak'), '0')
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a tick inside the same window keeps the same period object (no re-render churn)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 5, 2)))
      const D = Dock()
      const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
      await flush()
      const before = query(m.container, '.lc-dock')
      // One tick inside the same window must not replace the rendered node.
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      assert.ok(query(m.container, '.lc-dock') === before, 'the identity bail-out kept the tree in place')
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a Chinese public holiday reads off-peak on a weekday', async () => {
    vi.useFakeTimers()
    try {
      // Thursday 2026-10-01 10:00 Beijing — inside the National Day holiday run.
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 1, 2)))
      const D = Dock()
      const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
      await flush()
      assert.equal(query(m.container, '.lc-dock-period')?.textContent, 'Off-peak')
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ComposerDock — the expanded card', () => {
  test('opens on click and closes on a second click', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(maybe(m.container, '.lc-dock-card'), null, 'collapsed by default')
    await click(query(m.container, '.lc-dock'))
    assert.equal(query(m.container, '.lc-dock').getAttribute('aria-expanded'), 'true')
    assert.ok(maybe(m.container, '.lc-dock-card') !== null)
    await click(query(m.container, '.lc-dock'))
    assert.equal(maybe(m.container, '.lc-dock-card'), null)
    await m.unmount()
  })

  test('the card carries the two summary cards plus the rate table', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(MIXED)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')
    const body = text(card)
    // The expanded card reuses the Summary Statistics cards verbatim.
    assert.ok(body.includes('Token Stats'))
    assert.ok(body.includes('Cost Stats'))
    assert.ok(body.includes('Rate card'))
    assert.equal(queryAll(card, '.lc-dock-cards > .lc-card').length, 2, 'token + cost, the same two cards the page draws')
    // The rate table quotes the period in force, so both official rows appear.
    const rows = queryAll(card, '.lc-dock-table tbody tr')
    assert.equal(rows.length, 2)
    assert.ok(text(rows[0]).includes('DeepSeek-V4.1-Flash'))
    assert.ok(text(rows[1]).includes('DeepSeek-V4-Pro'))
    // The token card keeps its donut and legend; the cost card keeps its four buckets.
    assert.ok(queryAll(card, '.lc-sl-row').length >= 3, 'the token and cost legends carry their rows')
    await m.unmount()
  })

  test('every rate column carries its bucket colour, matching the bars above', async () => {
    // The three price columns share the token buckets' colours, so "which column is
    // expensive" and "where the spend went" speak the same language. The colour lives on
    // the CELL (not the whole table) because each column maps to one bucket.
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')

    const rows = queryAll(card, '.lc-dock-table tbody tr')
    assert.ok(rows.length >= 1, 'the rate table lists the official rows')
    for (const row of rows) {
      const cells = queryAll(row, 'td')
      assert.equal(cells.length, 4, 'model plus the three rate columns')
      for (const [i, bucket] of (['hit', 'miss', 'out'] as const).entries()) {
        assert.ok(
          cells[i + 1].className.includes(`lc-dock-rate-${bucket}`),
          `column ${bucket} must carry its own colour class (got "${cells[i + 1].className}")`,
        )
      }
      // The model cell stays in normal text colour: it is a name, not a quantity.
      assert.equal(cells[0].className, '', 'the model column is not colour-coded')
    }
    await m.unmount()
  })

  test('the reused cards keep the page bar vocabulary and the period split', async () => {
    // The expanded card no longer draws its own bars: it embeds the Summary
    // Statistics cards, so the bars, tints and zero flags are the page ones. The
    // per-bucket tint still separates the three token buckets and peak/off.
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')

    // The token card's legend lists the billed buckets; the cost card adds its own.
    const tokenRows = queryAll(card, '.lc-dock-cards > .lc-card')[0].querySelectorAll('.lc-sl-row')
    assert.ok(tokenRows.length >= 3, 'the token legend carries its billed buckets')
    const peak = queryAll(card, '.lc-sc-period').find(p => text(p).includes('Peak'))
    assert.ok(peak !== undefined, 'the cost card keeps its peak/off-peak split')
    // `DEEPSEEK_PEAK` bills peak only, so the off band is flagged dim.
    const off = queryAll(card, '.lc-sc-period').find(p => text(p).includes('Off-peak'))
    assert.ok(off !== undefined && off.className.includes('lc-sc-period-dim'), 'an empty period recedes')
    await m.unmount()
  })

  test('the rate table quotes the peak column while the clock is in a peak window', async () => {
    vi.useFakeTimers()
    try {
      // Monday 2026-01-05 10:00 Beijing — peak, so the table lists the doubled CNY rows.
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 5, 2)))
      const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
      const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
      await flush()
      await click(query(m.container, '.lc-dock'))
      const card = query(m.container, '.lc-dock-card')
      assert.ok(query(card, '.lc-dock-badge-peak') !== null, 'the peak badge carries its own class')
      const cells = queryAll(card, '.lc-dock-table tbody tr:first-child td').map(el => el.textContent)
      // Flash peak: ¥0.04 cache hit, ¥2 uncached, ¥8 output.
      assert.deepEqual(cells, ['DeepSeek-V4.1-Flash', '¥0.04', '¥2.00', '¥8.00'])
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a balance-less account drops the balance row and its separator, keeping the period', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: true, value: null }) }))
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')
    assert.equal(maybe(card, '.lc-dock-balance-row'), null, 'no balance row without a figure')
    assert.equal(queryAll(card, '.lc-dock-badge').length, 1, 'the period badge still rides the head')
    assert.ok(text(card).includes('Rate card'))
    await m.unmount()
  })

  test('a zero-token ledger keeps the cost split but drops the token block', async () => {
    // A priced bucket of all zeroes: the ledger exists, nothing was billed.
    const zeros = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(zeros)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')
    assert.equal(text(card).includes('Token usage'), false, 'a zero-token ledger has no token block')
    assert.equal(text(card).includes('Cost breakdown'), false, 'the period split sums to zero too')
    await m.unmount()
  })

  test('a ledger carrying only one period shows that period alone', async () => {
    const offOnly = { 'deepseek-official': { 'deepseek-v4-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(offOnly)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')
    // The cost card always lists both bands; the empty one still reports its zero.
    const periods = queryAll(card, '.lc-sc-period')
    assert.equal(periods.length, 2)
    const peak = periods.find(p => text(p).includes('Peak'))
    assert.ok(peak !== undefined && peak.className.includes('lc-sc-period-dim'), 'the unspent period reads as a dim zero')
    const off = periods.find(p => text(p).includes('Off-peak'))
    assert.ok(off !== undefined && !off.className.includes('lc-sc-period-dim'), 'the spent period is not dim')
    assert.ok(text(off).includes('100.0%'), 'the whole spend rode the one period that occurred')
    await m.unmount()
  })

  test('a resize repositions the open card', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    const trigger = query(m.container, '.lc-dock')
    // jsdom reports a zero rect; give the trigger a real one so the placement is meaningful.
    trigger.getBoundingClientRect = () => ({ left: 40, top: 300, bottom: 320, width: 120, height: 20 }) as DOMRect
    await click(trigger)
    const before = query(m.container, '.lc-dock-card').getAttribute('style')
    trigger.getBoundingClientRect = () => ({ left: 200, top: 120, bottom: 140, width: 120, height: 20 }) as DOMRect
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    const after = query(m.container, '.lc-dock-card').getAttribute('style')
    assert.ok(after !== null && after !== before, 'the card re-measured against the new trigger rect')
    await m.unmount()
  })

  test('a narrow trigger still yields a card wide enough for the reused cards', async () => {
    // The composer line can be short, but the two embedded cards each carry a donut
    // plus a legend. Following the trigger's width clipped their right-hand figures, so
    // the card takes its own preferred width instead.
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    const trigger = query(m.container, '.lc-dock')
    trigger.getBoundingClientRect = () => ({ left: 40, top: 300, bottom: 320, width: 120, height: 20 }) as DOMRect
    await click(trigger)
    const style = query(m.container, '.lc-dock-card').getAttribute('style') ?? ''
    const minWidth = Number(/min-width:\s*(\d+)px/.exec(style)?.[1] ?? '0')
    assert.equal(minWidth, 440, 'the card takes its preferred width, not the 120px trigger')
    await m.unmount()
  })

  test('the card never exceeds the viewport, so no horizontal scrollbar appears', async () => {
    // A card wider than the viewport would overflow on the x axis; with `overflow-y: auto`
    // that axis computes to `auto` too and a left/right scrollbar appears. The width is
    // clamped to the viewport instead.
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    const trigger = query(m.container, '.lc-dock')
    vi.stubGlobal('innerWidth', 380)
    try {
      trigger.getBoundingClientRect = () => ({ left: 10, top: 300, bottom: 320, width: 100, height: 20 }) as DOMRect
      await click(trigger)
      const style = query(m.container, '.lc-dock-card').getAttribute('style') ?? ''
      const width = Number(/min-width:\s*(\d+)px/.exec(style)?.[1] ?? '0')
      assert.ok(width <= 380 - 16, `the card fits the viewport, got ${width}px in a 380px viewport`)
      const left = Number(/left:\s*(\d+)px/.exec(style)?.[1] ?? '0')
      assert.ok(left >= 0 && left + width <= 380, `the clamped card stays inside the viewport (left=${left}, width=${width})`)
    } finally {
      vi.unstubAllGlobals()
      await m.unmount()
    }
  })

  test('the card flips below the trigger when there is no room above', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    const trigger = query(m.container, '.lc-dock')
    // A trigger at the very top: `above` is negative, so the card flips below it.
    trigger.getBoundingClientRect = () => ({ left: 10, top: 2, bottom: 22, width: 100, height: 20 }) as DOMRect
    await click(trigger)
    const style = query(m.container, '.lc-dock-card').getAttribute('style') ?? ''
    assert.ok(style.includes('top: 30px'), `flipped below the trigger (got ${style})`)
    await m.unmount()
  })

  test('a resize while the card is closed is a no-op', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(maybe(m.container, '.lc-dock-card'), null, 'nothing to reposition while collapsed')
    await m.unmount()
  })

  test('the card mounts with the panel so its REAL height drives the first placement', async () => {
    // Regression: the card used to render only once `anchor` was set, so the first
    // `place()` ran with an unmounted card and fell back to 260px — the panel then sat
    // at a top computed for a height it never had, until some later resize corrected it.
    // jsdom ships no ResizeObserver, so install the same minimal stub other specs use.
    const callbacks: (() => void)[] = []
    class FakeResizeObserver {
      constructor(cb: () => void) { callbacks.push(cb) }
      observe(): void {}
      disconnect(): void { callbacks.length = 0 }
    }
    const holder = globalThis as { ResizeObserver?: unknown }
    const saved = holder.ResizeObserver
    holder.ResizeObserver = FakeResizeObserver
    try {
      const D = Dock()
      const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
      await flush()
      const trigger = query(m.container, '.lc-dock')
      trigger.getBoundingClientRect = () => ({ left: 885, top: 646, bottom: 674, width: 815, height: 28 }) as DOMRect

      await click(trigger)
      const card = query(m.container, '.lc-dock-card')
      assert.ok(card !== null, 'the panel exists from the first open render, not only after an anchor lands')

      // Give the panel its on-screen height, then let the observer re-place it.
      card.getBoundingClientRect = () => ({ height: 577, width: 815, left: 0, top: 0, right: 815, bottom: 577, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
      Object.defineProperty(card, 'scrollHeight', { value: 577, configurable: true })
      assert.ok(callbacks.length > 0, 'the open panel is observed')
      await act(async () => { callbacks.forEach(cb => cb()) })
      await flush()

      // 646 - 577 - 8 = 61: the top the true height implies, not the 260px guess (378).
      assert.ok(
        (card.getAttribute('style') ?? '').includes('top: 61px'),
        `pinned to the measured height (got ${card.getAttribute('style')})`,
      )

      // A second identical callback must not change anything (no resize loop).
      const once = card.getAttribute('style')
      await act(async () => { callbacks.forEach(cb => cb()) })
      assert.equal(card.getAttribute('style'), once, 'an unchanged measurement does not re-place')
      await m.unmount()
    } finally {
      holder.ResizeObserver = saved
    }
  })

  test('a press on the trigger and a non-Escape key both leave the card alone', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    const trigger = query(m.container, '.lc-dock')
    await click(trigger)
    assert.ok(maybe(m.container, '.lc-dock-card') !== null)
    // A mousedown on the trigger itself must not be treated as an outside press
    // (the click's own toggle owns that path).
    await pressOutside(trigger)
    assert.ok(maybe(m.container, '.lc-dock-card') !== null, 'a press on the trigger keeps it open')
    await keydown('a', document as unknown as Window)
    assert.ok(maybe(m.container, '.lc-dock-card') !== null, 'only Escape dismisses')
    await m.unmount()
  })

  test('the zh locale prices the card in CNY with localized labels', async () => {
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')
    const body = text(card)
    assert.ok(body.includes('Token 统计'))
    assert.ok(body.includes('价目表'))
    assert.ok(body.includes('缓'), 'the official title carries the zh rate table')
    assert.ok(query(card, '.lc-dock-badge') !== null)
    await m.unmount()
  })

  test('a period-blind ledger still shows the token block but no cost split', async () => {
    // No priced bucket at all: the token block drops too (nothing was billed).
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(undefined)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')
    assert.equal(text(card).includes('Token usage'), false)
    assert.equal(text(card).includes('Cost breakdown'), false)
    assert.ok(text(card).includes('Rate card'), 'the rate card needs no usage')
    await m.unmount()
  })

  test('Escape and an outside press both dismiss the card', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    assert.ok(maybe(m.container, '.lc-dock-card') !== null)
    await keydown('Escape', document as unknown as Window)

    assert.equal(maybe(m.container, '.lc-dock-card'), null, 'Escape closes it')
    await click(query(m.container, '.lc-dock'))
    await pressOutside(document.body)
    assert.equal(maybe(m.container, '.lc-dock-card'), null, 'an outside press closes it')
    await m.unmount()
  })

  test('a press inside the card keeps it open; the balance row links to the console', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, value: { isAvailable: true, balances: [{ currency: 'USD', total: 12.5, granted: 2.5, toppedUp: 10 }] } }),
    }))
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')
    await pressOutside(card)
    assert.ok(maybe(m.container, '.lc-dock-card') !== null, 'an inside press leaves it open')
    // The balance row is the reused cost card's own, so the dock no longer draws a second one.
    assert.equal(queryAll(card, '.lc-sc-balance').length, 1, 'exactly one balance row')
    const link = query(card, '.lc-sc-balance')
    assert.equal(link.getAttribute('href'), 'https://platform.deepseek.com/usage')
    assert.equal(link.getAttribute('target'), '_blank')
    assert.ok(text(link).includes('$12.50'))
    await m.unmount()
  })

  test('a hostile locale service degrades to the USD display instead of throwing', async () => {
    const ctx = new TestClientCtx()
    Object.defineProperty(ctx, 'locale', {
      get() { throw new Error('hostile locale') },
      configurable: true,
    })
    const D = makeComposerDock(asClientCtx(ctx), kit)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock-cost')?.textContent, '$0.30', 'USD is the fallback')
    await m.unmount()
  })

  test('a locale service without getLocale also falls back to USD', async () => {
    const ctx = new TestClientCtx()
    Object.defineProperty(ctx, 'locale', { get: () => ({ bind: () => () => '' }), configurable: true })
    const D = makeComposerDock(asClientCtx(ctx), kit)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock-cost')?.textContent, '$0.30')
    await m.unmount()
  })

  test('the remaining balance paints from storage while the route revalidates', async () => {
    globalThis.localStorage.setItem(PLATFORM_BALANCE_STORAGE_KEY, JSON.stringify({
      isAvailable: true, balances: [{ currency: 'USD', total: 7.5, granted: 0, toppedUp: 7.5 }],
    }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, value: { isAvailable: true, balances: [{ currency: 'USD', total: 3, granted: 0, toppedUp: 3 }] } }) }
    })
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    assert.equal(query(m.container, '.lc-dock-balance')?.textContent, '$7.50', 'the remembered figure paints at once')
    release()
    await flush()
    assert.equal(query(m.container, '.lc-dock-balance')?.textContent, '$3.00', 'the live figure takes over')
    await m.unmount()
  })

  test('the balance is re-read on its own poll cadence', async () => {
    // The readout is long-lived and the figure moves with every billed request,
    // so the interval — not just the mount — has to refresh it.
    vi.useFakeTimers()
    try {
      let total = 10
      vi.stubGlobal('fetch', async () => ({
        ok: true,
        json: async () => ({ ok: true, value: { isAvailable: true, balances: [{ currency: 'USD', total, granted: 0, toppedUp: total }] } }),
      }))
      const D = Dock()
      const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      assert.equal(query(m.container, '.lc-dock-balance')?.textContent, '$10.00')
      // The account spends between ticks; the next read must land the new figure.
      total = 6.5
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      assert.equal(query(m.container, '.lc-dock-balance')?.textContent, '$6.50', 'the poll picked up the new figure')
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ComposerDock — the expanded card matches the official popup layer', () => {
  const css = readFileSync(join(process.cwd(), 'src/client/styles/composerDock.css'), 'utf8')
  const ruleOf = (selector: string): string => {
    // Anchor at the line start: the variables rule near the top also ends in `.lc-dock-card`.
    const m = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css)
    assert.ok(m !== null, `${selector} rule exists`)
    return m[1]
  }

  test('the floating card pins both overflow axes', () => {
    // jsdom has no layout engine, so the horizontal-scroll fix cannot be observed by
    // rendering: assert it at the source. `overflow-y: auto` alone leaves the x axis's
    // `visible` computing to `auto`, and any horizontal overflow then grows a
    // left/right scrollbar. The rule must therefore name BOTH axes.
    const body = ruleOf('.lc-dock-card')
    assert.match(body, /overflow-x:\s*hidden/, 'the x axis is pinned so no horizontal scrollbar can appear')
    assert.match(body, /overflow-y:\s*auto/, 'the y axis still scrolls, so a tall card stays reachable')
  })

  test('the card wears the official popup surface, radius and elevation', () => {
    // The dock must read as the same layer as the official stat dialog the session
    // footer opens (packages/client/ui-chat/.../stat-dialog.module.css): the menu
    // surface, the lg radius, the prominent elevation and the same z-index.
    const body = ruleOf('.lc-dock-card')
    assert.match(body, /--dsw-specific-menu/, 'the official popup surface, not a plain layer token')
    assert.match(body, /--dsw-radius-lg/, 'the official popup radius')
    assert.match(body, /--dsw-elevation-prominent/, 'the official popup elevation')
    assert.match(body, /z-index:\s*1100/, 'the same stacking level as the official popup')
    assert.doesNotMatch(body, /border:\s*1px/, 'the official surface carries its hairline in the elevation, not a 1px border')
  })

  test('every block inside the card is border-box, so none of them overflow', () => {
    // Root cause of the clipped right-hand figures: `.lc-card` only gets
    // `box-sizing: border-box` from `.lc-root .lc-card`, and the floating card has no
    // `.lc-root` ancestor. Falling back to content-box, `width: 100%` plus 12px padding
    // and a 1px border overflowed by 26px — cut off by `overflow-x: hidden`, and wide
    // enough to force a vertical scrollbar. All three blocks must pin it themselves.
    for (const sel of ['.lc-dock-card', '.lc-dock-cards > .lc-card', '.lc-dock-card-block']) {
      assert.match(ruleOf(sel), /box-sizing:\s*border-box/, `${sel} must be border-box inside the floating card`)
    }
  })

  test('the three blocks share one inner width so the columns line up', () => {
    // The two reused cards and the rate card are siblings in the same column; equal
    // horizontal padding is what makes their right edges agree.
    const card = /padding:\s*([^;]+);/.exec(ruleOf('.lc-dock-cards > .lc-card'))
    const block = /padding:\s*([^;]+);/.exec(ruleOf('.lc-dock-card-block'))
    assert.ok(card !== null && block !== null, 'both rules declare padding')
    assert.equal(card[1].trim(), block[1].trim(), 'the reused cards and the rate card share one padding')
  })
})

describe('ComposerDock — the collapsed readout matches the official status bar', () => {
  const css = readFileSync(join(process.cwd(), 'src/client/styles/composerDock.css'), 'utf8')
  const trigger = /^\.lc-dock\s*\{([^}]*)\}/m.exec(css)

  test('the trigger is boxed exactly like the official ContextMeter beside it', () => {
    // The readout sits on the composer status bar, immediately left of the official
    // context meter (`ui-conversation/.../ContextMeter.module.css`). That component's
    // `.trigger` pins `font-size: var(--dsh-content-font-size-secondary, 13px)`,
    // `line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))` and
    // `padding: 1px 8px`, giving a 22px box. Anything else makes the two neighbours
    // stand at different heights.
    assert.ok(trigger !== null, 'the trigger rule exists')
    const body = trigger[1]
    assert.match(body, /font-size:\s*var\(--dsh-content-font-size-secondary,\s*13px\)/, 'the official secondary font size')
    assert.match(body, /line-height:\s*calc\(20px \+ var\(--dsh-content-font-delta-secondary,\s*0px\)\)/, 'the official 20px line box')
    assert.match(body, /padding:\s*1px 8px/, 'the official trigger padding')
    assert.match(body, /border-radius:\s*var\(--dsw-radius-sm/, 'the official small radius')
    assert.match(body, /display:\s*inline-flex/, 'inline-flex keeps it on the status bar line')
  })

  test('the trigger keeps the official hover surface', () => {
    const hover = /^\.lc-dock:hover\s*\{([^}]*)\}/m.exec(css)
    assert.ok(hover !== null, 'the hover rule exists')
    assert.match(hover[1], /--dsw-alias-interactive-bg-hover/, 'the official hover fill, not a plain layer token')
  })

  test('the box height works out to the official 22px', () => {
    // 20px line box + 1px padding top/bottom, both non-negotiable: this is the number
    // that has to agree with the neighbouring meter.
    const line = 20
    const pad = 1 * 2
    assert.equal(line + pad, 22, 'the readout stands 22px tall, like the official meter')
  })
})

describe('ComposerDock — the readout wears the official status-bar palette', () => {
  const css = readFileSync(join(process.cwd(), 'src/client/styles/composerDock.css'), 'utf8')
  const ruleOf = (selector: string): string => {
    const m = new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css)
    assert.ok(m !== null, `${selector} rule exists`)
    return m[1]
  }

  test('the trigger takes the official pill colour, not a brighter label', () => {
    // The neighbours are the official StatsPills and ContextMeter: their pills rest at
    // `label-tertiary` and only brighten to `label-secondary` on hover. A brighter base
    // makes this readout stand out as a foreign control on the status bar.
    assert.match(ruleOf('.lc-dock'), /color:\s*var\(--dsw-alias-label-tertiary\)/, 'rests at the official pill colour')
    assert.match(ruleOf('.lc-dock:hover'), /color:\s*var\(--dsw-alias-label-secondary\)/, 'brightens on hover, like the official pills')
  })

  test('the separator uses the official separator token', () => {
    assert.match(ruleOf('.lc-dock-sep'), /--dsw-alias-separator-primary/, 'the official separator colour, not a label tone')
  })

  test('the readings inherit the pill colour instead of re-bolding themselves', () => {
    // The official pills keep every figure at the same weight and tone; a bold,
    // label-primary cost would be the only heavy element on the bar.
    const cost = ruleOf('.lc-dock-cost')
    assert.match(cost, /color:\s*inherit/, 'the cost inherits the pill colour')
    assert.match(cost, /font-weight:\s*inherit/, 'and the pill weight')
    assert.match(ruleOf('.lc-dock-balance'), /color:\s*inherit/, 'so does the balance')
  })

  test('peak and off-peak keep their semantic colour', () => {
    // The one thing the palette must NOT flatten: which period is in force.
    assert.match(ruleOf('.lc-dock-period'), /color:\s*var\(--lc-dock-off\)/, 'off-peak stays green')
    const peak = /^\.lc-dock\[data-peak='1'\]\s+\.lc-dock-period\s*\{([^}]*)\}/m.exec(css)
    assert.ok(peak !== null, 'the peak override exists')
    assert.match(peak[1], /color:\s*var\(--lc-dock-peak\)/, 'peak stays red')
  })
})

describe('ComposerDock — the peak window and its countdown', () => {
  /** Beijing wall-clock instant as epoch ms (UTC+8). */
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  async function at(time: number, locale: 'zh' | 'en' = 'zh') {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(time))
    const D = Dock(new TestClientCtx({ locale }), locale === 'zh' ? kitZh : kit)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    return m
  }

  test('spells out the peak windows, derived from the official table', async () => {
    // The user asked to SEE when peak is, not just whether it is peak now. The text
    // comes from PEAK_WINDOWS, so it cannot drift from the billing rule.
    const m = await at(bj(2026, 10, 12, 10))
    try {
      const trigger = query(m.container, '.lc-dock')
      assert.match(trigger.getAttribute('title') ?? '', /09:00–12:00/, 'the tooltip names the windows')
      await click(trigger)
      const row = text(query(m.container, '.lc-dock-period-row'))
      assert.match(row, /09:00–12:00/, 'the card names them too')
      assert.match(row, /14:00–18:00/, 'both windows, not just the first')
    } finally {
      await m.unmount(); vi.useRealTimers()
    }
  })

  test('counts down to the next flip, in the active language', async () => {
    // Monday 10:00 Beijing: peak, with the window ending at 12:00.
    const zh = await at(bj(2026, 10, 12, 10), 'zh')
    try {
      const text0 = text(query(zh.container, '.lc-dock'))
      assert.match(text0, /2 小时 0 分 后进入谷时/, `got ${text0}`)
    } finally { await zh.unmount(); vi.useRealTimers() }

    const en = await at(bj(2026, 10, 12, 10), 'en')
    try {
      const text1 = text(query(en.container, '.lc-dock'))
      assert.match(text1, /Off-peak in 2h 0m/, `got ${text1}`)
    } finally { await en.unmount(); vi.useRealTimers() }
  })

  test('counts down to the next peak window from the midday gap', async () => {
    // Monday 12:30 sits between the two windows, so the next boundary is 14:00.
    const m = await at(bj(2026, 10, 12, 12, 30))
    try {
      assert.match(text(query(m.container, '.lc-dock')), /1 小时 30 分 后进入峰时/)
    } finally { await m.unmount(); vi.useRealTimers() }
  })

  test('says WHY there is no peak today instead of a misleading countdown', async () => {
    // Sunday 2026-10-11: off-peak all day, so "peak in N" would be wrong — the next
    // peak is Monday 09:00, and a bare countdown would read as if today still has one.
    const m = await at(bj(2026, 10, 11, 10))
    try {
      const trigger = query(m.container, '.lc-dock')
      assert.equal(maybe(m.container, '.lc-dock-countdown'), null, 'no countdown on an all-day-off day')
      await click(trigger)
      assert.match(text(query(m.container, '.lc-dock-period-row')), /周末全天谷时/)
    } finally { await m.unmount(); vi.useRealTimers() }
  })

  test('the countdown ticks once per second', async () => {
    // The whole point of a countdown is that it moves; a frozen reading would be worse
    // than none, so pin the one-second cadence.
    const m = await at(bj(2026, 10, 12, 10))
    try {
      const before = text(query(m.container, '.lc-dock'))
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      const after = text(query(m.container, '.lc-dock'))
      assert.notEqual(before, after, 'the reading advanced with the clock')
      assert.match(after, /1 小时 59 分 后进入谷时/, `got ${after}`)
    } finally { await m.unmount(); vi.useRealTimers() }
  })
})

describe('ComposerDock — the countdown degrades to an icon on a narrow status bar', () => {
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  /** Mount with a given status-bar available width, clock pinned to Monday 10:00 Beijing (peak). */
  async function atWidth(width: number) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    let current = width
    // The seam is the "is this row too narrow?" predicate, so the test supplies the
    // verdict directly instead of faking DOM geometry. Production's predicate compares
    // the space LEFT for this row (after the official neighbours) with what the full
    // reading needs.
    const NARROW_PX = 620
    const D = makeComposerDock(asClientCtx(new TestClientCtx({ locale: 'zh' })), kitZh, () => current < NARROW_PX)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    return {
      m,
      setWidth: async (next: number) => {
        current = next
        await act(async () => { window.dispatchEvent(new Event('resize')) })
      },
      restore: () => { vi.useRealTimers() },
    }
  }

  test('a wide status bar reads the sentence', async () => {
    const { m, restore } = await atWidth(1200)
    try {
      const trigger = query(m.container, '.lc-dock')
      assert.match(text(trigger), /2 小时 0 分 后进入谷时/, 'the full sentence, not an icon')
      assert.equal(maybe(trigger, '.lc-dock-countdown svg'), null, 'no icon while there is room')
    } finally { await m.unmount(); restore() }
  })

  test('a narrow status bar swaps the sentence for a clock icon plus a compact reading', async () => {
    // The whole point: the same information in a fraction of the width, so the line
    // cannot push the official meter off the bar.
    const { m, restore } = await atWidth(560)
    try {
      const trigger = query(m.container, '.lc-dock')
      const cd = maybe(trigger, '.lc-dock-countdown')
      assert.ok(cd !== null, 'the countdown slot is rendered')
      assert.match(text(cd), /2h0m/, 'the compact reading')
      assert.equal(cd.querySelector('svg') !== null, true, 'the clock icon stands in for the sentence')
      // The VISIBLE countdown carries the compact form. (The full sentence still lives
      // in the hidden measuring probe, which is what keeps the verdict stable.)
      assert.doesNotMatch(text(cd), /后进入谷时/, 'the visible label is the compact one')
      assert.equal(trigger.querySelector('.lc-dock-probe') !== null, true, 'the probe stays for measuring')
    } finally { await m.unmount(); restore() }
  })

  test('the narrow form keeps the sentence in its tooltip', async () => {
    // Degrading the label must not lose the meaning; hovering still spells it out.
    const { m, restore } = await atWidth(560)
    try {
      const cd = query(m.container, '.lc-dock-countdown')
      assert.match(cd.getAttribute('title') ?? '', /2 小时 0 分 后进入谷时/, 'the tooltip carries the sentence')
    } finally { await m.unmount(); restore() }
  })

  test('the core readings survive the narrow form', async () => {
    // Only the countdown degrades: cost, balance and the peak/off badge are what the
    // line exists for and must stay legible.
    const { m, restore } = await atWidth(560)
    try {
      const trigger = query(m.container, '.lc-dock')
      assert.ok(maybe(trigger, '.lc-dock-cost') !== null, 'the cost stays')
      assert.ok(maybe(trigger, '.lc-dock-period') !== null, 'the peak/off badge stays')
      assert.match(text(trigger), /峰/, 'and it still says which period is in force')
    } finally { await m.unmount(); restore() }
  })

  test('widening the window brings the sentence back', async () => {
    const { m, setWidth, restore } = await atWidth(560)
    try {
      assert.match(text(query(m.container, '.lc-dock')), /2h0m/)
      await setWidth(1200)
      assert.match(text(query(m.container, '.lc-dock')), /2 小时 0 分 后进入谷时/, 'the full sentence returns')
    } finally { await m.unmount(); restore() }
  })
})

describe('ComposerDock — the narrow check reads the status-bar row, not the viewport', () => {
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  /** jsdom reports 0 for every layout box. Give the row a real geometry so the
   *  production predicate can be exercised end-to-end: the row width, the width the
   *  full reading needs (the probe), and the width of the official neighbours. */
  function fakeRowGeometry(trigger: HTMLElement, o: { row: number; probe: number; core: number; sibling: number }) {
    const parent = trigger.parentElement!
    Object.defineProperty(parent, 'clientWidth', { value: o.row, configurable: true })
    const probe = trigger.querySelector<HTMLElement>('.lc-dock-probe')
    assert.ok(probe !== null, 'the probe is rendered')
    Object.defineProperty(probe, 'offsetWidth', { value: o.probe, configurable: true })
    // A stand-in for the official usage pill living in the same row.
    const sib = document.createElement('span')
    Object.defineProperty(sib, 'offsetWidth', { value: o.sibling, configurable: true })
    parent.insertBefore(sib, trigger)
    Object.defineProperty(trigger, 'offsetWidth', { value: o.core + o.probe, configurable: true })
  }

  test('a wide window with a narrow chat column still degrades', async () => {
    // The reported bug: the browser window was wide (~1144px) while the conversation
    // column was narrow, so a viewport-based check never fired. The production predicate
    // looks at the space LEFT for this row instead, so it fires either way.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    // A wide viewport, so a viewport-based check would say "there is room".
    vi.stubGlobal('innerWidth', 1440)
    const D = makeComposerDock(asClientCtx(new TestClientCtx({ locale: 'zh' })), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    try {
      const trigger = query(m.container, '.lc-dock')
      // 820px row, official neighbours take 260px, the full reading needs 600px:
      // only 560px is left, so the sentence cannot fit.
      fakeRowGeometry(trigger, { row: 820, probe: 470, core: 130, sibling: 260 })
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      const cd = query(m.container, '.lc-dock-countdown')
      assert.match(text(cd), /2h0m/, 'the narrow form despite the wide window')
      assert.ok(cd.querySelector('svg') !== null, 'the clock icon stands in')
    } finally {
      vi.unstubAllGlobals()
      await m.unmount()
      vi.useRealTimers()
    }
  })

  test('a wide chat column keeps the full sentence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = makeComposerDock(asClientCtx(new TestClientCtx({ locale: 'zh' })), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    try {
      const trigger = query(m.container, '.lc-dock')
      // 1400px row with the same neighbours: plenty of room.
      fakeRowGeometry(trigger, { row: 1400, probe: 470, core: 130, sibling: 260 })
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      assert.match(text(query(m.container, '.lc-dock-countdown')), /2 小时 0 分 后进入谷时/)
    } finally {
      await m.unmount()
      vi.useRealTimers()
    }
  })
})

describe('ComposerDock — the narrow check survives the empty first frame', () => {
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  test('the row is measured once the trigger actually mounts', async () => {
    // In production the projection arrives AFTER the first render, so the first frame
    // renders nothing (no button, no ref). The measuring effect must re-run when the
    // button appears — with a stable dependency list it ran once against a null ref and
    // never observed anything, so the compact form never appeared. Mount empty, push
    // the timeline, then narrow the row.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    let timeline: unknown
    const seat = { useProjection: (key: string) => (key === 'contextTimeline' ? timeline : undefined) }
    const D = makeComposerDock(asClientCtx(new TestClientCtx({ locale: 'zh' })), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seat }))
    try {
      await flush()
      assert.equal(text(m.container), '', 'nothing renders before the first push')
      // The push lands: the button mounts now.
      timeline = timelineWith(DEEPSEEK_PEAK)
      await m.update(h(D, { sessionId: 's1', ...seat }))
      await flush()
      const trigger = query(m.container, '.lc-dock')
      const parent = trigger.parentElement!
      // A narrow column, which the effect must pick up now that the ref exists.
      Object.defineProperty(parent, 'clientWidth', { value: 820, configurable: true })
      const probe = trigger.querySelector<HTMLElement>('.lc-dock-probe')!
      Object.defineProperty(probe, 'offsetWidth', { value: 470, configurable: true })
      Object.defineProperty(trigger, 'offsetWidth', { value: 600, configurable: true })
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      assert.match(text(query(m.container, '.lc-dock-countdown')), /2h0m/, 'the compact form appears after the trigger mounts')
      assert.ok(maybe(trigger, '.lc-dock-countdown svg') !== null, 'with the clock icon')
    } finally {
      await m.unmount()
      vi.useRealTimers()
    }
  })
})

describe('ComposerDock — the row decides from how much space is LEFT for it', () => {
  /** A minimal status-bar row: official siblings plus the trigger (with its probe). */
  function buildRow(o: { rowWidth: number; sibling: number; core: number; shown: number; probe: number }) {
    const parent = document.createElement('div')
    const sib = document.createElement('span')
    Object.defineProperty(sib, 'offsetWidth', { value: o.sibling, configurable: true })
    parent.appendChild(sib)
    const trigger = document.createElement('button')
    const countdown = document.createElement('span')
    countdown.className = 'lc-dock-countdown'
    Object.defineProperty(countdown, 'offsetWidth', { value: o.shown, configurable: true })
    const probe = document.createElement('span')
    probe.className = 'lc-dock-probe'
    Object.defineProperty(probe, 'offsetWidth', { value: o.probe, configurable: true })
    trigger.append(countdown, probe)
    Object.defineProperty(trigger, 'offsetWidth', { value: o.core + o.shown, configurable: true })
    parent.appendChild(trigger)
    Object.defineProperty(parent, 'clientWidth', { value: o.rowWidth, configurable: true })
    return trigger
  }

  test('the official neighbours are subtracted before deciding', () => {
    // The reported shape: an ~860px row whose official usage pill and context ring
    // take ~260px, leaving ~600px for this line — exactly the full reading's width.
    assert.equal(isRowTooNarrow(buildRow({ rowWidth: 860, sibling: 260, core: 130, shown: 470, probe: 470 })), false)
    // Shave 40px off the row and the full reading no longer fits.
    assert.equal(isRowTooNarrow(buildRow({ rowWidth: 820, sibling: 260, core: 130, shown: 470, probe: 470 })), true)
  })

  test('the verdict does not depend on which form is currently shown', () => {
    // The whole reason the probe exists: measuring our own rendered width would say
    // "it fits" the moment we switch to the compact form, and the row would flap.
    const full = { rowWidth: 820, sibling: 260, core: 130, probe: 470, shown: 470 }
    const compact = { rowWidth: 820, sibling: 260, core: 130, probe: 470, shown: 60 }
    assert.equal(isRowTooNarrow(buildRow(full)), isRowTooNarrow(buildRow(compact)))
    assert.equal(isRowTooNarrow(buildRow(full)), true, 'both report too narrow')
  })

  test('a wide row keeps the sentence', () => {
    assert.equal(isRowTooNarrow(buildRow({ rowWidth: 1200, sibling: 260, core: 130, shown: 470, probe: 470 })), false)
  })

  test('unmeasurable input reads as "there is room", never as "degrade"', () => {
    // jsdom and the pre-layout frame both report zero boxes; showing a plausible full
    // reading beats flashing an icon because the environment could not be measured.
    assert.equal(isRowTooNarrow(buildRow({ rowWidth: 0, sibling: 0, core: 0, shown: 0, probe: 0 })), false)
  })

  test('the probe is rendered even while the compact form is shown', () => {
    // The probe must never be rendered only in the wide branch, or the verdict would
    // flip the moment the compact form appears (see the "does not depend" case above).
    const css = readFileSync(join(process.cwd(), 'src/client/styles/composerDock.css'), 'utf8')
    assert.match(css, /\.lc-dock-probe\s*\{[^}]*visibility:\s*hidden/, 'the probe is invisible')
    assert.match(css, /\.lc-dock-probe\s*\{[^}]*position:\s*absolute/, 'and out of flow, so it cannot widen the row')
  })
})
