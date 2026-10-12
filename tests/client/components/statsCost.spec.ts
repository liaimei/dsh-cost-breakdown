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
    const m = await mount(h(Cost, { usage: OFFPEAK, currency: 'usd', provider: 'deepseek-official' }))
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
    const m = await mount(h(Cost, { usage: BOTH, currency: 'usd', provider: 'deepseek-official' }))
    // Peak doubles the official off-peak rate: $0.30 peak vs $0.15 off.
    assert.deepEqual(periodOf(m.container, 0), { label: 'Peak', cost: '$0.30', pct: '66.7%' })
    assert.deepEqual(periodOf(m.container, 1), { label: 'Off-peak', cost: '$0.15', pct: '33.3%' })
    await m.unmount()
  })

  test('the zh locale prices in CNY with localized labels', async () => {
    const m = await mount(h(CostZh, { usage: OFFPEAK, currency: 'cny', provider: 'deepseek-official' }))
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
      const m = await mount(h(Cost, { usage, currency: 'usd', provider: 'deepseek-official' }))
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
      provider: 'unknown-route',
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
    const m = await mount(h(Cost, { usage: OFFPEAK, currency: 'usd', provider: 'deepseek-official' }))
    const link = query(m.container, '.lc-sc-balance')
    assert.equal(query(link, '.lc-sc-balance-label').textContent, 'DeepSeek balance')
    assert.equal(query(link, 'b').textContent, '¥38.12', 'the entry keeps its own currency')
    assert.equal(link.getAttribute('href'), 'https://platform.deepseek.com/usage')
    await m.unmount()
  })

  test('no balance remembered leaves the row out entirely', async () => {
    const m = await mount(h(Cost, { usage: OFFPEAK, currency: 'usd', provider: 'deepseek-official' }))
    assert.equal(queryAll(m.container, '.lc-sc-balance').length, 0, 'never a zero standing in for "unknown"')
    await m.unmount()
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(Cost, { usage: OFFPEAK, currency: 'usd', provider: 'deepseek-official' }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[0])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(rows[0].className.includes('lc-sl-row-on'))
    await unhover(rows[0])
    assert.ok(!rows[0].className.includes('lc-sl-row-on'))
    await m.unmount()
  })
})

describe('StatsCost — the platform breakdown lives in its own cards now', () => {
  test('the cost card carries no platform rows of its own', async () => {
    // Per-platform spend moved to one card per platform (statsPlatforms.tsx), because a
    // single card would have to state one total across two different units. This card
    // keeps to money only, so it must not render platform rows.
    setModelPricesLoader(null)
    resetModelPrices()
    const kit = makeKit('zh')
    const Card = makeStatsCost(kit, (() => h('div')) as never)
    const usage = {
      workbuddy: { 'glm-5.3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'deepseek-account': { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(Card as never, {
      usage, currency: 'cny',
      calls: { workbuddy: { 'glm-5.3': 4 }, 'deepseek-account': { 'deepseek-v4.1-flash': 1 } },
      creditRates: { workbuddy: { 'glm-5.3': 0.79 } },
    } as never))
    try {
      await flush()
      assert.equal(m.container.querySelector('.lc-sc-platforms'), null, 'no platform rows here')
      assert.equal(m.container.querySelector('.lc-pf-card'), null, 'and no platform cards')
    } finally { await m.unmount() }
  })
})

describe('StatsCost — it speaks for the platform currently in use', () => {
  const BOTH = {
    workbuddy: { 'deepseek-v4.1-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    'deepseek-account': { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
  }
  const CALLS = { workbuddy: { 'deepseek-v4.1-flash': 1400 }, 'deepseek-account': { 'deepseek-v4.1-flash': 612 } }

  test('a credit platform is never priced as currency', async () => {
    // The regression this guards: `deepseek-v4.1-flash` happens to be listed in the
    // official CNY table, so a workbuddy turn was being priced as money — a plausible
    // but meaningless figure, since that platform bills in credits.
    setModelPricesLoader(null)
    resetModelPrices()
    const Card = makeStatsCost(makeKit('zh'), Donut)
    const m = await mount(h(Card as never, {
      usage: BOTH, calls: CALLS, provider: 'workbuddy', unit: 'credits', creditsValue: 155.65, currency: 'cny',
    } as never))
    try {
      await flush()
      const body = text(query(m.container, '.lc-card'))
      assert.match(body, /155\.65/, 'the credit figure')
      assert.match(body, /积分/, 'labelled in credits')
      assert.doesNotMatch(body, /¥/, 'and NOT converted to currency')
      assert.match(body, /1\.4k/, 'with the call count')
    } finally { await m.unmount() }
  })

  test('a currency platform shows only that platform\u2019s cost', async () => {
    // Two platforms that BOTH price in money, so the scoping is observable: the card
    // must report the selected platform's own figure, not the sum. (Using a credit
    // platform here would not discriminate — that one is unpriced either way.)
    setModelPricesLoader(null)
    resetModelPrices()
    const Card = makeStatsCost(makeKit('zh'), Donut)
    const twoMoney = {
      'deepseek-account': { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'other-route': { 'deepseek-v4.1-flash': { off: { uncached: 3_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h(Card as never, {
      usage: twoMoney, calls: CALLS, provider: 'deepseek-account', unit: 'money', currency: 'cny',
    } as never))
    try {
      await flush()
      const body = text(query(m.container, '.lc-card'))
      // 1M at the official off-peak ¥1/M. The other route's 3M would make it ¥4.00 if
      // the card priced the whole ledger instead of just the selected platform.
      assert.match(body, /¥1\.00/, 'only the selected platform')
      assert.doesNotMatch(body, /¥4\.00/, 'never the whole ledger')
    } finally { await m.unmount() }
  })
})

describe('StatsCost — an unknown route reports nothing, it does not total the ledger', () => {
  const TWO_MONEY = {
    a: { 'deepseek-v4-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    b: { 'deepseek-v4-flash': { off: { uncached: 3_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
  }

  test('a null provider does not fall back to pricing every platform together', async () => {
    // The regression: `provider: null` (the route is not in the ledger yet, or has no
    // resolvable rate) used to fall back to `props.usage`, i.e. the whole ledger. With
    // two money platforms that is a silent cross-platform sum — exactly the error the
    // per-platform scoping exists to prevent, reached by a different branch.
    const m = await mount(h(Cost, { usage: TWO_MONEY, provider: null, currency: 'cny' }))
    try {
      await flush()
      const body = text(m.container)
      assert.ok(!body.includes('¥4.00'), `must not sum the ledger, got ${JSON.stringify(body)}`)
      assert.match(body, /¥1\.00|No billing data|暂无/, 'it reports the single platform or nothing')
    } finally { await m.unmount() }
  })

  test('naming one platform reports that platform alone', async () => {
    const m = await mount(h(Cost, { usage: TWO_MONEY, provider: 'a', currency: 'cny' }))
    try {
      await flush()
      const body = text(m.container)
      assert.match(body, /¥1\.00/, 'the named platform')
      assert.doesNotMatch(body, /¥4\.00/, 'never both')
    } finally { await m.unmount() }
  })
})
