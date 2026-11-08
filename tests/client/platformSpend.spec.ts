/**
 * Per-platform spend: each platform is one row in its own unit, and the two units are never summed.
 *
 * The cases that matter: a credit platform takes the request-count path (its multiplier is a relative
 * figure, not a price), a money platform takes the token path in its own billing currency, and an
 * unpriceable model stays out of the per-model map so the UI can label it instead of claiming it was free.
 */

import { describe, expect, it } from 'vitest'
import { mergePlatformSpends, modelSpendRowsOf, platformSpendsOf } from '../../src/client/data/platformSpend'
import { buildRateIndex, moneyOnly, type PriceBook } from '../../src/client/data/cost'
import type { CallLedger, CostLedger } from '../../src/wire/model'

const book: PriceBook = {
  prices: { openai: { 'gpt-x': { hit: 1, miss: 2, write: 2, out: 4 } } },
  index: buildRateIndex({ openai: { 'gpt-x': { hit: 1, miss: 2, write: 2, out: 4 } } }, { openai: '@ai-sdk/openai' }),
}

/** A ledger with one million uncached tokens on a given provider/model. */
function ledger(provider: string, model: string): CostLedger {
  return { [provider]: { [model]: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
}

describe('platformSpendsOf', () => {
  it('prices an official model in CNY and a registry model in USD', () => {
    const usage: CostLedger = {
      ...ledger('deepseek-official', 'deepseek-flash'),
      ...ledger('openai', 'gpt-x'),
    }
    const rows = platformSpendsOf(usage, null, book, null, null)
    const deepseek = rows.find(row => row.provider === 'deepseek-official')
    const openai = rows.find(row => row.provider === 'openai')
    // Official providers bill in CNY; a mismatched display currency would be a wrong number, not a style.
    expect(deepseek?.currency).toBe('CNY')
    expect(openai?.currency).toBe('USD')
    // Sorted by value descending: 1M tokens at the registry rate ($2) outranks the official peak rate
    // ($0.30 after the CNY conversion and the peak doubling).
    expect(rows.map(row => row.provider)).toEqual(['openai', 'deepseek-official'])
    expect(openai?.value).toBeCloseTo(2)
  })

  it('takes the credit path when the platform has a per-request rate', () => {
    const calls: CallLedger = { workbuddy: { 'model-a': 3 } }
    const usage = ledger('workbuddy', 'model-a')
    const rows = platformSpendsOf(usage, calls, null, null, { workbuddy: { 'model-a': 2 } })
    expect(rows).toHaveLength(1)
    expect(rows[0].unit).toBe('credits')
    // 3 requests × 2 credits; the token count is irrelevant on this path.
    expect(rows[0].value).toBe(6)
    expect(rows[0].calls).toBe(3)
    expect(rows[0].byModel?.['model-a']).toBe(6)
  })

  it('omits a platform that cannot be priced at all', () => {
    const rows = platformSpendsOf(ledger('mystery', 'unknown'), null, null, null, null)
    expect(rows).toEqual([])
  })

  it('keeps an unpriceable model out of the per-model map', () => {
    const usage = ledger('openai', 'gpt-x')
    // The registry branch is terminal: an unknown model there is "no rate", not a namesake price.
    const mixed: CostLedger = { openai: { 'gpt-x': usage.openai['gpt-x'], other: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const rows = platformSpendsOf(mixed, null, book, null, null)
    expect(rows[0].byModel?.['gpt-x']).toBeDefined()
    expect(rows[0].byModel?.other).toBeUndefined()
    // The detail rows report it explicitly as unpriced.
    const detail = modelSpendRowsOf(rows[0])
    expect(detail.find(row => row.model === 'other')?.value).toBeNull()
  })

  it('sorts per-model rows by spend, then unpriced ones by name', () => {
    const usage: CostLedger = {
      openai: {
        'gpt-x': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } },
        zzz: { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } },
        aaa: { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } },
      },
    }
    const rows = platformSpendsOf(usage, null, book, null, null)
    expect(modelSpendRowsOf(rows[0]).map(row => row.model)).toEqual(['gpt-x', 'aaa', 'zzz'])
  })
})

describe('mergePlatformSpends', () => {
  it('sums the same unit and never adds two currencies', () => {
    const a = platformSpendsOf(ledger('deepseek-official', 'deepseek-flash'), null, book, null, null)
    const b = platformSpendsOf(ledger('deepseek-official', 'deepseek-flash'), null, book, null, null)
    const merged = mergePlatformSpends(a, b)
    expect(merged).toHaveLength(1)
    expect(merged[0].value).toBeCloseTo((a[0].value ?? 0) * 2)
    expect(merged[0].models).toEqual(['deepseek-flash'])
  })
})

describe('subscription plans', () => {
  /** One GLM Coding Plan model: 1M uncached input, 1M cached input, 1M output. */
  const glm: CostLedger = {
    'zai-coding-cn': {
      'glm-5.3': {
        peak: { uncached: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 },
      },
    },
  }

  it('bills a subscription route in credits, never as a token price', () => {
    const rows = platformSpendsOf(glm, { 'zai-coding-cn': { 'glm-5.3': 3 } }, book, null, null, 0)
    const row = rows.find(entry => entry.provider === 'zai-coding-cn')
    expect(row?.unit).toBe('plan')
    expect(row?.plan?.family.id).toBe('glm-coding')
    expect(row?.plan?.tier?.id).toBe('lite')
    // (1M×6.9 + 1M×1.7 + 1M×24) / 10000 = 3260 credits, billed in full inside the peak window.
    expect(row?.plan?.credits).toBeCloseTo(3260, 5)
    // The ledger's CNY figure is quota, so no currency may be attached to it.
    expect(row?.currency).toBeUndefined()
  })

  it('halves the credit charge for the off-peak period', () => {
    const offPeak: CostLedger = {
      'zai-coding-cn': {
        'glm-5.3': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } },
      },
    }
    const rows = platformSpendsOf(offPeak, null, book, null, null, 0)
    const row = rows.find(entry => entry.provider === 'zai-coding-cn')
    // 1M×6.9/10000 = 690, halved by the off-peak factor.
    expect(row?.plan?.credits).toBeCloseTo(345, 5)
  })

  it('reports the tier the preference selects and the share of its monthly quota', () => {
    const rows = platformSpendsOf(glm, null, book, null, null, 2)
    const row = rows.find(entry => entry.provider === 'zai-coding-cn')
    expect(row?.plan?.tier?.id).toBe('max')
    // 3260 credits of a 140,000/week quota, converted to a month.
    expect(row?.plan?.share).toBeCloseTo(3260 / (140000 * 4.3482), 6)
    expect(row?.plan?.feeCny).toBeCloseTo(469 * (3260 / (140000 * 4.3482)), 4)
  })

  it('marks a model with no plan coefficient as uncomputable rather than free', () => {
    const unknown: CostLedger = {
      'zai-coding-cn': { 'glm-unknown': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const rows = platformSpendsOf(unknown, null, book, null, null, 0)
    const row = rows.find(entry => entry.provider === 'zai-coding-cn')
    expect(row?.plan?.byModel[0].credits).toBeNull()
    expect(row?.plan?.credits).toBe(0)
  })

  it('keeps an unpublished plan price unknown instead of inventing one', () => {
    const rows = platformSpendsOf(glm, null, book, null, null, 0)
    const minimax = platformSpendsOf(
      { 'minimax-cn': { 'minimax-m3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      null, book, null, null, 0,
    ).find(entry => entry.provider === 'minimax-cn')
    expect(rows.length).toBe(1)
    // M Plan publishes no fee and no credit table: both must stay null, not zero.
    expect(minimax?.plan?.tier?.monthlyCny).toBeNull()
    expect(minimax?.plan?.feeCny).toBeNull()
    expect(minimax?.plan?.share).toBeNull()
  })

  it('leaves a metered route on the money path', () => {
    const rows = platformSpendsOf(ledger('deepseek-official', 'deepseek-flash'), null, book, null, null, 0)
    expect(rows[0]?.unit).toBe('money')
    expect(rows[0]?.plan).toBeUndefined()
  })
})

describe('every subscription route', () => {
  const routes: Array<[string, string, string]> = [
    ['zai-coding-cn', 'glm-coding', 'glm-5.3'],
    ['zai', 'glm-coding-intl', 'glm-5.3'],
    ['qwen-token-plan-cn', 'qwen-token-plan', 'qwen3.8-max'],
    ['qwen-token-plan', 'qwen-token-plan', 'qwen3.8-max'],
    ['minimax-cn', 'minimax-mplan', 'minimax-m3'],
    ['kimi-coding', 'kimi-code', 'kimi-k2.5'],
    ['xiaomi-token-plan-cn', 'xiaomi-token-plan', 'mimo-v2.6-pro'],
  ]

  for (const [route, familyId, model] of routes) {
    it(`classifies ${route} as the ${familyId} plan, not a token price`, () => {
      const usage: CostLedger = {
        [route]: { [model]: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }
      const row = platformSpendsOf(usage, null, book, null, null, 0).find(entry => entry.provider === route)
      expect(row?.unit).toBe('plan')
      expect(row?.plan?.family.id).toBe(familyId)
    })
  }

  it('keeps an unpublished fee unknown for every family that does not state one', () => {
    for (const route of ['minimax-cn', 'kimi-coding', 'xiaomi-token-plan-cn', 'zai']) {
      const model = route === 'zai' ? 'glm-5.3' : route === 'minimax-cn' ? 'minimax-m3' : 'kimi-k2.5'
      const usage: CostLedger = {
        [route]: { [model]: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      }
      const row = platformSpendsOf(usage, null, book, null, null, 0).find(entry => entry.provider === route)
      expect(row?.plan?.feeCny).toBeNull()
    }
  })

  it('meters the Qwen Token Plan against its monthly quota', () => {
    const usage: CostLedger = {
      'qwen-token-plan-cn': { 'qwen3.8-max': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const row = platformSpendsOf(usage, null, book, null, null, 0).find(entry => entry.provider === 'qwen-token-plan-cn')
    // No published per-model credit coefficients, so credits stay uncomputable rather than invented.
    expect(row?.plan?.credits).toBe(0)
    expect(row?.plan?.byModel[0].credits).toBeNull()
    // The tier itself is known: Lite at ¥60 with 11,500 credits a month.
    expect(row?.plan?.tier?.label).toBe('Lite')
    expect(row?.plan?.tier?.creditsMonth).toBe(11_500)
  })

  it('does not add a subscription route into a money total', () => {
    const mixed: CostLedger = {
      'deepseek-official': { 'deepseek-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      'zai-coding-cn': { 'glm-5.3': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const kept = moneyOnly(mixed, null)
    expect(Object.keys(kept ?? {})).toEqual(['deepseek-official'])
  })
})
