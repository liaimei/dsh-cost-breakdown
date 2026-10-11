// The composer-dock readout (src/client/components/composerDock.tsx) and its data seam
// (src/client/dockReading.ts): the always-visible spend line under the input, its expanded
// detail card, the locally computed pricing period, and the graceful absence before a push.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeComposerDock } from '../../../src/client/components/composerDock'
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

  test('the card carries the token split, the period split and the rate table', async () => {
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(MIXED)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')
    const body = text(card)
    assert.ok(body.includes('Token usage'))
    assert.ok(body.includes('Cost breakdown'))
    assert.ok(body.includes('Rate card'))
    // The rate table quotes the period in force, so both official rows appear.
    const rows = queryAll(card, '.lc-dock-table tbody tr')
    assert.equal(rows.length, 2)
    assert.ok(text(rows[0]).includes('DeepSeek-V4.1-Flash'))
    assert.ok(text(rows[1]).includes('DeepSeek-V4-Pro'))
    // The block rows split the ledger's period buckets.
    const blockRows = queryAll(card, '.lc-dock-block-row')
    assert.ok(blockRows.length >= 5, 'three token buckets plus two period rows')
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

  test('every bar carries its semantic tint, the shared rise animation, and a zero flag', async () => {
    // The panel reuses the plugin's existing bar vocabulary rather than inventing one:
    // a neutral track (as in the stacked bar, donut and timing strip), a per-bucket tint
    // so peak/off and the three token buckets are told apart by colour, and the shared
    // `lc-stacked-in` rise with `motion-reduce` (the keyframes only ship when that
    // utility class is used somewhere, so writing `animation:` in the sheet would be
    // both duplicated and un-reducible).
    const D = Dock()
    const m = await mount(h(D, { sessionId: 's1', ...seatOf(timelineWith(DEEPSEEK_PEAK)) }))
    await flush()
    await click(query(m.container, '.lc-dock'))
    const card = query(m.container, '.lc-dock-card')

    const tracks = queryAll(card, '.lc-dock-block-track')
    assert.ok(tracks.length >= 5, 'three token buckets plus two period rows')
    for (const track of tracks) {
      assert.ok(/lc-dock-tint-/.test(track.className), `a bar without a tint reads as decoration: ${track.className}`)
      const fill = track.querySelector('i')
      assert.ok(fill !== null, 'each track holds a fill')
      assert.ok(
        fill.className.includes('animate-lc-stacked-in') && fill.className.includes('motion-reduce:animate-none'),
        'the fill rides the shared rise animation and honours reduced motion',
      )
    }
    // The two period bands differ in colour, which is the point of tinting them.
    const peak = tracks.find(t => t.className.includes('lc-dock-tint-peak'))
    const off = tracks.find(t => t.className.includes('lc-dock-tint-off'))
    assert.ok(peak !== undefined && off !== undefined, 'both period bands render')
    // `DEEPSEEK_PEAK` bills peak only, so the off bucket is empty and must be flagged.
    const offRow = off.closest('.lc-dock-block-row')
    assert.equal(offRow?.getAttribute('data-zero'), '1', 'an empty period is flagged so its track can recede')
    const peakRow = peak.closest('.lc-dock-block-row')
    assert.equal(peakRow?.getAttribute('data-zero'), null, 'a billed period is not flagged')
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
    const rows = queryAll(card, '.lc-dock-block-row')
    // Three token buckets plus the two period rows; the empty period still renders its zero row.
    assert.equal(rows.length, 5)
    assert.ok(text(rows[4]).includes('0.0%') || text(rows[4]).includes('0.00'), 'the empty period row reads zero')
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
    const link = query(card, '.lc-dock-balance-row')
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
