// 平台卡「剩余额度」那一行的文案（src/client/platformBalances.ts）。
//
// 两个页面共用一个函数：会话页与概览页若各写一遍，迟早对同一个余额给出不同答案。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { platformBalanceTexts } from '../../src/client/platformBalances'
import type { PlatformSpend } from '../../src/client/platformSpend'

const credit = (provider: string): PlatformSpend => ({
  provider, unit: 'credits', value: 100, calls: 10, models: ['m'],
})
const money = (provider: string): PlatformSpend => ({
  provider, unit: 'money', value: 1, calls: 10, models: ['m'],
})

describe('platformBalanceTexts', () => {
  test('each credit edition draws on its own pool', () => {
    // CN and international are separate accounts; showing one's balance under the
    // other's name would be a plain falsehood.
    const rows = [credit('workbuddy'), credit('workbuddy-ai')]
    const credits = {
      workbuddy: { total: 6251, unlimited: false },
      'workbuddy-ai': { total: 350, unlimited: false },
    }
    const out = platformBalanceTexts(rows, null, credits as never)
    assert.notEqual(out.workbuddy?.text, out['workbuddy-ai']?.text, 'the two pools differ')
    assert.match(out.workbuddy?.text ?? '', /6251/)
    assert.match(out['workbuddy-ai']?.text ?? '', /350/)
  })

  test('an unlimited credit pool shows no balance row', () => {
    const out = platformBalanceTexts([credit('workbuddy')], null, { workbuddy: { total: 0, unlimited: true } } as never)
    assert.equal(out.workbuddy, undefined)
  })

  test('an unknown credit platform shows no balance rather than a neighbour\u2019s', () => {
    const out = platformBalanceTexts([credit('someone-else')], null, { workbuddy: { total: 6251, unlimited: false } } as never)
    assert.equal(out['someone-else'], undefined)
  })

  test('an official route shows the currency balance, others do not', () => {
    const rows = [money('deepseek-account'), money('kimi-coding')]
    const balance = { isAvailable: true, balances: [{ currency: 'cny', total: 37.16 }] }
    const out = platformBalanceTexts(rows, balance as never, null)
    assert.match(out['deepseek-account']?.text ?? '', /37\.16/)
    assert.equal(out['kimi-coding'], undefined, 'no balance belongs on a third-party route')
  })

  test('an official account holding only USD falls back to that entry, symbol and all', () => {
    // CNY is only the *preference*; the entry's own currency decides the symbol, so a
    // dollar-only account is never dressed up as yuan.
    const rows = [money('deepseek-account')]
    const usdOnly = { isAvailable: true, balances: [{ currency: 'USD', total: 5.5, granted: 0, toppedUp: 5.5 }] }
    const out = platformBalanceTexts(rows, usdOnly as never, null)
    assert.equal(out['deepseek-account']?.text, '$5.50')
  })

  test('no balance data at all leaves every row silent', () => {
    const out = platformBalanceTexts([money('deepseek-account'), credit('workbuddy')], null, null)
    assert.equal(out['deepseek-account'], undefined)
    assert.equal(out.workbuddy, undefined)
  })
})
