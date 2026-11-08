/**
 * The money maths: the two invariants are (1) USD is the accounting unit and the CNY conversion is fixed,
 * and (2) "cannot be priced" is not "free". Both are asserted through the estimator's public results.
 */

import { describe, expect, it } from 'vitest'
import { isRelayRoute } from '../../src/core/providers'
import {
  USD_PER_CNY, billedTokens, buildRateIndex, estimateByBucket, estimateSessionCost, formatCost, formatCredits,
  formatNativeSpend, fromCny, mergeLedgers, moneyOnly, officialRateOf, priceFaceOf, rateOf, symbolOf, toCurrency,
  unitWordOf,
} from '../../src/client/data/cost'
import type { PriceBook } from '../../src/client/data/cost'
import type { CostLedger } from '../../src/wire/model'

const ledger: CostLedger = {
  'deepseek-official': {
    'deepseek-flash': {
      peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
  },
}

describe('currency conversion', () => {
  it('uses one fixed rate and passes USD through untouched', () => {
    expect(USD_PER_CNY).toBe(0.15)
    expect(toCurrency(1.5, 'usd')).toBe(1.5)
    expect(toCurrency(1.5, 'cny')).toBeCloseTo(10)
    expect(fromCny(10, 'cny')).toBe(10)
    expect(fromCny(10, 'usd')).toBeCloseTo(1.5)
  })

  it('names the symbol per currency', () => {
    expect(symbolOf('CNY')).toBe('¥')
    expect(symbolOf('USD')).toBe('$')
    expect(symbolOf('EUR')).toBe('EUR ')
  })
})

describe('the official table in USD space', () => {
  it('converts the off-peak column and bills cache writes as misses', () => {
    const rate = officialRateOf('deepseek-flash')
    expect(rate).not.toBeNull()
    expect(rate?.miss).toBeCloseTo(0.15)
    expect(rate?.write).toBeCloseTo(0.15)
    expect(rate?.hit).toBeCloseTo(0.003)
  })

  it('declines an unlisted model', () => {
    expect(officialRateOf('gpt-4o')).toBeNull()
  })
})

describe('estimateByBucket', () => {
  it('prices official models even with no registry book', () => {
    const cost = estimateByBucket(ledger, null)
    expect(cost.any).toBe(true)
    // Peak: the official miss rate doubles, so 1M tokens at 0.30 USD.
    expect(cost.total).toBeCloseTo(0.3)
    expect(cost.total).toBeCloseTo(cost.peak + cost.off)
  })

  it('returns all zeroes and any=false for an unpriceable ledger', () => {
    const cost = estimateByBucket({ 'some-proxy': { 'unknown-model': { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, null)
    expect(cost.any).toBe(false)
    expect(cost.total).toBe(0)
    expect(estimateSessionCost({ 'some-proxy': { 'unknown-model': { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, null, 'usd')).toBeNull()
  })

  it('prices a registry model from the book', () => {
    const prices = { openai: { 'gpt-x': { hit: 1, miss: 2, write: 2, out: 4 } } }
    const book = { prices, index: buildRateIndex(prices, { openai: '@ai-sdk/openai' }) }
    expect(rateOf(book, 'openai', 'gpt-x')?.miss).toBe(2)
    const cost = estimateByBucket({ openai: { 'gpt-x': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, book)
    expect(cost.any).toBe(true)
    // Non-official providers book at their face rate in the peak bucket, with no doubling.
    expect(cost.total).toBeCloseTo(2)
  })

  it('prefers the user-declared rate over the registry', () => {
    const prices = { workbuddy: { 'model-a': { hit: 1, miss: 100, write: 100, out: 100 } } }
    const book = { prices, index: buildRateIndex(prices, {}) }
    const face = priceFaceOf(book, 'workbuddy', 'model-a', { workbuddy: { 'model-a': { hit: 0.5, miss: 1, write: 1, out: 2 } } })
    expect(face?.rate.miss).toBe(1)
  })
})

describe('ledger helpers', () => {
  it('counts billed tokens without needing a price', () => {
    expect(billedTokens(ledger)).toBe(1_000_000)
    expect(billedTokens(null)).toBe(0)
  })

  it('merges and returns null for empty input', () => {
    expect(mergeLedgers(ledger, ledger)?.['deepseek-official']['deepseek-flash'].peak?.uncached).toBe(2_000_000)
    expect(mergeLedgers(null, null)).toBeNull()
  })

  it('drops credit-billed providers from a money total', () => {
    const mixed: CostLedger = { ...ledger, workbuddy: { 'model-a': { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const only = moneyOnly(mixed, { workbuddy: { 'model-a': 1 } })
    expect(Object.keys(only ?? {})).toEqual(['deepseek-official'])
    expect(moneyOnly({ workbuddy: {} }, { workbuddy: { m: 1 } })).toBeNull()
  })
})

describe('formatting', () => {
  it('formats costs with two decimals at or above one, and precision below', () => {
    // The unit symbol follows the number, so a money figure and a credit figure read the same way.
    expect(formatCost(1.234, 'usd')).toBe('1.23 $')
    expect(formatCost(12, 'cny')).toBe('12.00 ¥')
    expect(formatCost(0.123, 'usd')).toBe('0.12 $')
  })

  it('trims credit trailing zeros', () => {
    expect(formatCredits(0.1)).toBe('0.1')
    expect(formatCredits(2)).toBe('2')
    expect(formatCredits(0)).toBe('0')
  })

  it('renders a platform-native spend in its own currency, symbol after the amount', () => {
    // 1 USD is ¥6.666… at the fixed rate.
    expect(formatNativeSpend(1, 'CNY')).toBe('6.67 ¥')
    expect(formatNativeSpend(1, 'USD')).toBe('1.00 $')
  })

  it('uses the familiar currency symbols as the trailing unit', () => {
    expect(unitWordOf('CNY')).toBe('¥')
    expect(unitWordOf('USD')).toBe('$')
  })
})

describe('relay routes', () => {
  it('recognises a relay and its numbered account rows', () => {
    expect(isRelayRoute('woyao-pro-1')).toBe(true)
    expect(isRelayRoute('woyao-pro-2')).toBe(true)
    expect(isRelayRoute('woyao')).toBe(true)
    expect(isRelayRoute('deepseek-official')).toBe(false)
    // A prefix must end at a dash: `woyaosomething` is not this relay.
    expect(isRelayRoute('woyaosomething')).toBe(false)
  })

  it('refuses to price a relay model from the public book', () => {
    // The relay resells other vendors' models, so the registry book has rates for these models under
    // their real vendors — pricing from it would report a list price the relay never charges.
    const book: PriceBook = {
      prices: { openai: { 'gpt-5': { hit: 1, miss: 2, write: 2, out: 8 } } },
      index: buildRateIndex({ openai: { 'gpt-5': { hit: 1, miss: 2, write: 2, out: 8 } } }, { openai: '@ai-sdk/openai' }),
    }
    expect(priceFaceOf(book, 'woyao-pro-2', 'gpt-5')).toBeNull()
  })

  it('prices a relay model from a declared rate', () => {
    const book: PriceBook = { prices: {}, index: buildRateIndex({}, {}) }
    const rates = { 'woyao-pro-2': { 'gpt-5': { hit: 0.5, miss: 1, write: 1, out: 4 } } }
    expect(priceFaceOf(book, 'woyao-pro-2', 'gpt-5', rates)?.rate.miss).toBe(1)
  })
})
