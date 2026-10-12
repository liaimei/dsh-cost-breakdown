// 按平台拆分消费（src/client/platformSpend.ts）。
//
// 核心约束：不同平台的账单单位不同——DeepSeek 官方按人民币 token 计价（分峰谷），
// 积分平台按次扣积分。把它们加成一个是把两种货币相加，因此必须各自成行。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { mergePlatformSpends, platformSpendsOf } from '../../src/client/platformSpend'
import { thirdPartyRatesOf } from '../../src/shared/thirdPartyRates'
import type { SessionCallCounts, SessionCostUsage } from '../../src/shared/types'

const CREDITS = { workbuddy: { 'glm-5.3': 0.79, 'deepseek-v4.1-flash': 0.11 } }

function bucket(uncached = 0, output = 0) {
  return { uncached, cacheRead: 0, cacheWrite: 0, output }
}
/** 官方 CNY 价目表：off-peak 每百万 ¥1 输入 / ¥8 输出，USD 显示按固定汇率 0.15。 */
const OFFICIAL: SessionCostUsage = {
  'deepseek-account': { 'deepseek-v4.1-flash': { off: bucket(1_000_000, 0) } },
}
const WORKBUDDY: SessionCostUsage = {
  workbuddy: { 'glm-5.3': { peak: bucket(1_000_000, 100_000) } },
}

describe('platformSpendsOf — one row per platform, each in its own unit', () => {
  test('official and credit platforms are never summed into one figure', () => {
    const usage = { ...OFFICIAL, ...WORKBUDDY }
    const calls: SessionCallCounts = { 'deepseek-account': { 'deepseek-v4.1-flash': 1 }, workbuddy: { 'glm-5.3': 4 } }
    const rows = platformSpendsOf(usage, calls, null, null, CREDITS)
    assert.equal(rows.length, 2, 'one row each; adding them would add ¥ to credits')
    const credit = rows.find(r => r.provider === 'workbuddy')
    const money = rows.find(r => r.provider === 'deepseek-account')
    assert.equal(credit?.unit, 'credits')
    assert.equal(credit?.value, 3.16, '4 calls x 0.79')
    assert.equal(credit?.calls, 4)
    assert.equal(money?.unit, 'money')
    assert.equal(Number(money?.value.toFixed(4)), 0.15, 'official table, off-peak ¥1/M')
  })

  test('a credit platform bills by calls, not by tokens', () => {
    // The token buckets below are huge and must not influence the credit figure.
    const usage: SessionCostUsage = { workbuddy: { 'glm-5.3': { peak: bucket(999_999_999, 999_999_999) } } }
    const rows = platformSpendsOf(usage, { workbuddy: { 'glm-5.3': 2 } }, null, null, CREDITS)
    assert.equal(rows[0].value, 1.58, '2 calls x 0.79')
  })

  test('a platform with no rate at all is left out rather than guessed', () => {
    const usage: SessionCostUsage = { mystery: { 'unknown-model': { peak: bucket(1_000_000) } } }
    assert.deepEqual(platformSpendsOf(usage, null, null, null, null), [])
  })

  test('a model without a rate inside a credit platform contributes no calls', () => {
    // The platform is credit-billed, so its money path must not be used either; the
    // unrated model simply adds nothing.
    const usage: SessionCostUsage = { workbuddy: { 'glm-5.3': { peak: bucket() }, 'mystery-model': { peak: bucket() } } }
    const calls: SessionCallCounts = { workbuddy: { 'glm-5.3': 1, 'mystery-model': 50 } }
    const rows = platformSpendsOf(usage, calls, null, null, CREDITS)
    assert.equal(rows[0].unit, 'credits')
    assert.equal(rows[0].value, 0.79, 'only the rated model counts')
    assert.equal(rows[0].calls, 51, 'but the call total is reported honestly')
  })

  test('a declared token rate still prices a third-party money platform', () => {
    const usage: SessionCostUsage = { 'some-platform': { 'glm-5.3': { peak: bucket(1_000_000, 500_000) } } }
    const rates = thirdPartyRatesOf({ 'some-platform:glm-5.3': { input: 1.4, output: 4.4 } })
    const rows = platformSpendsOf(usage, null, null, rates, null)
    assert.equal(Number(rows[0].value.toFixed(4)), 3.6, '1M x 1.4 + 0.5M x 4.4')
    assert.equal(rows[0].unit, 'money')
  })

  test('rows are ordered by spend, with a stable tiebreak', () => {
    const usage: SessionCostUsage = {
      small: { 'x': { peak: bucket() } },
      big: { 'x': { peak: bucket(1_000_000) } },
    }
    const rates = thirdPartyRatesOf({ 'small:x': { input: 0, output: 0 }, 'big:x': { input: 10, output: 10 } })
    const rows = platformSpendsOf(usage, null, null, rates, null)
    assert.deepEqual(rows.map(r => r.provider), ['big', 'small'])
  })

  test('nothing to show yields no rows, and null usage is safe', () => {
    assert.deepEqual(platformSpendsOf(null, null, null, null, null), [])
    assert.deepEqual(platformSpendsOf(undefined, undefined, undefined, undefined, undefined), [])
    assert.deepEqual(platformSpendsOf({}, null, null, null, null), [])
  })
})

describe('mergePlatformSpends — the cross-session view keeps units apart', () => {
  test('adds each platform up across sessions', () => {
    const a = platformSpendsOf(WORKBUDDY, { workbuddy: { 'glm-5.3': 1 } }, null, null, CREDITS)
    const b = platformSpendsOf(WORKBUDDY, { workbuddy: { 'glm-5.3': 2 } }, null, null, CREDITS)
    const merged = mergePlatformSpends(a, b)
    assert.equal(merged.length, 1)
    assert.equal(Number(merged[0].value.toFixed(4)), 2.37, '3 calls total x 0.79')
    assert.equal(merged[0].calls, 3)
  })

  test('keeps money and credit rows separate and ordered by spend', () => {
    const rows = mergePlatformSpends(
      platformSpendsOf(OFFICIAL, { 'deepseek-account': { 'deepseek-v4.1-flash': 1 } }, null, null, CREDITS),
      platformSpendsOf(WORKBUDDY, { workbuddy: { 'glm-5.3': 10 } }, null, null, CREDITS),
    )
    assert.deepEqual(rows.map(r => r.unit).sort(), ['credits', 'money'])
    assert.equal(rows[0].provider, 'workbuddy', 'bigger spend first')
  })

  test('an empty merge is empty, not a zero row', () => {
    assert.deepEqual(mergePlatformSpends([], []), [])
  })
})
