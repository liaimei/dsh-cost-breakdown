// 平台剩余积分（src/host/platformCredits.ts）。
//
// 数字来自平台自己的状态路由——它只接受回环请求，且要读平台自己的登录凭据，
// 因此只有 host 取得到。取不到时必须整体放弃：显示一个过期或错配的额度
// 比不显示更糟。

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { creditsOfPayload, platformCredits, resetPlatformCredits, setPlatformCreditsFetcher } from '../../src/host/platformCredits'

afterEach(() => { setPlatformCreditsFetcher(null); resetPlatformCredits() })

describe('creditsOfPayload — narrowing the platform\u2019s status document', () => {
  test('reads a signed-in account\u2019s total', () => {
    assert.deepEqual(
      creditsOfPayload({ status: 'signed-in', credits: { total: 6434, accounts: [] } }),
      { total: 6434, unlimited: false },
    )
  })

  test('carries the unlimited flag and the reset time when present', () => {
    assert.deepEqual(
      creditsOfPayload({ status: 'signed-in', credits: { total: 0, unlimited: true, cycleResetTime: '2026-11-01 00:00:00' } }),
      { total: 0, unlimited: true, cycleResetTime: '2026-11-01 00:00:00' },
    )
  })

  test('a zero balance is a real reading, not a miss', () => {
    assert.deepEqual(creditsOfPayload({ status: 'signed-in', credits: { total: 0 } }), { total: 0, unlimited: false })
  })

  test('anything unusable yields null rather than a guessed figure', () => {
    for (const bad of [
      null, 'x', 7, [],
      { status: 'signed-out', credits: { total: 10 } },   // not signed in
      { status: 'signed-in' },                            // no credits at all
      { status: 'signed-in', credits: null },
      { status: 'signed-in', credits: 'nope' },
      { status: 'signed-in', credits: { total: 'many' } },
      { status: 'signed-in', credits: { total: -1 } },
      { status: 'signed-in', credits: { total: Number.NaN } },
    ]) {
      assert.equal(creditsOfPayload(bad), null, JSON.stringify(bad))
    }
  })
})

describe('platformCredits — the transport', () => {
  test('a non-ok response yields nothing', async () => {
    setPlatformCreditsFetcher(async () => ({ ok: false, json: async () => ({}) }))
    assert.equal(await platformCredits(), null)
  })

  test('a thrown fetch (platform absent) yields nothing, never rejects', async () => {
    setPlatformCreditsFetcher(async () => { throw new Error('ECONNREFUSED') })
    assert.equal(await platformCredits(), null)
  })

  test('a good answer is parsed and then served from cache', async () => {
    let calls = 0
    setPlatformCreditsFetcher(async () => {
      calls += 1
      return { ok: true, json: async () => ({ status: 'signed-in', credits: { total: 42 } }) }
    })
    assert.deepEqual(await platformCredits(1000), { total: 42, unlimited: false })
    assert.deepEqual(await platformCredits(2000), { total: 42, unlimited: false })
    assert.equal(calls, 1, 'the second read inside the window does not hit the platform')
  })

  test('a failure is cached too, so a missing platform is not retried every frame', async () => {
    let calls = 0
    setPlatformCreditsFetcher(async () => { calls += 1; throw new Error('gone') })
    await platformCredits(1000)
    await platformCredits(2000)
    assert.equal(calls, 1)
  })
})
