// 概览页的平台行必须认出积分平台。
//
// 截图里的回归：workbuddy / workbuddy-ai 是**积分**平台，却显示了人民币
// （¥51.04 / ¥8.45）。原因是 `kpisOf` 调 `billedTotalsOf` 时漏传了积分费率表，
// `platformSpendsOf` 因此认不出它们按次计积分，转而套上官方人民币费率——
// 而 `deepseek-v4.1-flash` 恰好在官方表里，于是得到一个看起来合理的金额。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { kpisOf } from '../../src/client/overview'
import { rowOf } from './overview.fixtures'
import type { ContextTimeline } from '../../src/shared/types'

const M = 1_000_000

/** 一个只用积分平台的会话：账本里有量、timeline 里有积分费率。 */
function creditRow() {
  return rowOf({
    familyCost: {
      workbuddy: { 'deepseek-v4.1-flash': { peak: { uncached: 10 * M, cacheRead: 100 * M, cacheWrite: 0, output: 5 * M } } },
    },
    familyCalls: { workbuddy: { 'deepseek-v4.1-flash': 2100 } },
    timeline: {
      creditRates: { workbuddy: { 'deepseek-v4.1-flash': 0.11 } },
      requests: [], counts: { turns: 1 },
    } as unknown as ContextTimeline,
  })
}

describe('billedTotalsOf — the overview platform rows honour credits', () => {
  test('a credit platform is reported in credits, never in CNY', () => {
    const k = kpisOf([creditRow()], 1, null, 'cny')
    const row = k.billed?.platforms.find(p => p.provider === 'workbuddy')
    assert.ok(row !== undefined, 'the platform appears')
    assert.equal(row.unit, 'credits', 'and is labelled as credits, not money')
    // 2100 calls x 0.11 credits.
    assert.equal(row.value, 231)
  })

  test('its money-priced sibling is unaffected', () => {
    const mixed = rowOf({
      familyCost: {
        workbuddy: { 'deepseek-v4.1-flash': { peak: { uncached: 10 * M, cacheRead: 0, cacheWrite: 0, output: 0 } } },
        'deepseek-account': { 'deepseek-v4-flash': { off: { uncached: 10 * M, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      },
      familyCalls: { workbuddy: { 'deepseek-v4.1-flash': 100 }, 'deepseek-account': { 'deepseek-v4-flash': 10 } },
      timeline: {
        creditRates: { workbuddy: { 'deepseek-v4.1-flash': 0.11 } },
        requests: [], counts: { turns: 1 },
      } as unknown as ContextTimeline,
    })
    const k = kpisOf([mixed], 1, null, 'cny')
    const by = Object.fromEntries((k.billed?.platforms ?? []).map(p => [p.provider, p.unit]))
    assert.equal(by.workbuddy, 'credits')
    assert.equal(by['deepseek-account'], 'money')
  })
})
