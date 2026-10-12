// 每轮消费解析：金额一路复用 estimateSessionCostByBucket（所以与汇总卡同源），
// 积分一路按「次」计费、完全不读 token。两条路径互斥。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { creditRateOf, creditRatesOf, turnSpendOf } from '../../src/client/turnSpend'
import { thirdPartyRatesOf } from '../../src/shared/thirdPartyRates'
import type { TurnCostEntry } from '../../src/shared/types'

function entryOf(o: {
  provider: string
  model: string
  requests?: number
  peak?: { uncached?: number; cacheRead?: number; cacheWrite?: number; output?: number }
  off?: { uncached?: number; cacheRead?: number; cacheWrite?: number; output?: number }
}): TurnCostEntry {
  const bucket = (b: NonNullable<typeof o.peak>) => ({
    uncached: b.uncached ?? 0, cacheRead: b.cacheRead ?? 0,
    cacheWrite: b.cacheWrite ?? 0, output: b.output ?? 0,
  })
  return {
    usage: {
      [o.provider]: {
        [o.model]: {
          ...(o.peak !== undefined ? { peak: bucket(o.peak) } : {}),
          ...(o.off !== undefined ? { off: bucket(o.off) } : {}),
        },
      },
    },
    requests: { [o.provider]: { [o.model]: o.requests ?? 0 } },
  }
}

describe('creditRatesOf — the credit table narrowing', () => {
  test('keeps numeric rates and drops everything else', () => {
    // A platform's display string ("x0.29 credits") is NOT a usable rate: there is no
    // base unit behind it, so it must never be parsed into a number.
    const rates = creditRatesOf({
      'WorkBuddy:GLM-5.3': 0.79,
      'workbuddy:deepseek-v4.1-flash': 0.11,
      'workbuddy:display-string': 'x0.29 credits',
      'workbuddy:negative': -1,
      'no-colon': 1,
      ':missing-provider': 1,
      'workbuddy:': 1,
    })
    assert.deepEqual(rates, {
      workbuddy: { 'glm-5.3': 0.79, 'deepseek-v4.1-flash': 0.11 },
    })
  })

  test('nothing usable yields null', () => {
    for (const bad of [undefined, null, 'x', 7, [], {}, [{ a: 1 }]]) {
      assert.equal(creditRatesOf(bad), null, JSON.stringify(bad))
    }
  })
})

describe('creditRateOf', () => {
  const rates = creditRatesOf({ 'workbuddy:glm-5.3': 0.79 })
  test('matches case-insensitively but never loosely', () => {
    assert.equal(creditRateOf(rates, 'WorkBuddy', 'GLM-5.3'), 0.79)
    assert.equal(creditRateOf(rates, 'other-platform', 'glm-5.3'), null)
    assert.equal(creditRateOf(rates, 'workbuddy', 'glm-5.3-flash'), null)
  })
})

describe('turnSpendOf — the platform decides the unit', () => {
  test('a credit platform bills per CALL, not per token', () => {
    // workbuddy charges "N credits per message". Five calls at 0.11 = 0.55 credits —
    // the token counts below must not influence that at all.
    const entry = entryOf({
      provider: 'workbuddy', model: 'deepseek-v4.1-flash', requests: 5,
      peak: { uncached: 9_999_999, output: 9_999_999 },
    })
    const spend = turnSpendOf(entry, null, null, creditRatesOf({ 'workbuddy:deepseek-v4.1-flash': 0.11 }))
    assert.deepEqual(spend, { value: 0.55, unit: 'credits' })
  })

  test('zero calls costs zero credits, not a missing reading', () => {
    const entry = entryOf({ provider: 'workbuddy', model: 'glm-5.3', requests: 0, peak: { uncached: 10 } })
    assert.deepEqual(turnSpendOf(entry, null, null, creditRatesOf({ 'workbuddy:glm-5.3': 0.79 })), { value: 0, unit: 'credits' })
  })

  test('a token-priced platform yields money, with the official table applied', () => {
    // deepseek-v4.1-flash is in the official CNY table: ¥1/M off-peak (displayed in USD
    // at the fixed rate), and doubled on peak. 1M uncached off-peak = 0.15 USD.
    const entry = entryOf({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash', off: { uncached: 1_000_000 } })
    const spend = turnSpendOf(entry, null, null, null)
    assert.equal(spend?.unit, 'money')
    assert.equal(Number(spend!.value.toFixed(4)), 0.15)
  })

  test('the peak bucket is doubled for official models', () => {
    const peak = turnSpendOf(entryOf({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash', peak: { uncached: 1_000_000 } }), null, null, null)
    const off = turnSpendOf(entryOf({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash', off: { uncached: 1_000_000 } }), null, null, null)
    assert.equal(Number(peak!.value.toFixed(4)), Number((off!.value * 2).toFixed(4)), 'peak is exactly twice off')
  })

  test('a user-declared token rate prices a third-party model', () => {
    const entry = entryOf({ provider: 'some-platform', model: 'glm-5.3', peak: { uncached: 1_000_000, output: 500_000 } })
    const rates = thirdPartyRatesOf({ 'some-platform:glm-5.3': { input: 1.4, output: 4.4 } })
    // 1M x 1.4 + 0.5M x 4.4 = 1.4 + 2.2 = 3.6
    assert.equal(Number(turnSpendOf(entry, null, rates, null)!.value.toFixed(4)), 3.6)
  })

  test('an unpriced turn says nothing at all — neither ¥0.00 nor 0 credits', () => {
    const entry = entryOf({ provider: 'mystery-platform', model: 'unknown-model', peak: { uncached: 1_000_000 } })
    assert.equal(turnSpendOf(entry, null, null, null), null)
    assert.equal(turnSpendOf(undefined, null, null, null), null, 'and a turn with no ledger says nothing')
  })

  test('the credit path wins when one turn mixed both kinds of platform', () => {
    // The credit figure cannot be derived from money, while money can be derived from a
    // credit price, so the irreplaceable one is what gets shown.
    const mixed: TurnCostEntry = {
      usage: {
        workbuddy: { 'glm-5.3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
        'deepseek-account': { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      },
      requests: { workbuddy: { 'glm-5.3': 2 }, 'deepseek-account': { 'deepseek-v4.1-flash': 1 } },
    }
    const spend = turnSpendOf(mixed, null, null, creditRatesOf({ 'workbuddy:glm-5.3': 0.5 }))
    assert.deepEqual(spend, { value: 1, unit: 'credits' })
  })
})
