// 从平台目录读按次积分费率（src/host/creditRates.ts）。
//
// 这是「按平台显示什么单位」的数据来源：workbuddy 把费率写在它自己的目录里，
// 客户端够不着，只能由 host 读出后下发。读不到时必须整体放弃——猜一个费率
// 会给出一个看起来合理却错的钱数，那比不显示糟得多。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { creditAmountOf, creditRateOf, creditRatesOf } from '../../src/shared/creditRates'
import { creditRatesFromCatalog, dshHome, platformCreditRates, resetPlatformCreditRates } from '../../src/host/creditRates'

/** 一份真实形状的目录载荷；`billing.credits` 就是平台给的原文。 */
function catalog(entries: Record<string, unknown>): unknown {
  return { version: 1, entries }
}

function entry(models: unknown[], fetchedAtMs = 1): unknown {
  return { source: 'workbuddy:cli', fetchedAtMs, models }
}

describe('creditAmountOf — reading the platform\u2019s own wording', () => {
  test('accepts the shapes the platform actually writes', () => {
    // Live samples: some carry an `x` prefix, one omits the `credits` suffix entirely.
    assert.equal(creditAmountOf('x0.11 credits'), 0.11)
    assert.equal(creditAmountOf('x1.62'), 1.62)
    assert.equal(creditAmountOf('x0.00 credits'), 0)
    assert.equal(creditAmountOf(0.25), 0.25)
  })

  test('refuses anything it cannot read as a number', () => {
    // A guess here becomes a wrong money figure, so ambiguity must fail closed.
    for (const bad of ['', 'free', 'N/A', 'credits', 'x', '-1', 'x1.2.3', null, undefined, {}, [], Number.NaN]) {
      assert.equal(creditAmountOf(bad), null, JSON.stringify(bad))
    }
  })
})

describe('creditRatesFromCatalog — the untrusted platform file', () => {
  test('reads the newest account entry, for the route the catalog belongs to', () => {
    const rates = creditRatesFromCatalog(catalog({
      old: entry([{ id: 'glm-5.3', billing: { credits: 'x9.99 credits' } }], 1),
      fresh: entry([
        { id: 'glm-5.3', billing: { credits: 'x0.79 credits' } },
        { id: 'deepseek-v4.1-flash', billing: { credits: 'x0.11 credits' } },
      ], 2),
    }), 'workbuddy')
    // The newer fetch wins: an older account's prices may already be stale.
    assert.equal(rates?.workbuddy['glm-5.3'], 0.79)
    assert.equal(rates?.workbuddy['deepseek-v4.1-flash'], 0.11)
    // Only the route this catalog belongs to: the two editions keep separate
    // models, accounts and credits, so one must never price the other.
    assert.equal(Object.keys(rates ?? {}).length, 1)
  })

  test('the international catalog is read under its own route', () => {
    // `.workbuddy-ai-catalog.json` describes the international edition; its
    // multipliers must land on `workbuddy-ai`, not on the CN route.
    const rates = creditRatesFromCatalog(
      catalog({ a: entry([{ id: 'glm-5.3', billing: { credits: 'x0.79' } }]) }), 'workbuddy-ai')
    assert.equal(rates?.['workbuddy-ai']['glm-5.3'], 0.79)
    assert.equal(rates?.workbuddy, undefined)
  })

  test('keeps a genuinely free model at zero rather than dropping it', () => {
    const rates = creditRatesFromCatalog(catalog({ a: entry([{ id: 'hy3', billing: { credits: 'x0.00 credits', free: true } }]) }))
    assert.equal(rates?.workbuddy.hy3, 0, 'zero is a real rate, not a missing one')
  })

  test('drops an unreadable model without losing the readable ones', () => {
    const rates = creditRatesFromCatalog(catalog({ a: entry([
      { id: 'good', billing: { credits: 'x0.5 credits' } },
      { id: 'bad', billing: { credits: 'unknown' } },
      { id: 'no-billing' },
      { billing: { credits: 'x0.1 credits' } },
      'not-an-object',
    ]) }))
    assert.deepEqual(Object.keys(rates?.workbuddy ?? {}), ['good'])
  })

  test('an unrecognized format version is discarded whole', () => {
    // Reading an unknown structure would produce a plausible but wrong table.
    assert.equal(creditRatesFromCatalog({ version: 2, entries: { a: entry([{ id: 'x', billing: { credits: 'x1 credits' } }]) } }), null)
    assert.equal(creditRatesFromCatalog({ entries: {} }), null, 'no version at all')
  })

  test('malformed envelopes yield nothing', () => {
    for (const bad of [null, 'x', 7, [], {}, { version: 1 }, { version: 1, entries: [] },
      { version: 1, entries: { a: { models: 'no' } } },
      { version: 1, entries: { a: entry([]) } }]) {
      assert.equal(creditRatesFromCatalog(bad), null, JSON.stringify(bad))
    }
  })
})

describe('platformCreditRates — the on-disk reader', () => {
  test('reads the live catalog when one is present, and caches it', () => {
    resetPlatformCreditRates()
    const home = dshHome()
    assert.equal(typeof home, 'string')
    const rates = platformCreditRates(1000)
    if (rates === null) return // no workbuddy install on this machine — nothing to assert
    assert.ok(Object.keys(rates.workbuddy).length > 0, 'a present catalog yields rates')
    // Second call within the window answers from cache (same object identity).
    assert.equal(platformCreditRates(2000), rates)
    resetPlatformCreditRates()
  })
})

describe('creditRatesOf — normalizing both write shapes', () => {
  test('accepts the flat `<provider>:<model>` keys a settings field would use', () => {
    assert.deepEqual(creditRatesOf({ 'WorkBuddy:GLM-5.3': 0.5, 'w:m': 'x1', 'nope': 1, 'a:': 1 }), {
      workbuddy: { 'glm-5.3': 0.5 },
    })
  })

  test('accepts the nested shape the platform catalog is already in', () => {
    // The regression: the reader emits `{ provider: { model: n } }`, and a narrowing
    // that only understood flat keys rejected it whole — the live table came back null
    // and workbuddy turns silently fell through to money.
    assert.deepEqual(creditRatesOf({ workbuddy: { 'glm-5.3': 0.79, bad: 'x' }, 'workbuddy-ai': { hy3: 0 } }), {
      workbuddy: { 'glm-5.3': 0.79 },
      'workbuddy-ai': { hy3: 0 },
    })
  })

  test('both shapes may be mixed, and junk is dropped either way', () => {
    assert.deepEqual(creditRatesOf({ 'a:b': 1, c: { d: 2, e: -1 }, f: 'no', g: [] }), {
      a: { b: 1 },
      c: { d: 2 },
    })
  })

  test('creditRateOf matches case-insensitively but never loosely', () => {
    const rates = creditRatesOf({ 'workbuddy:glm-5.3': 0.5 })
    assert.equal(creditRateOf(rates, 'WorkBuddy', 'GLM-5.3'), 0.5)
    assert.equal(creditRateOf(rates, 'other', 'glm-5.3'), null)
    assert.equal(creditRateOf(rates, 'workbuddy', 'glm-5.3-flash'), null)
  })
})
