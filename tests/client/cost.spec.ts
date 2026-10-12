// Session-cost estimate (src/client/cost.ts): the model-price-book lookup tiers and the fixed 1 CNY = 0.15 USD conversion.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSessionCost, estimateSessionCostByBucket, estimateSessionCostByPeriod, billedTokensOf, formatCost, formatPriceRate, mergeCostUsage, moneyOnlyUsage, priceFaceOf, priceIndexOf, priceOf, toCurrency } from '../../src/client/cost'
import type { ModelBook, ModelPrices } from '../../src/client/cost'
import type { CostBucketTotals, SessionCostUsage } from '../../src/shared/types'

const M = 1_000_000

/** Real-shaped rates (deepseek-v4-flash on models.dev — the official off-peak list; no cache_write published). */
const FLASH = { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 }
const PRO = { hit: 0.003625, miss: 0.435, write: 0.435, out: 0.87 }
const KIMI = { hit: 0.19, miss: 0.95, write: 0.95, out: 4 }
const K3 = { hit: 0.3, miss: 3, write: 3, out: 15 }

/** This plugin's OFFICIAL CNY table, in the book's USD space at 1 CNY = 0.15 USD.
 *  Flash's official list matches models.dev because that book IS DeepSeek's own
 *  off-peak listing; Pro's does not, and the official table wins there. Cache
 *  writes are not billed separately, so they price at the cache-miss rate. */
const OFFICIAL_FLASH = { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 }
const OFFICIAL_PRO = { hit: 0.0225, miss: 0.675, write: 0.675, out: 2.025 }

/** The book is keyed by the models.dev provider ids, exactly as extracted. */
const BOOK: ModelPrices = {
  deepseek: { 'deepseek-v4-flash': FLASH, 'deepseek-v4-pro': PRO },
  moonshotai: { 'kimi-k2.7-code': KIMI, 'kimi-k3': K3 },
  'opencode-go': { 'deepseek-v4-flash': FLASH },
}

/** A book plus its resolution index (npm absent → no vendor is "primary"). */
function bookOf(prices: ModelPrices, npmOf: Record<string, string | null> = {}): ModelBook {
  return { prices, index: priceIndexOf(prices, npmOf) }
}

const BOOK_B: ModelBook = bookOf(BOOK)

function bucket(cacheRead: number, uncached: number, cacheWrite: number, output: number): CostBucketTotals {
  return { cacheRead, uncached, cacheWrite, output }
}

function close(actual: number | null, expected: number, message?: string): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, message ?? `expected ~${expected}, got ${actual}`)
}

describe('toCurrency', () => {
  test('USD passes through; CNY divides the fixed 0.15 rate', () => {
    assert.equal(toCurrency(1.2, 'usd'), 1.2)
    close(toCurrency(1.2, 'cny'), 8)
    close(toCurrency(0.3, 'cny'), 2)
  })
})

describe('priceOf', () => {
  test('the official CNY table wins for the models it lists, whatever the provider id', () => {
    // Flash's official list coincides with the registry's; Pro's does not.
    assert.deepEqual(priceOf(BOOK_B, 'deepseek-official', 'deepseek-v4-flash'), OFFICIAL_FLASH)
    assert.deepEqual(priceOf(BOOK_B, 'deepseek-account', 'deepseek-v4-pro'), OFFICIAL_PRO, 'both native DeepSeek routes price officially')
    assert.deepEqual(priceOf(BOOK_B, 'opencode-go', 'deepseek-v4-flash'), OFFICIAL_FLASH, 'a mirror still bills at the official rate')
  })

  test('a mapped dsh provider id resolves to its models.dev branch for non-official models', () => {
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'kimi-k2.7-code'), KIMI)
  })

  test('an unmapped dsh provider id passes through to the book verbatim', () => {
    assert.equal(priceOf(bookOf({ anthropic: { claude: KIMI } }), 'anthropic', 'claude'), KIMI)
  })

  test('a known provider falls back to a case-insensitive model match', () => {
    assert.equal(priceOf(bookOf({ minimax: { 'MiniMax-M2.5': KIMI } }), 'minimax-cn', 'minimax-m2.5'), KIMI)
  })

  test('a short dsh model id suffix-matches its namespaced registry id', () => {
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'k3'), K3)
    assert.equal(priceOf(BOOK_B, 'kimi-coding', 'K3'), K3, 'the suffix tier is case-insensitive too')
  })

  test('several suffix candidates in one branch are ambiguous', () => {
    const book = bookOf({ moonshotai: { 'kimi-k3': K3, 'other-k3': KIMI } })
    assert.equal(priceOf(book, 'kimi-coding', 'k3'), null)
  })

  test('a known provider with an unknown model prices null (no cross-provider guess)', () => {
    assert.equal(priceOf(BOOK_B, 'deepseek', 'kimi-k2.7-code'), null)
  })

  test('a provider the book does not carry prices through the model-side index', () => {
    assert.deepEqual(priceOf(BOOK_B, '', 'kimi-k2.7-code'), KIMI, 'exactly one branch carries it')
    assert.deepEqual(priceOf(BOOK_B, 'future-provider', 'kimi-k2.7-code'), KIMI)
    assert.equal(priceOf(BOOK_B, '', 'mystery'), null)
  })

  test('the official table prices without any book at all', () => {
    assert.deepEqual(priceOf(null, 'deepseek-official', 'deepseek-v4-flash'), OFFICIAL_FLASH)
    assert.deepEqual(priceOf(undefined, 'deepseek', 'deepseek-v4.1-pro'), OFFICIAL_PRO)
    // A model the official table does not carry still needs the book.
    assert.equal(priceOf(null, '', 'kimi-k2.7-code'), null)
    assert.equal(priceOf(bookOf({}), '', 'kimi-k2.7-code'), null)
  })
})

describe('priceIndexOf / the model-side resolution tiers', () => {
  const ANTHROPIC_RATE = { hit: 0.2, miss: 2, write: 2.5, out: 10 }
  const MIRROR_RATE = { hit: 0.2, miss: 2, write: 2.5, out: 10 }
  const VENDOR_BOOK: ModelPrices = {
    anthropic: { 'claude-sonnet-5': ANTHROPIC_RATE, 'claude-haiku-4': ANTHROPIC_RATE },
    openrouter: { 'claude-sonnet-5': MIRROR_RATE },
    vivgrid: { 'claude-sonnet-5': { hit: 0.5, miss: 2, write: 2.5, out: 10 } },
    'bare-host': { 'gpt-oss-120b': KIMI },
  }
  const VENDOR_NPM = {
    anthropic: '@ai-sdk/anthropic',
    openrouter: '@openrouter/ai-sdk-provider',
    vivgrid: '@ai-sdk/openai',
    'bare-host': null,
  }
  const VENDOR_B = bookOf(VENDOR_BOOK, VENDOR_NPM)

  test('the index lists each model under its exact key and suffix tails', () => {
    const tails = [...VENDOR_B.index.byModel.get('sonnet-5') ?? []]
    assert.ok(tails.some(c => c.pid === 'anthropic'), 'the `-tail` of a registry id is indexed for short dsh spellings')
    const exact = [...VENDOR_B.index.byModel.get('claude-sonnet-5') ?? []]
    assert.equal(exact.filter(c => c.pid === 'anthropic').length, 1, 'the same provider and rate dedups across keys')
  })

  test('the vendor flag is a provider whose @ai-sdk package is named after itself', () => {
    const exact = new Map([...VENDOR_B.index.byModel.get('claude-sonnet-5') ?? []].map(c => [c.pid, c]))
    assert.equal(exact.get('anthropic')?.primary, true)
    assert.equal(exact.get('openrouter')?.primary, false, 'a foreign gateway package is not the vendor')
    assert.equal(exact.get('vivgrid')?.primary, false, 'riding @ai-sdk/openai does not make vivgrid OpenAI')
  })

  test('tier: the model-own vendor wins (issue #91: unknown routes price claude/gpt models)', () => {
    assert.deepEqual(priceOf(VENDOR_B, 'claude', 'claude-sonnet-5'), ANTHROPIC_RATE)
    assert.deepEqual(priceOf(VENDOR_B, 'codex', 'claude-sonnet-5'), ANTHROPIC_RATE, 'the proxy route spells no vendor')
  })

  test('tier: the org segment of vendor/model dialects names the vendor', () => {
    // Non-official model ids on purpose: an official CNY row short-circuits the book.
    const orgBook = bookOf({
      moonshotai: { 'kimi-k3': PRO },
      gateway: { 'kimi-k3': KIMI },
      acme: { 'acme/model-1': K3 },
    }, { moonshotai: '@ai-sdk/openai-compatible', gateway: '@ai-sdk/openai-compatible' })
    assert.deepEqual(priceOf(orgBook, 'together', 'moonshotai/Kimi-K3'), PRO, 'the org segment resolves to its branch')
    assert.deepEqual(priceOf(orgBook, 'unknown', 'acme/model-1'), K3, 'an org naming its own provider resolves on the full id')
    assert.equal(priceOf(orgBook, 'together', 'zzz-org/Mystery'), null, 'an org and model nothing matches price nothing')
  })

  test('tier: a provider the model id itself names wins over mirrors', () => {
    assert.deepEqual(priceOf(BOOK_B, 'any-gateway', 'kimi-k2.7-code'), KIMI, 'exactly one branch carries it')
  })

  test('an official model id prices officially even where a gateway re-lists it', () => {
    // The issue #93 shape: azure re-lists `deepseek-v4-pro` flat (no cache_read)
    // and its `@ai-sdk/azure` package is the only self-named one, so the
    // model-side tiers would hand the id to azure. The official table owns every
    // spelling it lists instead, and an id it does NOT list still falls through.
    const AZURE_FLAT = { hit: 1.74, miss: 1.74, write: 1.74, out: 3.48 }
    const hostBook = bookOf({
      deepseek: { 'deepseek-v4-pro': PRO, 'deepseek-v4-pro-0813': PRO },
      azure: { 'deepseek-v4-pro-0813': AZURE_FLAT, 'gpt-x': AZURE_FLAT },
    }, { deepseek: '@ai-sdk/openai-compatible', azure: '@ai-sdk/azure' })
    assert.deepEqual(priceOf(hostBook, 'hx', 'deepseek-v4-pro'), OFFICIAL_PRO, 'the official table owns the alias')
    assert.deepEqual(priceOf(hostBook, 'hx', 'DeepSeek-V4-Pro'), OFFICIAL_PRO, 'the match is case-insensitive')
    assert.deepEqual(priceOf(hostBook, 'hx', 'gpt-x'), AZURE_FLAT, 'a model outside the official table resolves as before')
    // An unlisted `deepseek-` spelling falls to DeepSeek's own registry branch rather
    // than the model-side tiers, which would hand it to azure.
    assert.deepEqual(priceOf(hostBook, 'hx', 'deepseek-v4-pro-0813'), PRO, 'the first-party seam still covers unlisted revisions')
    // A `deepseek-` id the first-party branch does not list falls through to the model-side index.
    const sparse = bookOf({ deepseek: { 'other-model': PRO }, azure: { 'deepseek-v4-x': AZURE_FLAT } }, { azure: '@ai-sdk/azure' })
    assert.deepEqual(priceOf(sparse, 'hx', 'deepseek-v4-x'), AZURE_FLAT, 'an unlisted id leaves the first-party seam')
    const noFirstParty = bookOf({ azure: { 'deepseek-v4-x': AZURE_FLAT } }, { azure: '@ai-sdk/azure' })
    assert.deepEqual(priceOf(noFirstParty, 'hx', 'deepseek-v4-x'), AZURE_FLAT, 'no first-party branch leaves the tiers in charge')
  })

  test('tier: a lone carrier prices without any vendor signal', () => {
    const lone = bookOf({ solo: { 'weird-model-9': K3 } })
    assert.deepEqual(priceOf(lone, 'unknown', 'weird-model-9'), K3)
  })

  test('disagreeing candidates price nothing unless a majority agrees', () => {
    const disagree = bookOf({
      a: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      b: { 'x': { hit: 2, miss: 2, write: 2, out: 2 } },
    }, { a: '@ai-sdk/a', b: '@ai-sdk/b' })
    assert.equal(priceOf(disagree, '', 'x'), null, 'two disagreeing vendors refuse')
    const majority = bookOf({
      a: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      b: { 'x': { hit: 2, miss: 2, write: 2, out: 2 } },
      c: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
      d: { 'x': { hit: 1, miss: 1, write: 1, out: 1 } },
    }, { a: '@ai-sdk/a', b: '@ai-sdk/b', c: '@ai-sdk/c', d: '@ai-sdk/d' })
    assert.equal(priceOf(majority, '', 'x')?.hit, 1, 'the agreeing majority carries the rate')
  })

  test('float noise in registry sync counts as agreement', () => {
    const noisy = bookOf({
      a: { 'x': { hit: 0.125, miss: 1, write: 1, out: 2 } },
      b: { 'x': { hit: 0.12500000000000003, miss: 1, write: 1, out: 2 } },
    }, { a: '@ai-sdk/a', b: '@ai-sdk/b' })
    assert.equal(priceOf(noisy, '', 'x')?.hit, 0.125)
  })

  test('registry ids are matched case-insensitively', () => {
    assert.deepEqual(priceOf(VENDOR_B, 'claude', 'Claude-Sonnet-5'), ANTHROPIC_RATE)
  })

  test('an org-prefixed dialect falls back to its bare last segment', () => {
    assert.deepEqual(priceOf(VENDOR_B, 'together', 'openai/gpt-oss-120b'), KIMI, 'the bare id resolves once the unknown org is stripped')
    assert.deepEqual(priceOf(VENDOR_B, 'unknown', 'ZZZ/Gpt-Oss-120B'), KIMI, 'the segment lookup is case-insensitive too')
  })

  test('hostile branches and rate entries are skipped at index build', () => {
    const hostile = bookOf({
      junk: ['nope'],
      broken: { 'x': 'nope' },
      good: { 'x': KIMI },
    } as unknown as ModelPrices, { junk: 7 as unknown as string, broken: undefined as unknown as string })
    assert.deepEqual(priceOf(hostile, '', 'x'), KIMI)
    assert.equal(priceOf(hostile, '', 'y'), null)
  })

  test('a non-record branch is refused whole; identical re-pushes dedup', () => {
    const R1 = { hit: 1, miss: 1, write: 1, out: 1 }
    const index = priceIndexOf({ junk: 5, a: { 'x-y': R1, 'z-y': R1 }, b: { 'x': { hit: 1 } } } as unknown as ModelPrices, {})
    assert.equal([...index.byModel.get('y') ?? []].length, 1, 'same provider at the same rate lists once')
    assert.equal(index.byModel.get('junk'), undefined)
    assert.equal(index.byModel.get('x'), undefined, 'the partial rate entry dropped')
  })

  test('a tier whose candidates disagree falls through to the next tier', () => {
    const R1 = { hit: 1, miss: 1, write: 1, out: 1 }
    const R2 = { hit: 2, miss: 2, write: 2, out: 2 }
    const org = bookOf({
      xx: { 'm': R1 },
      'xx-ai': { 'm': R2 },
    }, { xx: '@ai-sdk/openai-compatible', 'xx-ai': '@ai-sdk/openai-compatible' })
    assert.equal(priceOf(org, '', 'xx-ai/m'), null, 'org tier ties and nothing below resolves')
    const prefix = bookOf({
      x: { 'x-y-z': R1 },
      'x-y': { 'x-y-z': R2 },
    })
    assert.equal(priceOf(prefix, '', 'x-y-z'), null, 'prefix tier ties and nothing below resolves')
    const agree = bookOf({
      x: { 'x-y-z': R1 },
      'x-y': { 'x-y-z': R1 },
    })
    assert.deepEqual(priceOf(agree, '', 'x-y-z'), R1, 'a unanimous prefix tier carries the rate')
  })
})

describe('billedTokensOf (the token face of the billed buckets)', () => {
  test('null and empty usages total zero', () => {
    assert.equal(billedTokensOf(null), 0)
    assert.equal(billedTokensOf(undefined), 0)
    assert.equal(billedTokensOf({}), 0)
  })

  test('sums every bucket across providers, models, and periods', () => {
    const usage: SessionCostUsage = {
      p1: {
        m1: { peak: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }, off: { uncached: 10, cacheRead: 20, cacheWrite: 30, output: 40 } },
        m2: { peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } },
      },
      p2: { m3: { off: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 1000 } } },
    }
    assert.equal(billedTokensOf(usage), 1 + 2 + 3 + 4 + 10 + 20 + 30 + 40 + 100 + 1000)
  })

  test('hostile branches skip, the estimator’s own resilience', () => {
    const usage = {
      junk: 5,
      p: { m: 'garbage', m2: { peak: null, off: { uncached: 'x', cacheRead: 7 } } },
    } as unknown as SessionCostUsage
    // The non-record provider/model/period branches drop whole; the junk
    // bucket field coerces to zero (numOf), the number survives.
    assert.equal(billedTokensOf(usage), 7)
  })
})

describe('estimateSessionCost', () => {  test('null usage or null book prices to null', () => {
    assert.equal(estimateSessionCost(null, BOOK_B, 'usd'), null)
    assert.equal(estimateSessionCost(undefined, BOOK_B, 'cny'), null)
    assert.equal(estimateSessionCost({}, null, 'usd'), null)
  })

  test('usage without any priced bucket returns null', () => {
    assert.equal(estimateSessionCost({}, BOOK_B, 'usd'), null)
    assert.equal(estimateSessionCost({ 'deepseek-official': { unknown: { peak: bucket(0, M, 0, 0) } } }, BOOK_B, 'usd'), null)
  })

  test('a provider id the registry does not know still prices by model id', () => {
    // The issue #91 shape: a subscription/proxy route (`claude`, a gateway)
    // whose models live under the vendor's registry branch. Here the model is an
    // official one, so the official table prices it AND doubles its peak bucket.
    close(estimateSessionCost({ unmapped: { 'kimi-k2.7-code': { peak: bucket(0, M, 0, 0) } } }, BOOK_B, 'usd'), 0.95)
    close(estimateSessionCost({ unmapped: { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }, BOOK_B, 'usd'), 0.3)
  })

  test('prices every period bucket at its own rate (hit / miss / write / out)', () => {
    const usage = {
      'deepseek-official': {
        'deepseek-v4-flash': { off: bucket(M, M, M, M) },
        'deepseek-v4-pro': { off: bucket(M, M, M, M) },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, M) } },
    }
    // Both official rows price from the CNY table (Pro's list differs from models.dev's);
    // kimi prices from the book with a flat-rate provider's peak bucket undoubled.
    close(estimateSessionCost(usage, BOOK_B, 'usd'),
      (OFFICIAL_FLASH.hit + OFFICIAL_FLASH.miss + OFFICIAL_FLASH.write + OFFICIAL_FLASH.out)
      + (OFFICIAL_PRO.hit + OFFICIAL_PRO.miss + OFFICIAL_PRO.write + OFFICIAL_PRO.out)
      + 0.95 + 4)
  })

  test('peak buckets price at twice the book rate for DeepSeek only', () => {
    const split = { peak: bucket(0, M, 0, 0), off: bucket(0, M, 0, 0) }
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': split } }, BOOK_B, 'usd'), 0.3 + 0.15)
    close(
      estimateSessionCost({ 'kimi-coding': { 'kimi-k2.7-code': split } }, BOOK_B, 'usd'),
      0.95 + 0.95,
      'a flat-rate provider bills a peak bucket at book price, never doubled',
    )
    // The account route shares DeepSeek's period list, so its peak buckets
    // double too — the fold splits them only since providers.ts maps it.
    close(estimateSessionCost({ 'deepseek-account': { 'deepseek-v4-flash': split } }, BOOK_B, 'usd'), 0.3 + 0.15)
  })

  test('an official model doubles under a third-party route, keyed by model not provider', () => {
    // The workbuddy shape: a proxy route the registry does not own, carrying an
    // official DeepSeek model id. The official table prices it either way, so its
    // peak bucket must double there too — a provider-keyed rule would leave the
    // peak window charged at the off-peak rate.
    const split = { peak: bucket(0, M, 0, 0), off: bucket(0, M, 0, 0) }
    close(estimateSessionCost({ workbuddy: { 'deepseek-v4.1-flash': split } }, BOOK_B, 'usd'), 0.3 + 0.15)
    // A model the official table does not carry keeps the flat peak bucket.
    close(
      estimateSessionCost({ workbuddy: { 'kimi-k2.7-code': { peak: bucket(0, M, 0, 0) } } }, BOOK_B, 'usd'),
      0.95,
      'a proxy route carrying a non-official model still bills its peak bucket flat',
    )
  })

  test('a missing model is skipped while priced ones still sum', () => {
    const usage = { 'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK_B, 'usd'), 0.95)
  })

  test('the CNY currency converts the USD total at 1 CNY = 0.15 USD', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }
    // 1M peak-window miss bills the official CNY peak price: ¥2.
    close(estimateSessionCost(usage, BOOK_B, 'cny'), 2)
  })

  test('non-number bucket fields are coerced to zero by numOf', () => {
    const garbage = { cacheRead: NaN, uncached: 'x', cacheWrite: undefined, output: Infinity } as unknown as CostBucketTotals
    assert.equal(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: garbage } } }, BOOK_B, 'usd'), 0)
  })

  test('garbage fields degrade while real fields still price', () => {
    const mixed = { cacheRead: M, uncached: NaN, cacheWrite: M / 2, output: 'junk' } as unknown as CostBucketTotals
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: mixed } } }, BOOK_B, 'usd'), 2 * (0.003 + 0.5 * 0.15))
  })

  test('hostile provider branches, periods, and buckets are skipped, not fatal', () => {
    const usage = {
      junk: 'x',
      'kimi-coding': { broken: null, 'kimi-k2.7-code': { peak: 'junk', off: bucket(0, M, 0, 0) } },
      'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } },
    } as unknown as { [provider: string]: Record<string, Record<string, CostBucketTotals>> }
    close(estimateSessionCost(usage, BOOK_B, 'usd'), 0.3 + 0.95)
  })
})

describe('mergeCostUsage', () => {
  test('sums every bucket across usages, keyed by provider, model, and period', () => {
    const merged = mergeCostUsage(
      { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } },
      {
        'deepseek-official': {
          'deepseek-v4-flash': { peak: bucket(2 * M, 0, 0, 0), off: bucket(0, M, 0, 0) },
          'deepseek-v4-pro': { peak: bucket(0, 0, 0, M) },
        },
        'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, 3 * M, 0, 0) } },
      },
    )
    assert.deepEqual(merged, {
      'deepseek-official': {
        'deepseek-v4-flash': { peak: bucket(3 * M, 0, 0, 0), off: bucket(0, M, 0, 0) },
        'deepseek-v4-pro': { peak: bucket(0, 0, 0, M) },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, 3 * M, 0, 0) } },
    })
  })

  test('the merged estimate equals the sum of the sides priced apart', () => {
    const a = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, M, 0, 0) } } }
    const b = { 'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, 2 * M, 0, 0) } } }
    const total = estimateSessionCost(mergeCostUsage(a, b), BOOK_B, 'usd')
    close(total ?? 0, (estimateSessionCost(a, BOOK_B, 'usd') ?? 0) + (estimateSessionCost(b, BOOK_B, 'usd') ?? 0))
  })

  test('null and absent sides drop out; nothing usable merges to null', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } }
    assert.deepEqual(mergeCostUsage(null, usage, undefined), usage)
    assert.equal(mergeCostUsage(null, undefined, null), null)
    assert.equal(mergeCostUsage(), null)
  })

  test('a bucket that merged with only zeros still counts (the estimator prices $0, not a dash)', () => {
    const zero = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, 0, 0, 0) } } }
    assert.deepEqual(mergeCostUsage(zero), zero)
    assert.equal(estimateSessionCost(mergeCostUsage(zero), BOOK_B, 'usd'), 0)
  })

  test('hostile branches are skipped, not fatal, and the inputs never mutate', () => {
    const a = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } }
    const hostile = {
      junk: 5,
      arr: [{ peak: bucket(M, 0, 0, 0) }],
      'kimi-coding': { broken: null, 'kimi-k2.7-code': { peak: 'junk', off: bucket(0, M, 0, 0) } },
    } as unknown as Record<string, never>
    const merged = mergeCostUsage(a, hostile)
    assert.deepEqual(merged, {
      'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } },
      'kimi-coding': { 'kimi-k2.7-code': { off: bucket(0, M, 0, 0) } },
    })
    assert.deepEqual(a, { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(M, 0, 0, 0) } } }, 'the source usage stays untouched')
  })
})

describe('priceFaceOf', () => {
  test('names the listing face every resolution path lands on', () => {
    // The official table owns every model id it lists, under its own display label.
    assert.deepEqual(priceFaceOf(BOOK_B, 'deepseek-official', 'deepseek-v4-flash'), { pid: 'deepseek', mid: 'DeepSeek-V4.1-Flash', rate: OFFICIAL_FLASH, official: true })
    assert.deepEqual(priceFaceOf(BOOK_B, 'future-gateway', 'deepseek-v4-pro'), { pid: 'deepseek', mid: 'DeepSeek-V4-Pro', rate: OFFICIAL_PRO, official: true }, 'a gateway spelling still prices officially')
    // Everything else names the registry face the winning tier landed on.
    assert.deepEqual(priceFaceOf(BOOK_B, 'kimi-coding', 'k3'), { pid: 'moonshotai', mid: 'kimi-k3', rate: K3 }, 'the suffix path names the full registry spelling')
    assert.deepEqual(priceFaceOf(BOOK_B, 'any-gateway', 'kimi-k2.7-code'), { pid: 'moonshotai', mid: 'kimi-k2.7-code', rate: KIMI })
    assert.equal(priceFaceOf(BOOK_B, '', 'mystery'), null)
    // The official table needs no book; a model it does not carry still does.
    assert.deepEqual(priceFaceOf(null, 'deepseek-official', 'deepseek-v4-flash'), { pid: 'deepseek', mid: 'DeepSeek-V4.1-Flash', rate: OFFICIAL_FLASH, official: true })
    assert.equal(priceFaceOf(null, 'kimi-coding', 'kimi-k2.7-code'), null)
  })
})

describe('formatCost', () => {
  test('amounts of at least 1 use fixed two-decimal notation', () => {
    assert.equal(formatCost(3.456, 'usd'), '$3.46')
    assert.equal(formatCost(1, 'usd'), '$1.00')
  })

  test('amounts below 1 use two-significant-digit precision', () => {
    assert.equal(formatCost(0.014, 'usd'), '$0.014')
    assert.equal(formatCost(0.5, 'usd'), '$0.50')
  })

  test('the CNY currency uses the yen symbol', () => {
    assert.equal(formatCost(12.3, 'cny'), '¥12.30')
    assert.equal(formatCost(0.66, 'cny'), '¥0.66')
  })
})

describe('formatPriceRate', () => {
  test('always renders two decimals in the currency symbol', () => {
    assert.equal(formatPriceRate(3, 'cny'), '¥3.00')
    assert.equal(formatPriceRate(4.5, 'cny'), '¥4.50')
    assert.equal(formatPriceRate(0.007, 'usd'), '$0.01')
    assert.equal(formatPriceRate(0.1, 'usd'), '$0.10')
  })
})

describe('estimateSessionCostByBucket', () => {
  test('the four buckets sum to the total, and to the period split, in one pass', () => {
    // A mixed ledger: an official model across both windows, plus a book-priced one.
    const usage: SessionCostUsage = {
      'deepseek-official': {
        'deepseek-v4-flash': {
          peak: bucket(M, M, 0, M),
          off: bucket(0, M, M, 0),
        },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, 0) } },
    }
    const split = estimateSessionCostByBucket(usage, BOOK_B)
    const byBucket = split.cacheRead + split.uncached + split.cacheWrite + split.output
    assert.ok(Math.abs(byBucket - split.total) < 1e-12, 'the bucket split adds up to the total')
    assert.ok(Math.abs(split.peak + split.off - split.total) < 1e-12, 'so does the period split')
    // The two splits are views of one ledger: the period figures come from the
    // same accumulation the bucket figures do.
    const byPeriod = estimateSessionCostByPeriod(usage, BOOK_B)
    assert.equal(split.peak, byPeriod.peak)
    assert.equal(split.off, byPeriod.off)
    assert.equal(split.any, byPeriod.any)
  })

  test('each bucket keeps its own rate rather than a blended one', () => {
    // Official flash off-peak: hit 0.003, miss 0.15, out 0.6 per 1M.
    const usage: SessionCostUsage = {
      'deepseek-official': { 'deepseek-v4-flash': { off: bucket(M, M, M, M) } },
    }
    const split = estimateSessionCostByBucket(usage, BOOK_B)
    close(split.cacheRead, 0.003)
    close(split.uncached, 0.15)
    // Cache writes are not billed separately: they price at the cache-miss rate.
    close(split.cacheWrite, 0.15)
    close(split.output, 0.6)
    close(split.total, 0.903)
  })

  test('the peak bucket doubles every bucket inside it, not just the total', () => {
    const off = bucket(M, M, M, M)
    // Official flash: the peak window doubles all four buckets, so the ring's
    // slices stay proportional to the off-peak ones.
    const officialOff = estimateSessionCostByBucket({ 'deepseek-official': { 'deepseek-v4-flash': { off } } }, BOOK_B)
    const officialPeak = estimateSessionCostByBucket({ 'deepseek-official': { 'deepseek-v4-flash': { peak: off } } }, BOOK_B)
    close(officialPeak.cacheRead, officialOff.cacheRead * 2)
    close(officialPeak.uncached, officialOff.uncached * 2)
    close(officialPeak.cacheWrite, officialOff.cacheWrite * 2)
    close(officialPeak.output, officialOff.output * 2)
    close(officialPeak.total, officialOff.total * 2)
    // A flat-rate provider never doubles: its peak bucket is ordinary list price.
    const kimiOff = estimateSessionCostByBucket({ 'kimi-coding': { 'kimi-k2.7-code': { off: bucket(0, M, 0, 0) } } }, BOOK_B)
    const kimiPeak = estimateSessionCostByBucket({ 'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, 0) } } }, BOOK_B)
    close(kimiPeak.total, 0.95)
    close(kimiOff.total, 0.95, 'a flat-rate provider bills both windows at book price')
  })

  test('no usage at all reports nothing rather than zero', () => {
    for (const usage of [null, undefined, {} as SessionCostUsage]) {
      const split = estimateSessionCostByBucket(usage, BOOK_B)
      assert.equal(split.any, false)
      assert.equal(split.total, 0)
      assert.equal(split.peak, 0)
      assert.equal(split.off, 0)
    }
  })
})

describe('moneyOnlyUsage — credits are not money', () => {
  const CREDIT = { workbuddy: { 'deepseek-v4.1-flash': 0.11 }, 'workbuddy-ai': { 'deepseek-v4.1-flash': 0 } }
  const LEDGER = {
    workbuddy: { 'deepseek-v4.1-flash': { peak: { uncached: M, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    'deepseek-account': { 'deepseek-v4-flash': { off: { uncached: M, cacheRead: 0, cacheWrite: 0, output: 0 } } },
  }

  test('a credits-only ledger has nothing to price as money', () => {
    // The regression this guards: the overview priced the whole family ledger, so a
    // workbuddy-only session showed a yuan figure (1M peak tokens -> ¥2.00) derived
    // from the official table, because that model id is listed there.
    assert.equal(moneyOnlyUsage({ workbuddy: LEDGER.workbuddy }, CREDIT), null)
  })

  test('a mixed ledger keeps only the currency platform', () => {
    const money = moneyOnlyUsage(LEDGER, CREDIT)
    assert.deepEqual(Object.keys(money ?? {}), ['deepseek-account'])
  })

  test('no credit table at all leaves the ledger alone', () => {
    // Without the credit rates we cannot tell a credit platform apart, and guessing
    // would be worse than pricing what the table covers.
    const money = moneyOnlyUsage(LEDGER, null)
    assert.deepEqual(Object.keys(money ?? {}).sort(), ['deepseek-account', 'workbuddy'])
  })

  test('a provider with one credit model is entirely credits', () => {
    // A platform's plan is uniform: a missing rate for one model must not turn the
    // other half of that platform's numbers into currency.
    const partial = { workbuddy: { 'glm-5.3': 0.5 } }
    const usage = { workbuddy: { 'glm-5.3': LEDGER.workbuddy['deepseek-v4.1-flash'], other: LEDGER.workbuddy['deepseek-v4.1-flash'] } }
    assert.equal(moneyOnlyUsage(usage, partial), null)
  })

  test('an empty ledger stays null rather than becoming an empty object', () => {
    assert.equal(moneyOnlyUsage({}, CREDIT), null)
    assert.equal(moneyOnlyUsage(null, CREDIT), null)
  })
})
