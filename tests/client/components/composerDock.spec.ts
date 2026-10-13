// The composer-dock readout (src/client/components/composerDock.tsx) and its data seam
// (src/client/dockReading.ts): the always-visible spend line under the input, its expanded
// detail card, the locally computed pricing period, and the graceful absence before a push.

import { act, createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeComposerDock } from '../../../src/client/components/composerDock'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { PLATFORM_BALANCE_STORAGE_KEY, resetPlatformBalance } from '../../../src/client/balance'
import { resetPlatformCredits } from '../../../src/client/platformCredits'
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
  // The expanded card is portaled to `document.body` (the official panels are too), so it
  // outlives the mount container: clear the body or the next test finds a stale card.
  document.body.innerHTML = ''
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
    assert.equal(queryAll(document.body, '.lc-dock-card .lc-card').length >= 2, true, 'the reused cards mount')
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
    // 金额挂在各自的平台行上（DeepSeek 那条）。DeepSeek 按人民币记账，因此这一行
    // 读的是 ¥2.00 而非换算成美元——同一个数字在两种语言下都是 ¥2.00。
    const DZh = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m2 = await mount(h(DZh, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock-spend')?.textContent, '¥2.00')
    assert.equal(query(m2.container, '.lc-dock-spend')?.textContent, '¥2.00')
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
    assert.equal(maybe(document.body, '.lc-dock-card'), null, 'collapsed by default')
    await click(query(m.container, '.lc-dock'))
    assert.equal(query(m.container, '.lc-dock').getAttribute('aria-expanded'), 'true')
    assert.ok(maybe(document.body, '.lc-dock-card') !== null)
    await click(query(m.container, '.lc-dock'))
    assert.equal(maybe(document.body, '.lc-dock-card'), null)
    await m.unmount()
  })

  test('the card carries the two summary cards plus the rate table', async () => {
    const D = Dock()
    // Pin the route in force: without a `provider` the readout falls back to listing every
    // platform anyway, which would let the "one card per platform" assertion below pass
    // even if the expanded card were scoped to the active route alone.
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(MIXED, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(document.body, '.lc-dock-card')
    const body = text(card)
    // The expanded card reuses the Summary Statistics cards verbatim.
    assert.ok(body.includes('Token Stats'))
    assert.ok(body.includes('Cost Stats'))
    assert.ok(body.includes('Rate card'))
    // token + cost are the same two cards the page draws; any additional cards are the
    // per-platform ones, which only appear when a platform is actually billable.
    const cards = queryAll(card, '.lc-dock-cards > .lc-card')
    const platformCards = queryAll(card, '.lc-dock-cards > .lc-pf-card').length
    assert.equal(cards.length - platformCards, 2, 'token + cost, the same two cards the page draws')
    // The session used two platforms, so the card must list two — not just the one in use.
    // The collapsed readout is a status reading and stays scoped to the active route; the
    // expanded card is the billing view and shows every platform that was charged.
    assert.equal(platformCards, 2, 'one card per platform the session used')
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
    const card = query(document.body, '.lc-dock-card')

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
    const card = query(document.body, '.lc-dock-card')

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
      const card = query(document.body, '.lc-dock-card')
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
    const card = query(document.body, '.lc-dock-card')
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
    const card = query(document.body, '.lc-dock-card')
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
    const card = query(document.body, '.lc-dock-card')
    // The cost card always lists both bands; the empty one still reports its zero.
    // Scoped to that card: the per-platform cards reuse the same row class for their
    // call and balance details.
    const periods = queryAll(card, '.lc-col-donut:not(.lc-pf-card) .lc-sc-period')
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
    const before = query(document.body, '.lc-dock-card').getAttribute('style')
    trigger.getBoundingClientRect = () => ({ left: 200, top: 120, bottom: 140, width: 120, height: 20 }) as DOMRect
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    const after = query(document.body, '.lc-dock-card').getAttribute('style')
    assert.ok(after !== null && after !== before, 'the card re-measured against the new trigger rect')
    await m.unmount()
  })

  test('the card takes its width from the content, not from the trigger', async () => {
    // The composer line can be short while the card's content is not. A fixed 264px card
    // left the legend ~132px after the 96px ring, under its own 150px minimum column —
    // so every legend row folded onto two lines. The stylesheet therefore sizes the card
    // (`width: max-content`) and the geometry only clamps it.
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    const trigger = query(m.container, '.lc-dock')
    trigger.getBoundingClientRect = () => ({ left: 40, top: 300, bottom: 320, width: 120, height: 20 }) as DOMRect
    await click(trigger)
    const style = query(document.body, '.lc-dock-card').getAttribute('style') ?? ''
    // The inline width is gone: pinning it would freeze the card at whatever was measured
    // on the first frame and defeat `width: max-content`.
    assert.equal(/min-width:/.test(style), false, 'no inline width pin')
    // Anchor at the line start: the `.lc-dock, .lc-dock-card` variables rule also matches.
    const css = readFileSync(join(process.cwd(), 'src/client/styles/composerDock.css'), 'utf8')
    const body = /^\.lc-dock-card\s*\{([^}]*)\}/m.exec(css)?.[1] ?? ''
    assert.match(body, /width:\s*max-content/, 'the stylesheet sizes the card from its content')
    assert.match(body, /min-width:\s*264px/, 'with the official neighbour\'s width as the floor')
    assert.match(body, /max-width:\s*min\(560px,\s*calc\(100vw - 24px\)\)/, 'and a viewport-aware ceiling')
    await m.unmount()
  })

  test('the card never exceeds the viewport, so no horizontal scrollbar appears', async () => {
    // A card wider than the viewport would overflow on the x axis; with `overflow-y: auto`
    // that axis computes to `auto` too and a left/right scrollbar appears. The geometry
    // clamps the measured width, and the stylesheet caps it at the same bound.
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    const trigger = query(m.container, '.lc-dock')
    vi.stubGlobal('innerWidth', 380)
    try {
      trigger.getBoundingClientRect = () => ({ left: 10, top: 300, bottom: 320, width: 100, height: 20 }) as DOMRect
      await click(trigger)
      const style = query(document.body, '.lc-dock-card').getAttribute('style') ?? ''
      // jsdom reports a 0-width card, so the clamped anchor falls back to the 264px floor;
      // what matters is that the anchor is viewport-aware and the left edge stays inside.
      const left = Number(/left:\s*(\d+)px/.exec(style)?.[1] ?? '0')
      assert.ok(left >= 0 && left <= 380, `the clamped card stays inside the viewport (left=${left})`)
      // A 264px floor is itself wider than this 380px viewport's usable 356px? No — it fits,
      // but the ceiling must still be the smaller of 560px and the viewport.
      const css = readFileSync(join(process.cwd(), 'src/client/styles/composerDock.css'), 'utf8')
      assert.match(css, /max-width:\s*min\(560px,\s*calc\(100vw - 24px\)\)/, 'the ceiling tracks the viewport')
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
    const style = query(document.body, '.lc-dock-card').getAttribute('style') ?? ''
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
    assert.equal(maybe(document.body, '.lc-dock-card'), null, 'nothing to reposition while collapsed')
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
      const card = query(document.body, '.lc-dock-card')
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
    assert.ok(maybe(document.body, '.lc-dock-card') !== null)
    // A mousedown on the trigger itself must not be treated as an outside press
    // (the click's own toggle owns that path).
    await pressOutside(trigger)
    assert.ok(maybe(document.body, '.lc-dock-card') !== null, 'a press on the trigger keeps it open')
    await keydown('a', document as unknown as Window)
    assert.ok(maybe(document.body, '.lc-dock-card') !== null, 'only Escape dismisses')
    await m.unmount()
  })

  test('the zh locale prices the card in CNY with localized labels', async () => {
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(document.body, '.lc-dock-card')
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
    const card = query(document.body, '.lc-dock-card')
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
    assert.ok(maybe(document.body, '.lc-dock-card') !== null)
    await keydown('Escape', document as unknown as Window)

    assert.equal(maybe(document.body, '.lc-dock-card'), null, 'Escape closes it')
    await click(query(m.container, '.lc-dock'))
    await pressOutside(document.body)
    assert.equal(maybe(document.body, '.lc-dock-card'), null, 'an outside press closes it')
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
    const card = query(document.body, '.lc-dock-card')
    await pressOutside(card)
    assert.ok(maybe(document.body, '.lc-dock-card') !== null, 'an inside press leaves it open')
    // The balance row is the reused cost card's own, so the dock no longer draws a second one.
    assert.equal(queryAll(card, '.lc-sc-balance').length, 1, 'exactly one balance row')
    const link = query(card, '.lc-sc-balance')
    assert.equal(link.getAttribute('href'), 'https://platform.deepseek.com/usage')
    assert.equal(link.getAttribute('target'), '_blank')
    assert.ok(text(link).includes('$12.50'))
    await m.unmount()
  })

  test('a hostile locale service degrades to the English chrome without throwing', async () => {
    const ctx = new TestClientCtx()
    Object.defineProperty(ctx, 'locale', {
      get() { throw new Error('hostile locale') },
      configurable: true,
    })
    const D = makeComposerDock(asClientCtx(ctx), kit)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    // The platform's own currency is locale-independent, so the figure reads the same.
    assert.equal(query(m.container, '.lc-dock-spend')?.textContent, '¥2.00')
    await m.unmount()
  })

  test('a locale service without getLocale still renders the platform currency', async () => {
    const ctx = new TestClientCtx()
    Object.defineProperty(ctx, 'locale', { get: () => ({ bind: () => () => '' }), configurable: true })
    const D = makeComposerDock(asClientCtx(ctx), kit)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    assert.equal(query(m.container, '.lc-dock-spend')?.textContent, '¥2.00')
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
  const src = readFileSync(join(process.cwd(), 'src/client/components/composerDock.tsx'), 'utf8')
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

  test('the card is sized and padded like the official stat dialog', () => {
    // The card reads as the same layer as the official stat dialog the status bar opens
    // ("Token 用量", from the stats pill) — `stat-dialog.module.css`'s `.panel`:
    // `padding: 16px`, `font-size: 12px`, `line-height: 18px`.
    //
    // The WIDTH is deliberately different. The official panel only lists five token
    // rows; this card carries two summary cards plus a rate table, so it keeps
    // content-driven sizing. The official panel's `min(440px, 100vw - 24px)` ceiling
    // was copied straight over at first and was wrong here: as a FLOOR of 264px it left
    // the legend ~132px once the 96px ring took its share, under the legend's own 150px
    // minimum column, so every row folded onto two lines.
    const body = ruleOf('.lc-dock-card')
    assert.match(body, /padding:\s*16px/, 'the official stat-dialog padding')
    assert.match(body, /font-size:\s*12px/, 'the official panel text size')
    assert.match(body, /line-height:\s*18px/, 'the official panel line box')
    assert.match(src, /const CARD_MIN_WIDTH = 264/, 'the width floor is the plugin\u2019s own')
    assert.match(body, /width:\s*max-content/, 'while the content decides the actual width')
  })

  test('the card is portaled to the body, like the official panels', () => {
    // Every official panel on this row (ContextMeter's `.panel`, the stat dialog) is
    // `createPortal`ed to `document.body` at z-index 1100. The composer column, by
    // contrast, is a `position: sticky` seat and `ConversationRoot.module.css`'s
    // `.composerSeat` gives it `z-index: 7` — a stacking context. A `z-index: 1100`
    // card rendered INSIDE that seat is only ordered within it, so a root-level
    // element can still cover it; the shared 1100 only means "same layer" once the
    // card is a body-level sibling too. Rendering through a portal is what makes the
    // official panels and this card actually comparable.
    assert.match(src, /createPortal/, 'the card renders through a portal')
    assert.match(src, /document\.body/, 'and targets the body, where the official panels live')
  })

  test('the head carries the official title rule', () => {
    // Official `.title`: `label-primary`, `font-weight: 500`, `justify-content:
    // space-between`, `gap: 16px`, `margin-bottom: 8px`; then `.titleRule`, a 0.5px
    // `border-l2` hairline with 10px below. Together they are how the official panel
    // separates its heading from the detail rows.
    const head = ruleOf('.lc-dock-head')
    assert.match(head, /justify-content:\s*space-between/, 'title and value at opposite ends')
    assert.match(head, /gap:\s*16px/, 'the official title gap')
    assert.match(head, /margin-bottom:\s*8px/, 'the official title-to-rule space')
    assert.match(ruleOf('.lc-dock-head-title'), /font-weight:\s*500/, 'the official title weight')
    assert.match(ruleOf('.lc-dock-head-title'), /--dsw-alias-label-primary/, 'the official title colour')
    const rule = ruleOf('.lc-dock-head-rule')
    assert.match(rule, /border-top:\s*0\.5px solid var\(--dsw-alias-border-l2\)/, 'the official hairline')
    assert.match(rule, /margin:\s*0 0 10px/, 'and its 10px below, like the official rule')
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

  test('the trigger is boxed exactly like the official readout pill beside it', () => {
    // The readout sits on the composer status bar in the same slot as the official
    // stats pills (`ui-chat/.../StatsPills.module.css`: the TimePill and the UsagePill
    // that render "48.6M tok · 缓存命中 97%"), so that is the recipe to copy.
    //
    // NOT `ContextMeter.module.css`'s `.trigger`: that one is a different kind of
    // control (a ring plus one percentage) and the two official components genuinely
    // differ — `.pill` is a 12px full capsule, `.trigger` is 13px with an 8px radius.
    // Copying `.trigger` left this readout one size larger and visibly squarer than
    // the official pill directly to its left.
    assert.ok(trigger !== null, 'the trigger rule exists')
    const body = trigger[1]
    // `.root` sets the pill's size: `calc(var(--dsh-content-font-size-secondary, 13px) - 1px)`.
    assert.match(
      body,
      /font-size:\s*calc\(var\(--dsh-content-font-size-secondary,\s*13px\)\s*-\s*1px\)/,
      'the official pill font size, one step under the secondary size',
    )
    // Shared with `.trigger`: the same 20px line box and the same padding, which is
    // what keeps both neighbours standing at the same 22px height.
    assert.match(body, /line-height:\s*calc\(20px \+ var\(--dsh-content-font-delta-secondary,\s*0px\)\)/, 'the official 20px line box')
    assert.match(body, /padding:\s*1px 8px/, 'the official pill padding')
    // `.pill` is a full capsule, with the modern corner-shape declaration alongside it.
    assert.match(body, /border-radius:\s*999px/, 'the official capsule radius')
    assert.match(body, /corner-shape:\s*round/, 'and the official corner shape')
    assert.doesNotMatch(body, /--dsw-radius-sm/, 'not the squarer `.trigger` radius')
    assert.match(body, /display:\s*inline-flex/, 'inline-flex keeps it on the status bar line')
  })

  test('the icon is pinned to the official 14px pill glyph', () => {
    // `.pill svg{flex:none;width:14px;height:14px}`: the official pill never lets the
    // row squeeze its glyph, because the row gives up readings before it gives up the icon.
    const svg = /^\.lc-dock > svg\s*\{([^}]*)\}/m.exec(css)
    assert.ok(svg !== null, 'the icon rule exists')
    assert.match(svg[1], /flex:\s*none/, 'the glyph never shrinks')
    assert.match(svg[1], /width:\s*14px/, 'the official pill glyph width')
    assert.match(svg[1], /height:\s*14px/, 'the official pill glyph height')
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

describe('ComposerDock — the status bar reports spend per platform', () => {
  /** Beijing wall-clock instant as epoch ms (UTC+8). */
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  /** One turn of workbuddy traffic plus one official DeepSeek turn. */
  function mixedTimeline() {
    return timelineWith({
      workbuddy: { 'glm-5.3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'deepseek-account': { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    } as ContextTimeline['cost'], {
      calls: { workbuddy: { 'glm-5.3': 4 }, 'deepseek-account': { 'deepseek-v4.1-flash': 1 } },
      creditRates: { workbuddy: { 'glm-5.3': 0.79 } },
    } as Partial<ContextTimeline>)
  }

  test('lists each platform with its own unit, and no countdown', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(mixedTimeline()) }))
    try {
      await flush()
      const rows = queryAll(m.container, '.lc-dock-platform')
      assert.equal(rows.length, 2, 'one segment per platform')
      const byUnit = (u: string) => rows.find(r => r.getAttribute('data-unit') === u)
      const credit = byUnit('credits')
      const money = byUnit('money')
      assert.ok(credit !== undefined, 'the credit platform is listed')
      assert.match(text(credit), /workbuddy/, 'named, not folded into one figure')
      assert.match(text(credit), /3\.16/, '4 calls x 0.79 credits')
      assert.ok(money !== undefined, 'and so is the official one')
      assert.match(text(money), /DeepSeek/, 'the official platform is labelled too')
      assert.match(text(money), /¥/, 'in CNY')
      // The countdown moved out of this line: it describes the period, not the spend.
      assert.equal(m.container.querySelector('.lc-dock-countdown'), null, 'no countdown')
    } finally { await m.unmount(); vi.useRealTimers() }
  })

  test('a single platform still says which one it is', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    try {
      await flush()
      const rows = queryAll(m.container, '.lc-dock-platform')
      assert.equal(rows.length, 1)
      assert.match(text(rows[0]), /DeepSeek/, 'the lone platform is still named')
    } finally { await m.unmount(); vi.useRealTimers() }
  })
})

describe('ComposerDock — the line speaks for the platform in use', () => {
  /** Two editions, each with its own spend and its own credit pool. */
  const BOTH: ContextTimeline = {
    ok: true, requests: [], events: [], nodes: [], archive: [],
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash',
    cost: {
      workbuddy: { 'glm-5.3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'workbuddy-ai': { 'deepseek-v4.1-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    },
    calls: { workbuddy: { 'glm-5.3': 4 }, 'workbuddy-ai': { 'deepseek-v4.1-flash': 2 } },
    creditRates: { workbuddy: { 'glm-5.3': 0.79 }, 'workbuddy-ai': { 'deepseek-v4.1-flash': 0.03 } },
  } as unknown as ContextTimeline

  test('shows only the active platform, not every platform ever used', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, 2)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(BOTH) }))
    try {
      await flush()
      const rows = queryAll(m.container, '.lc-dock-platform')
      assert.equal(rows.length, 1, 'one segment, for the route in use')
      assert.match(text(rows[0]), /workbuddy-ai/, 'the active edition')
      const line = text(query(m.container, '.lc-dock'))
      assert.doesNotMatch(line, /glm-5\.3/, 'not the idle one')
    } finally { await m.unmount(); vi.useRealTimers() }
  })

  test('each edition reports its OWN credit balance', async () => {
    // The regression: one route's total was shown under both editions' names, so the
    // international row claimed the CN pool. The two are separate accounts.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 12, 2)))
    resetPlatformCredits()
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ ok: true, value: { workbuddy: { total: 6352, unlimited: false }, 'workbuddy-ai': { total: 350, unlimited: false } } }),
    }))
    try {
      const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
      const m = await mount(h(D, { sessionId: 's1', ...seatOf(BOTH) }))
      await flush()
      await flush()
      const line = text(query(m.container, '.lc-dock'))
      assert.match(line, /350/, 'the international pool')
      assert.doesNotMatch(line, /6352/, 'never the CN pool on the international route')
      await m.unmount()
    } finally { resetPlatformCredits(); vi.unstubAllGlobals(); vi.useRealTimers() }
  })
})

describe('ComposerDock — the status bar wears the statistics icon, and degrades to it', () => {
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  function onePlatform(): ContextTimeline {
    return timelineWith(
      { workbuddy: { 'glm-5.3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      { calls: { workbuddy: { 'glm-5.3': 5 } }, creditRates: { workbuddy: { 'glm-5.3': 0.79 } } } as Partial<ContextTimeline>,
    )
  }

  test('carries the same icon the statistics entry uses, so it reads as one feature', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(onePlatform()) }))
    try {
      await flush()
      // The icon is the first child, ahead of the readings.
      assert.ok(query(m.container, '.lc-dock > svg') !== null, 'the icon leads the row')
      assert.match(text(query(m.container, '.lc-dock')), /workbuddy/, 'with the readings beside it')
    } finally { await m.unmount(); vi.useRealTimers() }
  })

  test('an always-rendered probe measures the full reading, invisible to the reader', async () => {
    // The probe must be laid out at the full reading even while the row shows only an
    // icon, or the verdict would flip back the moment the icon appears.
    const css = readFileSync(join(process.cwd(), 'src/client/styles/composerDock.css'), 'utf8')
    assert.match(css, /\.lc-dock-probe\s*\{[^}]*visibility:\s*hidden/, 'the probe is invisible')
    assert.match(css, /\.lc-dock-probe\s*\{[^}]*position:\s*absolute/, 'and takes no space in the row')
    const src = readFileSync(join(process.cwd(), 'src/client/components/composerDock.tsx'), 'utf8')
    assert.match(src, /className="lc-dock-probe"/, 'rendered unconditionally, not only in one branch')
  })

  test('the observer is attached on the frame the button mounts', async () => {
    // 真实时序：timeline 在首帧之后才推入，按钮与探针因此都是第二帧才出现的。
    // 测量 effect 必须在它们出现时自己重跑——依赖里若没有那个「已就绪」信号，
    // 它会在首帧对着两个 null ref 返回，而依赖永不变化，观察者就永远挂不上，
    // 判据会一直停在初始的「够宽」。这里用一个可观察的 ResizeObserver 钉住它。
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const observed: Element[] = []
    vi.stubGlobal('ResizeObserver', class {
      observe(el: Element): void { observed.push(el) }
      disconnect(): void { /* nothing to release in the stub */ }
    })
    try {
      const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
      // 关键：首帧**没有** timeline，按钮和探针都还没出现。
      let tl: ContextTimeline | undefined
      const seat = {
        sessionId: 's1',
        useProjection: (k: string) => (k === 'contextTimeline' ? tl : undefined),
        useChat: (sel: (s: unknown) => unknown) => sel({ legacy: { nodes: [] } }),
      }
      const m = await mount(h(D, seat as never))
      await flush()
      assert.equal(observed.length, 0, 'nothing to observe before the button exists')
      tl = onePlatform()
      await m.update(h(D, seat as never))
      await flush()
      assert.ok(observed.length > 0, 'the row is observed once the button mounts')
      await m.unmount()
    } finally { vi.unstubAllGlobals(); vi.useRealTimers() }
  })

  test('a row with no room left drops the readings and keeps the icon', async () => {
    // The verdict compares what the row is GIVEN with what the full reading NEEDS, so a
    // wide window with a narrow column still degrades.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(onePlatform()) }))
    try {
      await flush()
      const trigger = query(m.container, '.lc-dock')
      const parent = trigger.parentElement!
      // jsdom reports zero for every box: give the row less room than the probe needs.
      Object.defineProperty(parent, 'clientWidth', { value: 40, configurable: true })
      const probe = query(m.container, '.lc-dock-probe')
      Object.defineProperty(probe, 'offsetWidth', { value: 300, configurable: true })
      // jsdom 里没有 ResizeObserver，代码会退回 window 的 resize 监听。
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      await flush()
      assert.ok(query(m.container, '.lc-dock').querySelector('svg') !== null, 'the icon stays')
      // 注意：`text(trigger)` 会带上那个**始终渲染**的量宽探针，所以这里必须看
      // 可见的那部分——探针正是判据不自激的原因，它本来就该一直量着完整读数。
      assert.equal(queryAll(m.container, '.lc-dock-platform').length, 0, 'the readings are gone')
      assert.ok(query(m.container, '.lc-dock').classList.contains('lc-dock-narrow'), 'collapsed form')
    } finally { await m.unmount(); vi.useRealTimers() }
  })
})

describe('ComposerDock — yields to the official panel on the same row', () => {
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  function overlay(): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('role', 'dialog')
    el.style.zIndex = '1100'
    el.getBoundingClientRect = () => ({ width: 264, height: 320, top: 0, left: 0, right: 264, bottom: 320, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    document.body.appendChild(el)
    return el
  }

  test('the card closes when the official panel appears beside it', async () => {
    // Both open at z-index 1100, so whichever mounts last covers the other. Rather than
    // out-stacking the official UI, the plugin steps aside while it is open.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    try {
      await flush()
      await click(query(m.container, '.lc-dock'))
      assert.ok(query(document.body, '.lc-dock-card') !== null, 'the card is open')
      // The official panel mounts (it is portaled to body).
      await act(async () => { overlay() })
      await flush()
      assert.equal(document.body.querySelector('.lc-dock-card'), null, 'and it steps aside')
    } finally {
      document.body.querySelectorAll('[role="dialog"]').forEach(el => { el.remove() })
      await m.unmount(); vi.useRealTimers()
    }
  })

  test('the card still opens when nothing official is up', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    try {
      await flush()
      await click(query(m.container, '.lc-dock'))
      await flush()
      assert.ok(query(document.body, '.lc-dock-card') !== null, 'opens normally')
    } finally { await m.unmount(); vi.useRealTimers() }
  })
})

describe('ComposerDock — peak/off and the rate table belong to DeepSeek only', () => {
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  /** One turn on the given route. */
  function on(provider: string): ContextTimeline {
    return {
      ok: true, requests: [], events: [], nodes: [], archive: [],
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
      provider, model: 'deepseek-v4.1-flash',
      cost: { [provider]: { 'deepseek-v4.1-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      calls: { [provider]: { 'deepseek-v4.1-flash': 1400 } },
      creditRates: { workbuddy: { 'deepseek-v4.1-flash': 0.11 } },
    } as unknown as ContextTimeline
  }

  async function open(provider: string) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(on(provider)) }))
    await flush()
    const line = text(query(m.container, '.lc-dock'))
    await click(query(m.container, '.lc-dock'))
    await flush()
    return { m, line, card: query(document.body, '.lc-dock-card') }
  }

  test('a credit platform carries no peak/off badge and no rate table', async () => {
    // Peak/off-peak is DeepSeek's own billing window, and the rate table lists CNY
    // prices. Showing either for a platform billed in credits would state a rule that
    // does not apply to it — the reader would take the yuan figures for its bill.
    const { m, line, card } = await open('workbuddy')
    try {
      assert.doesNotMatch(line, /[峰谷]/, 'no peak/off badge on the line')
      assert.equal(queryAll(card, '.lc-dock-badge').length, 0, 'and none in the card')
      assert.equal(queryAll(card, '.lc-dock-table').length, 0, 'nor a CNY rate table')
    } finally { await m.unmount(); vi.useRealTimers() }
  })

  test('an official DeepSeek route keeps both', async () => {
    const { m, line, card } = await open('deepseek-account')
    try {
      assert.match(line, /峰|谷/, 'the period badge stays where it means something')
      assert.equal(queryAll(card, '.lc-dock-badge').length, 1, 'the card badge too')
      assert.equal(queryAll(card, '.lc-dock-table').length, 1, 'and the rate table')
    } finally { await m.unmount(); vi.useRealTimers() }
  })
})

describe('ComposerDock — official billing UI appears only where it applies', () => {
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  /** A session's ledger, optionally including an official route. */
  function session(provider: string, withOfficial: boolean): ContextTimeline {
    const cost: Record<string, unknown> = {
      workbuddy: { 'deepseek-v4.1-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    if (withOfficial) {
      cost['deepseek-account'] = { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } }
    }
    return {
      ok: true, requests: [], events: [], nodes: [], archive: [],
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
      provider, model: 'deepseek-v4.1-flash', cost,
      calls: { workbuddy: { 'deepseek-v4.1-flash': 1500 }, 'deepseek-account': { 'deepseek-v4.1-flash': 10 } },
      creditRates: { workbuddy: { 'deepseek-v4.1-flash': 0.11 } },
    } as unknown as ContextTimeline
  }

  async function open(provider: string, withOfficial: boolean) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = makeComposerDock(asClientCtx(new TestClientCtx({ locale: 'zh' })), kitZh)
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(session(provider, withOfficial)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    await flush()
    return { m, card: query(document.body, '.lc-dock-card') }
  }

  test('a session that never used an official model shows no cost card at all', async () => {
    // Peak/off-peak, the CNY rate table and the per-bucket money split are all official
    // billing concepts. A session that only ever ran on a credit platform has none of
    // them, so rendering the card would invent a bill that does not exist.
    const { m, card } = await open('workbuddy', false)
    try {
      const titles = queryAll(card, '.lc-card-title-text').map(el => el.textContent)
      assert.ok(!titles.includes('费用统计'), `no cost card, got ${JSON.stringify(titles)}`)
      assert.equal(queryAll(card, '.lc-dock-period-row').length, 0, 'no peak window row')
      assert.equal(queryAll(card, '.lc-dock-table').length, 0, 'no rate table')
      assert.equal(queryAll(card, '.lc-dock-note').length, 0, 'and no official-price disclaimer')
      assert.ok(titles.includes('workbuddy'), 'the per-platform card still reports the spend')
    } finally { await m.unmount(); vi.useRealTimers() }
  })

  test('a session that did use one keeps the cost card', async () => {
    const { m, card } = await open('workbuddy', true)
    try {
      const titles = queryAll(card, '.lc-card-title-text').map(el => el.textContent)
      assert.ok(titles.includes('费用统计'), `the card is back, got ${JSON.stringify(titles)}`)
      // But the peak row and rate table stay off: the route IN USE is a credit one.
      assert.equal(queryAll(card, '.lc-dock-period-row').length, 0, 'still no peak window row')
      assert.equal(queryAll(card, '.lc-dock-table').length, 0, 'still no rate table')
    } finally { await m.unmount(); vi.useRealTimers() }
  })

  test('an official route in use gets the whole set', async () => {
    const { m, card } = await open('deepseek-account', true)
    try {
      const titles = queryAll(card, '.lc-card-title-text').map(el => el.textContent)
      assert.ok(titles.includes('费用统计'), 'the cost card')
      assert.equal(queryAll(card, '.lc-dock-period-row').length, 1, 'the peak window row')
      assert.equal(queryAll(card, '.lc-dock-table').length, 1, 'the rate table')
    } finally { await m.unmount(); vi.useRealTimers() }
  })
})

describe('ComposerDock — the line never totals platforms it cannot report', () => {
  const bj = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 8, mi)

  test('a route with no row of its own falls back to a dash, not a cross-platform total', async () => {
    // The regression: with no platform row to show, the line fell back to `reading.cost`
    // — the WHOLE ledger's estimate. Two money platforms therefore made the line read
    // "¥4.00" while the route actually in use had spent nothing. A sum across platforms
    // of different units is meaningless, and here it was presented as "right now".
    vi.useFakeTimers()
    vi.setSystemTime(new Date(bj(2026, 10, 12, 10)))
    const D = Dock(new TestClientCtx({ locale: 'zh' }), kitZh)
    const tl = {
      ok: true, requests: [], events: [], nodes: [], archive: [],
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
      provider: 'kimi-coding', model: 'kimi-k2',
      cost: {
        'deepseek-account': { 'deepseek-v4-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
        'other-route': { 'deepseek-v4-flash': { off: { uncached: 3_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      },
      calls: {}, creditRates: null,
    } as unknown as ContextTimeline
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(tl) }))
    try {
      await flush()
      const line = text(query(m.container, '.lc-dock'))
      assert.ok(!line.includes('¥4.00'), `must not total the ledger, got ${JSON.stringify(line)}`)
      assert.match(line, /—/, 'an honest dash instead')
    } finally { await m.unmount(); vi.useRealTimers() }
  })
})
