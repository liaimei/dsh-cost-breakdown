// The cost card on the session view (src/client/components/statsCost.tsx) rendered with real React:
// the donut splits the session's spend by the four billed buckets, the peak/off-peak split sits
// underneath, and the account balance rides the same two sources as the Insights capsule.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { Donut } from '../../../src/client/components/donut'
import { makeStatsCost } from '../../../src/client/components/statsCost'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { PLATFORM_BALANCE_STORAGE_KEY, resetPlatformBalance } from '../../../src/client/balance'
import { flush, makeKit, hover, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const Cost = makeStatsCost(kit, Donut)
const CostZh = makeStatsCost(kitZh, Donut)

/** A minimal real-shaped models.dev slice: only the non-official rows need it. */
const PROVIDERS = {
  zhipuai: { models: { 'glm-5.3-flash': { cost: { input: 0.075, output: 0.25, cache_read: 0.015, cache_write: 0 } } } },
}

/** 1M cache-read + 1M uncached + 1M output, all in the off-peak window. */
const OFFPEAK = {
  'deepseek-official': {
    'deepseek-v4-flash': { off: { uncached: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 } },
  },
}

/** The same ledger split across both windows, so the period rows are unambiguous. */
const BOTH = {
  'deepseek-official': {
    'deepseek-v4-flash': {
      peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
      off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
  },
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

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
  }
}

function periodOf(container: HTMLElement, i: number): { label: string; cost: string; pct: string } {
  const el = queryAll(container, '.lc-sc-period')[i]
  return {
    label: el.querySelector('.lc-sc-period-label')?.textContent ?? '',
    cost: el.querySelector('b')?.textContent ?? '',
    pct: el.querySelector('em')?.textContent ?? '',
  }
}

describe('StatsCost', () => {
  test('the ring splits the spend by billed bucket, with each bucket’s money in the sub-row', async () => {
    const m = await mount(h(Cost, { usage: OFFPEAK, currency: 'usd' }))
    // Off-peak flash: hit 0.003, miss 0.15, out 0.6 per 1M → $0.753 total, shown to the cent.
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '$0.75')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total Cost')
    // Zero buckets (cache write) drop out of the ring.
    assert.deepEqual(queryAll(m.container, '.lc-sl-label').map(el => el.textContent), [
      'Cache input', 'Uncached input', 'Output',
    ])
    assert.deepEqual(rowOf(m.container, 0), { pct: '0.4%', label: 'Cache input', count: '$0.0030' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '19.9%', label: 'Uncached input', count: '$0.15' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '79.7%', label: 'Output', count: '$0.60' })
    await m.unmount()
  })

  test('the peak/off-peak split sits under the ring and adds up to the ring total', async () => {
    const m = await mount(h(Cost, { usage: BOTH, currency: 'usd' }))
    // Peak doubles the official off-peak rate: $0.30 peak vs $0.15 off.
    assert.deepEqual(periodOf(m.container, 0), { label: 'Peak', cost: '$0.30', pct: '66.7%' })
    assert.deepEqual(periodOf(m.container, 1), { label: 'Off-peak', cost: '$0.15', pct: '33.3%' })
    await m.unmount()
  })

  test('the zh locale prices in CNY with localized labels', async () => {
    const m = await mount(h(CostZh, { usage: OFFPEAK, currency: 'cny' }))
    assert.ok(text(m.container).includes('费用统计'))
    // 0.753 USD / 0.15 = ¥5.02.
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '¥5.02')
    const periods = queryAll(m.container, '.lc-sc-period')
    assert.ok(text(periods[1]).startsWith('谷'))
    assert.equal(query(periods[1], 'b').textContent, '¥5.02')
    await m.unmount()
  })

  test('nothing billed renders the empty note, with no ring', async () => {
    for (const usage of [null, {} as never]) {
      const m = await mount(h(Cost, { usage, currency: 'usd' }))
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      assert.equal(queryAll(m.container, '.lc-sc-period').length, 0)
      assert.ok(text(m.container).includes('No billing data for this session yet'))
      await m.unmount()
    }
  })

  test('a metered ledger nothing could price says the rates are missing, not that nothing was spent', async () => {
    // A model outside both tables: the ledger is real, the price is not.
    const m = await mount(h(Cost, {
      usage: { 'unknown-route': { 'mystery-model': { off: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      currency: 'usd',
    }))
    assert.equal(queryAll(m.container, '.lc-donut').length, 0)
    assert.ok(text(m.container).includes('Model prices are unavailable'))
    assert.ok(!text(m.container).includes('No billing data'), 'the two empty states are different facts')
    await m.unmount()
  })

  test('a remembered balance renders and links to the platform console', async () => {
    globalThis.localStorage.setItem(PLATFORM_BALANCE_STORAGE_KEY, JSON.stringify({
      isAvailable: true,
      balances: [{ currency: 'CNY', total: 38.12, granted: 1.5, toppedUp: 36.62 }],
    }))
    const m = await mount(h(Cost, { usage: OFFPEAK, currency: 'usd' }))
    const link = query(m.container, '.lc-sc-balance')
    assert.equal(query(link, '.lc-sc-balance-label').textContent, 'DeepSeek balance')
    assert.equal(query(link, 'b').textContent, '¥38.12', 'the entry keeps its own currency')
    assert.equal(link.getAttribute('href'), 'https://platform.deepseek.com/usage')
    await m.unmount()
  })

  test('no balance remembered leaves the row out entirely', async () => {
    const m = await mount(h(Cost, { usage: OFFPEAK, currency: 'usd' }))
    assert.equal(queryAll(m.container, '.lc-sc-balance').length, 0, 'never a zero standing in for "unknown"')
    await m.unmount()
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(Cost, { usage: OFFPEAK, currency: 'usd' }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[0])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(rows[0].className.includes('lc-sl-row-on'))
    await unhover(rows[0])
    assert.ok(!rows[0].className.includes('lc-sl-row-on'))
    await m.unmount()
  })
})

describe('StatsCost — the per-platform breakdown', () => {
  async function render(extra: Record<string, unknown>) {
    const kit = makeKit('zh')
    const Card = makeStatsCost(kit, (() => h('div')) as never)
    const usage = {
      workbuddy: { 'glm-5.3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'deepseek-account': { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(Card as never, { usage, currency: 'cny', ...extra } as never))
    await flush()
    return m
  }

  test('lists each platform in its own unit instead of one combined figure', async () => {
    // Currency and credits cannot be added, so a platform that bills in credits gets
    // its own row rather than being folded into the money total.
    setModelPricesLoader(null)
    resetModelPrices()
    const m = await render({
      calls: { workbuddy: { 'glm-5.3': 4 }, 'deepseek-account': { 'deepseek-v4.1-flash': 1 } },
      creditRates: { workbuddy: { 'glm-5.3': 0.79 } },
    })
    try {
      const rows = queryAll(m.container, '.lc-sc-platform')
      assert.equal(rows.length, 2, 'one row per platform')
      const creditRow = rows.find(r => r.getAttribute('data-unit') === 'credits')
      const moneyRow = rows.find(r => r.getAttribute('data-unit') === 'money')
      assert.ok(creditRow !== undefined, 'the credit platform has its own row')
      assert.match(text(creditRow), /3\.16/, '4 calls x 0.79 credits')
      assert.match(text(creditRow), /4 次/, 'and its call count')
      assert.ok(moneyRow !== undefined, 'and so does the currency platform')
      assert.match(text(moneyRow), /¥/, 'priced in CNY')
    } finally { await m.unmount() }
  })

  test('a credit platform is billed by calls, never by its token volume', async () => {
    setModelPricesLoader(null)
    resetModelPrices()
    const kit = makeKit('zh')
    const Card = makeStatsCost(kit, (() => h('div')) as never)
    // Enormous token buckets: they must not leak into the credit figure.
    const usage = { workbuddy: { 'glm-5.3': { peak: { uncached: 999_999_999, cacheRead: 0, cacheWrite: 0, output: 999_999_999 } } } }
    const m = await mount(h(Card as never, {
      usage, currency: 'cny',
      calls: { workbuddy: { 'glm-5.3': 2 } },
      creditRates: { workbuddy: { 'glm-5.3': 0.5 } },
    } as never))
    try {
      await flush()
      assert.match(text(query(m.container, '.lc-sc-platform')), /1 积分/, '2 calls x 0.5')
    } finally { await m.unmount() }
  })

  test('an unpriced platform contributes no row at all', async () => {
    setModelPricesLoader(null)
    resetModelPrices()
    const kit = makeKit('zh')
    const Card = makeStatsCost(kit, (() => h('div')) as never)
    const usage = { mystery: { unknown: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const m = await mount(h(Card as never, { usage, currency: 'cny' } as never))
    try {
      await flush()
      assert.equal(m.container.querySelector('.lc-sc-platforms'), null, 'no rows, no section')
    } finally { await m.unmount() }
  })
})
