/**
 * Per-platform spend: each platform is one row in its own unit, and the two units are never summed.
 *
 * The cases that matter: a credit platform takes the request-count path (its multiplier is a relative
 * figure, not a price), a money platform takes the token path in its own billing currency, and an
 * unpriceable model stays out of the per-model map so the UI can label it instead of claiming it was free.
 */

import { describe, expect, it } from 'vitest'
import { mergePlatformSpends, modelSpendRowsOf, platformSpendsOf } from '../../src/client/data/platformSpend'
import { buildRateIndex, type PriceBook } from '../../src/client/data/cost'
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
