// 第三方平台费率表（src/shared/thirdPartyRates.ts）与它在计价链里的位置：
// 用户声明的 <provider>:<model> 费率优先于注册表，但不越过官方价目表。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { configuredRateOf, formatRatesForDisplay, splitRateKey, thirdPartyRatesOf } from '../../src/shared/thirdPartyRates'
import { estimateSessionCostByBucket, priceFaceOf } from '../../src/client/cost'

describe('splitRateKey', () => {
  test('splits on the first colon and normalizes both halves', () => {
    assert.deepEqual(splitRateKey('workbuddy:glm-5.3'), { provider: 'workbuddy', model: 'glm-5.3' })
    // The live ledger really does carry a trailing colon in one of these keys.
    assert.deepEqual(splitRateKey('workbuddy-ai:deepseek-v4.1-flash'), { provider: 'workbuddy-ai', model: 'deepseek-v4.1-flash' })
    assert.deepEqual(splitRateKey('WorkBuddy:GLM-5.3'), { provider: 'workbuddy', model: 'glm-5.3' })
  })

  test('rejects keys without a usable provider or model', () => {
    for (const bad of ['', 'glm-5.3', ':glm-5.3', 'workbuddy:', ':', '::']) {
      assert.equal(splitRateKey(bad), null, JSON.stringify(bad))
    }
  })
})

describe('thirdPartyRatesOf (the config narrowing)', () => {
  test('keeps well-formed entries and defaults the cache rates to input', () => {
    const rates = thirdPartyRatesOf({
      'workbuddy:glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
      'workbuddy-ai:kimi-k3': { input: 3, output: 15 },
    })
    assert.deepEqual(rates, {
      workbuddy: { 'glm-5.3': { hit: 0.26, miss: 1.4, write: 0, out: 4.4 } },
      'workbuddy-ai': { 'kimi-k3': { hit: 3, miss: 3, write: 3, out: 15 } },
    })
  })

  test('drops bad entries without discarding the good ones', () => {
    // One mistyped line must not disable the whole table.
    const rates = thirdPartyRatesOf({
      'workbuddy:glm-5.3': { input: 1.4, output: 4.4 },
      'no-colon': { input: 1, output: 1 },
      'workbuddy:negative': { input: -1, output: 1 },
      'workbuddy:missing-output': { input: 1 },
      'workbuddy:not-an-object': 'nope',
    })
    assert.deepEqual(Object.keys(rates!), ['workbuddy'])
    assert.deepEqual(Object.keys(rates!.workbuddy), ['glm-5.3'])
  })

  test('a value with nothing usable yields null', () => {
    for (const bad of [undefined, null, 'x', 7, [], {}, [{ a: 1 }]]) {
      assert.equal(thirdPartyRatesOf(bad), null, JSON.stringify(bad))
    }
  })
})

describe('configuredRateOf', () => {
  const rates = thirdPartyRatesOf({ 'workbuddy:glm-5.3': { input: 1.4, output: 4.4 } })

  test('matches provider and model case-insensitively, but never loosely', () => {
    assert.equal(configuredRateOf(rates, 'WorkBuddy', 'GLM-5.3')?.miss, 1.4)
    // A different provider naming the same model must NOT borrow this rate.
    assert.equal(configuredRateOf(rates, 'some-other-platform', 'glm-5.3'), null)
    // Nor may a different model borrow it.
    assert.equal(configuredRateOf(rates, 'workbuddy', 'glm-5.3-flash'), null)
  })
})

describe('the third-party rate sits between the official table and the registry', () => {
  const usage = {
    workbuddy: { 'glm-5.3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 500_000 } } },
    'workbuddy-ai': { 'kimi-k3': { peak: { uncached: 0, cacheRead: 2_000_000, cacheWrite: 0, output: 100_000 } } },
  }

  test('without a configured rate a third-party model stays unpriced', () => {
    // Better a dash than a number guessed from one of the dozens of registry vendors.
    const out = estimateSessionCostByBucket(usage, null, null)
    assert.equal(out.total, 0)
    assert.equal(out.any, false)
  })

  test('with a configured rate every bucket is priced per model', () => {
    const rates = thirdPartyRatesOf({
      'workbuddy:glm-5.3': { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
      'workbuddy-ai:kimi-k3': { input: 3, output: 15, cacheRead: 3 },
    })
    const out = estimateSessionCostByBucket(usage, null, rates)
    // glm: 1M×1.4 + 0.5M×4.4 = 1.4 + 2.2 = 3.6
    // kimi: 2M×3 (cache read) + 0.1M×15 = 6 + 1.5 = 7.5
    assert.equal(Number(out.total.toFixed(4)), 11.1)
    assert.equal(Number(out.uncached.toFixed(4)), 1.4)
    assert.equal(Number(out.cacheRead.toFixed(4)), 6)
    assert.equal(Number(out.output.toFixed(4)), 3.7)
    assert.equal(out.any, true)
  })

  test('the official table still wins for the models it lists', () => {
    // deepseek models are the same model wherever they are proxied, so the official
    // CNY table (and its peak/off-peak halving) stays authoritative.
    const u = { workbuddy: { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const rates = thirdPartyRatesOf({ 'workbuddy:deepseek-v4.1-flash': { input: 999, output: 999 } })
    const out = estimateSessionCostByBucket(u, null, rates)
    // 1M uncached at the official off-peak ¥1/M, displayed in USD at the fixed 0.15 rate.
    assert.equal(Number(out.total.toFixed(4)), 0.15)
  })

  test('a third-party-only model is not given a DeepSeek peak/off split', () => {
    // Its whole volume books one period and is never doubled.
    const out = estimateSessionCostByBucket(usage, null, thirdPartyRatesOf({ 'workbuddy:glm-5.3': { input: 1, output: 1 } }))
    assert.equal(out.peak > 0, true)
    assert.equal(out.off, 0)
  })
})

describe('priceFaceOf keeps the documented precedence', () => {
  test('official beats configured beats registry', () => {
    // The order is the whole contract (docs/third-party-pricing.md): a DeepSeek model
    // is the same model wherever it is proxied, so the official table stays on top;
    // a user-declared platform rate beats the registry, which cannot know which of the
    // dozens of same-named vendors the request actually went through.
    const rates = thirdPartyRatesOf({
      'workbuddy:deepseek-v4.1-flash': { input: 999, output: 999 },
      'workbuddy:glm-5.3': { input: 1.4, output: 4.4 },
    })
    // 1. official wins even when a configured rate exists
    const official = priceFaceOf(null, 'workbuddy', 'deepseek-v4.1-flash', rates)
    assert.equal(official?.official, true, 'the official table is authoritative')
    assert.notEqual(official?.rate.miss, 999, 'and it is not the configured rate')
    // 2. configured wins over the registry
    const configured = priceFaceOf(null, 'workbuddy', 'glm-5.3', rates)
    assert.equal(configured?.rate.miss, 1.4)
    assert.equal(configured?.pid, 'workbuddy')
    // 3. with no configured rate the registry decides (null book here -> unpriced)
    assert.equal(priceFaceOf(null, 'workbuddy', 'glm-5.3', null), null)
  })
})

describe('formatRatesForDisplay', () => {
  test('lists the configured pairs in a stable order', () => {
    const rates = thirdPartyRatesOf({ 'workbuddy:glm-5.3': { input: 1, output: 2 }, 'aaa:zz': { input: 1, output: 2 } })
    assert.deepEqual(formatRatesForDisplay(rates), [
      'aaa:zz → in 1 / out 2 / read 1 / write 1',
      'workbuddy:glm-5.3 → in 1 / out 2 / read 1 / write 1',
    ])
  })
})
