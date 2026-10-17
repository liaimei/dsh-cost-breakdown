/**
 * Money maths. The host writes billed tokens; every number with a currency symbol is computed
 * here, and only here.
 *
 * Two invariants drive the design:
 *
 * 1. **USD is the accounting unit.** The official CNY table is converted at one fixed rate that
 *    never updates, so a number cannot drift between two renders of the same session. Display
 *    currency is a formatting decision, applied last.
 * 2. **"Cannot be priced" is not "free".** Every estimator here returns `null` when no rate applies,
 *    and callers render a dash or an explicit "unconfigured" label. Returning `0` would claim the
 *    calls cost nothing.
 */

import type { BucketTotals, CallLedger, CostLedger, RateQuad } from '../../wire/model'
import { findOfficialModel, OFFICIAL_TABLE } from '../../core/clock'
import { pricedByPeriod, vendorOf } from '../../core/providers'
import { billedTokensOf } from '../../core/ledger'
import { configuredRateOf, type ThirdPartyRates } from './thirdPartyRates'

/** Display currency. The wire and all arithmetic stay in USD; only formatting converts. */
export type Currency = 'usd' | 'cny'

/** The fixed conversion the official CNY table is quoted in. Deliberately not a live rate. */
export const USD_PER_CNY = 0.15

/** The official table quotes off-peak; peak is exactly double, in every column. */
const PEAK_FACTOR = 2

/** USD → display currency. A USD figure passes through untouched so it never picks up a
 * conversion round-trip error. */
export function toCurrency(usd: number, currency: Currency): number {
  return currency === 'cny' ? usd / USD_PER_CNY : usd
}

/** Display currency → USD, for numbers **quoted in CNY** (the official table). */
export function fromCny(cny: number, currency: Currency): number {
  return currency === 'cny' ? cny : cny * USD_PER_CNY
}

/** Round to six decimals to strip binary representation noise: `4.5 * 0.15` lands on
 * `0.6749999999999999`, while the table implies at most two decimals. */
function cnyToUsd(cny: number): number {
  return Math.round(cny * USD_PER_CNY * 1e6) / 1e6
}

/** The official table as a rate quadruple in USD space, using the off-peak column (the peak
 * multiplier is applied at pricing time). Cache writes bill as misses. `null` when unlisted. */
export function officialRateOf(model: string): RateQuad | null {
  const row = findOfficialModel(model)
  if (row === null) return null
  return {
    hit: cnyToUsd(row.offPeak.hit),
    miss: cnyToUsd(row.offPeak.miss),
    write: cnyToUsd(row.offPeak.miss),
    out: cnyToUsd(row.offPeak.out),
  }
}

/** The official row's display label, or the wire id when unlisted. */
export function officialLabelOf(model: string): string {
  return findOfficialModel(model)?.label ?? model
}

// ---------------------------------------------------------------------------
// The public price registry book
// ---------------------------------------------------------------------------

/** Registry rates: provider id → model id → rate. */
export type RegistryPrices = Record<string, Record<string, RateQuad>>

/** One candidate carrier of a model: the registry provider, its spelling of the model id, the rate,
 * and whether it is the model's own vendor (`primary`). */
export interface RateCandidate { pid: string; mid: string; rate: RateQuad; primary: boolean }

/** Model-side index: lowercased model id (exact id plus every `-`-separated tail, so a registry
 * namespace like `kimi-k3` also answers `k3`) → the providers carrying it. */
export interface RateIndex { byModel: Map<string, RateCandidate[]> }

/** A resolved registry book: raw rates plus the model-side index that lets a model id find a price
 * even when its provider branch does not list it. */
export interface PriceBook { prices: RegistryPrices; index: RateIndex }

/** A resolved price: the provider/model face printed in a tooltip, and the rate actually applied.
 * `official` only changes the tooltip wording, never the arithmetic. */
export interface PriceFace { pid: string; mid: string; rate: RateQuad; official?: boolean }

function sameRate(left: RateQuad, right: RateQuad): boolean {
  // Relative tolerance, not absolute: rates span seven orders of magnitude.
  const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a))
  return close(left.hit, right.hit) && close(left.miss, right.miss)
    && close(left.write, right.write) && close(left.out, right.out)
}

function rateQuadOf(value: unknown): RateQuad | null {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
  if (record === null) return null
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  return num(record.hit) && num(record.miss) && num(record.write) && num(record.out)
    ? { hit: record.hit, miss: record.miss, write: record.write, out: record.out }
    : null
}

/** Build the model-side index over a validated book. `npmOf` carries each provider's registry npm
 * package (`null` when absent): `@ai-sdk/<its own id>` marks a first-party provider, while
 * mirrors and gateways reuse a foreign package. */
export function buildRateIndex(prices: RegistryPrices, npmOf: Record<string, string | null>): RateIndex {
  const byModel = new Map<string, RateCandidate[]>()
  const push = (key: string, candidate: RateCandidate): void => {
    const list = byModel.get(key)
    if (list === undefined) byModel.set(key, [candidate])
    else if (!list.some(entry => entry.pid === candidate.pid && sameRate(entry.rate, candidate.rate))) list.push(candidate)
  }
  for (const pid of Object.keys(prices)) {
    const branch = prices[pid]
    if (branch === null || typeof branch !== 'object') continue
    const npm: unknown = npmOf[pid]
    // "Primary" means the provider publishes under its own id (`deepseek` → `@ai-sdk/deepseek`);
    // a mirror or gateway reuses a foreign package and is never primary.
    const primary = typeof npm === 'string' && npm.startsWith('@ai-sdk/') && npm.slice('@ai-sdk/'.length) === pid
    for (const mid of Object.keys(branch)) {
      const rate = rateQuadOf(branch[mid])
      if (rate === null) continue
      const lower = mid.toLowerCase()
      const candidate: RateCandidate = { pid, mid, rate, primary }
      push(lower, candidate)
      // Every `-`-separated **tail** is indexed too: the registry namespace and the harness's short
      // name meet at that seam.
      const parts = lower.split('-')
      for (let i = 1; i < parts.length; i++) push(parts.slice(i).join('-'), candidate)
    }
  }
  return { byModel }
}

/** The candidate whose rate the most candidates share; a tie is ambiguous and yields `null`. */
function majorityCandidate(candidates: RateCandidate[]): RateCandidate | null {
  const groups: Array<{ candidate: RateCandidate; n: number }> = []
  for (const candidate of candidates) {
    const group = groups.find(entry => sameRate(entry.candidate.rate, candidate.rate))
    if (group === undefined) groups.push({ candidate, n: 1 })
    else group.n++
  }
  groups.sort((left, right) => right.n - left.n)
  return groups.length > 1 && groups[0].n === groups[1].n ? null : groups[0].candidate
}

function resolveCandidates(lower: string, candidates: RateCandidate[], org: string | null): RateCandidate | null {
  if (org !== null) {
    // A `vendor/model` id names its vendor; that may be the exact provider id or a variant org
    // whose registry id is a prefix (`deepseek-ai` → `deepseek`).
    const named = candidates.filter(entry => entry.pid === org || org.startsWith(entry.pid + '-') || (org.length >= 4 && org.startsWith(entry.pid)))
    if (named.length > 0) {
      const candidate = majorityCandidate(named)
      if (candidate !== null) return candidate
    }
  }
  const primaries = candidates.filter(entry => entry.primary)
  if (primaries.length > 0) {
    const candidate = majorityCandidate(primaries)
    if (candidate !== null) return candidate
  }
  const prefixed = candidates.filter(entry => lower.startsWith(entry.pid + '-') || lower.startsWith(entry.pid + '/'))
  if (prefixed.length > 0) {
    const candidate = majorityCandidate(prefixed)
    if (candidate !== null) return candidate
  }
  return candidates.length === 1 ? candidates[0] : null
}

/** Resolve one model id across the whole book: try the full id, then the segment after the last
 * `/`. */
function resolveIndexed(index: RateIndex, model: string): RateCandidate | null {
  const lower = model.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const org = slash > 0 ? lower.slice(0, slash) : null
  for (const key of slash > 0 ? [lower, lower.slice(slash + 1)] : [lower]) {
    const candidates = index.byModel.get(key)
    if (candidates === undefined) continue
    const candidate = resolveCandidates(key, candidates, org)
    if (candidate !== null) return candidate
  }
  return null
}

/** Look one model up inside a provider branch: exact key first (the book is untrusted wire data),
 * then case-insensitively, then by `-`-suffix. Ambiguous suffixes decline to price. */
function lookupInBranch(models: Record<string, RateQuad>, model: string): { mid: string; rate: RateQuad } | null {
  if (Object.hasOwn(models, model)) return { mid: model, rate: models[model] }
  const needle = model.toLowerCase()
  let found: { mid: string; rate: RateQuad } | null = null
  let seen: string | null = null
  for (const id of Object.keys(models)) {
    const lower = id.toLowerCase()
    if (lower !== needle && !lower.endsWith('-' + needle)) continue
    if (seen !== null && seen !== lower) return null
    seen = lower
    found = { mid: id, rate: models[id] }
  }
  return found
}

/**
 * The price face of one billable model.
 *
 * Precedence, and why:
 *  1. **The official table, for every model it lists**, whatever the provider id is. That table is
 *     the reason this plugin exists, and it is authoritative over a third-party mirror's price for
 *     the same model.
 *  2. **A user-declared platform rate.** The public registry lists one model from dozens of vendors
 *     at prices that differ by an order of magnitude, and the platform a user actually pays is
 *     usually absent from it; the user knows their plan, the plugin cannot.
 *  3. **The mapped registry branch.** A listed provider's own branch is terminal: an unknown model
 *     there prices as `null` rather than falling through to a namesake.
 *  4. **The `deepseek-` first-party seam.** An unlisted `deepseek-*` model prices from DeepSeek's own
 *     branch, because that branch carries real cache rates while the model-side tier might hand the
 *     id to a host that bills cache hits as ordinary input.
 *  5. **The model-side index.**
 */
export function priceFaceOf(
  book: PriceBook | null | undefined,
  provider: string,
  model: string,
  rates?: ThirdPartyRates | null,
): PriceFace | null {
  const official = officialRateOf(model)
  if (official !== null) return { pid: 'deepseek', mid: officialLabelOf(model), rate: official, official: true }
  const configured = configuredRateOf(rates, provider, model)
  if (configured !== null) return { pid: provider, mid: model, rate: configured }
  if (book === null || book === undefined) return null
  const registryProvider = vendorOf(provider)
  const direct = book.prices[registryProvider]
  if (direct !== null && direct !== undefined && typeof direct === 'object') {
    const found = lookupInBranch(direct, model)
    return found === null ? null : { pid: registryProvider, mid: found.mid, rate: found.rate }
  }
  if (model.toLowerCase().startsWith('deepseek-')) {
    const firstParty = book.prices.deepseek
    if (firstParty !== null && firstParty !== undefined) {
      const found = lookupInBranch(firstParty, model)
      if (found !== null) return { pid: 'deepseek', mid: found.mid, rate: found.rate }
    }
  }
  const candidate = resolveIndexed(book.index, model)
  return candidate === null ? null : { pid: candidate.pid, mid: candidate.mid, rate: candidate.rate }
}

/** The rate alone; callers that need the registry face (a model tooltip) use `priceFaceOf`, and both
 * must agree on which row prices. */
export function rateOf(
  book: PriceBook | null | undefined,
  provider: string,
  model: string,
  rates?: ThirdPartyRates | null,
): RateQuad | null {
  return priceFaceOf(book, provider, model, rates)?.rate ?? null
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/** Cost split by billing period, plus whether anything was priced at all. */
export interface CostByPeriod { peak: number; off: number; any: boolean }

/** Cost split by billed bucket as well as by period. `total` equals the four buckets summed and also
 * equals `peak + off`, because all three come out of one accumulation. */
export interface CostByBucket extends CostByPeriod {
  cacheRead: number
  uncached: number
  cacheWrite: number
  output: number
  total: number
}

/** Price one ledger, producing **both** splits (which token the money went to, and which period it
 * went to) from a single pass, so two cards can never disagree. */
export function estimateByBucket(
  usage: CostLedger | null | undefined,
  book: PriceBook | null | undefined,
  rates?: ThirdPartyRates | null,
): CostByBucket {
  const out: CostByBucket = {
    cacheRead: 0, uncached: 0, cacheWrite: 0, output: 0, total: 0, peak: 0, off: 0, any: false,
  }
  if (usage === null || usage === undefined) return out
  for (const provider of Object.keys(usage)) {
    const models = usage[provider]
    if (models === null || typeof models !== 'object') continue
    for (const model of Object.keys(models)) {
      const official = officialRateOf(model)
      const rate = official ?? rateOf(book, provider, model, rates)
      const periods = models[model]
      if (rate === null || periods === null || typeof periods !== 'object') continue
      // Bucket labels follow the **host's** booking rule: only settlements billed by the official
      // windows carry a doubled peak bucket. Every other provider's `peak` bucket is its face rate.
      const doubles = pricedByPeriod(provider, model)
      for (const period of ['peak', 'off'] as const) {
        const bucket: BucketTotals | undefined = periods[period]
        if (bucket === undefined || bucket === null || typeof bucket !== 'object') continue
        // The multiplier applies to the whole segment, so it scales every bucket too: the bucket
        // split and the period split stay exactly consistent.
        const scale = (doubles && period === 'peak' ? PEAK_FACTOR : 1) / 1e6
        const hit = num(bucket.cacheRead) * rate.hit * scale
        const miss = num(bucket.uncached) * rate.miss * scale
        const write = num(bucket.cacheWrite) * rate.write * scale
        const generated = num(bucket.output) * rate.out * scale
        out.cacheRead += hit
        out.uncached += miss
        out.cacheWrite += write
        out.output += generated
        out[period] += hit + miss + write + generated
        out.any = true
      }
    }
  }
  out.total = out.cacheRead + out.uncached + out.cacheWrite + out.output
  return out
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Price a ledger split by period only, from the same single pass. */
export function estimateByPeriod(
  usage: CostLedger | null | undefined,
  book: PriceBook | null | undefined,
  rates?: ThirdPartyRates | null,
): CostByPeriod {
  const { peak, off, any } = estimateByBucket(usage, book, rates)
  return { peak, off, any }
}

/**
 * The session's estimated total, or `null` when nothing could be priced — the caller then shows a
 * dash instead of a zero.
 *
 * Official-table models price in both periods even when the registry book never loaded, which is why
 * DeepSeek cost is always available.
 */
export function estimateSessionCost(
  usage: CostLedger | null | undefined,
  book: PriceBook | null | undefined,
  currency: Currency,
): number | null {
  const { peak, off, any } = estimateByPeriod(usage, book)
  return any ? toCurrency(peak + off, currency) : null
}

/** Billed prompt+output tokens (cache read/write included), independent of whether a rate exists.
 * This is what the token badge and the dock counter show. */
export function billedTokens(usage: CostLedger | null | undefined): number {
  if (usage === null || usage === undefined) return 0
  let total = 0
  for (const models of Object.values(usage)) {
    if (models === null || typeof models !== 'object') continue
    for (const entry of Object.values(models)) {
      if (entry === null || typeof entry !== 'object') continue
      if (entry.peak !== undefined) total += billedTokensOf(entry.peak)
      if (entry.off !== undefined) total += billedTokensOf(entry.off)
    }
  }
  return total
}

/** Merge several ledgers into one. `null` when nothing carried a bucket — which stays distinct from
 * "merged to zero". */
export function mergeLedgers(...ledgers: Array<CostLedger | null | undefined>): CostLedger | null {
  const out: CostLedger = {}
  let any = false
  for (const ledger of ledgers) {
    if (ledger === null || ledger === undefined) continue
    for (const provider of Object.keys(ledger)) {
      const models = ledger[provider]
      if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
      const branch = out[provider] ?? (out[provider] = {})
      for (const model of Object.keys(models)) {
        const periods = models[model]
        if (periods === null || typeof periods !== 'object' || Array.isArray(periods)) continue
        const target = branch[model] ?? (branch[model] = {})
        for (const period of ['peak', 'off'] as const) {
          const bucket = periods[period]
          if (bucket === null || bucket === undefined || typeof bucket !== 'object') continue
          const previous = target[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
          target[period] = {
            uncached: previous.uncached + num(bucket.uncached),
            cacheRead: previous.cacheRead + num(bucket.cacheRead),
            cacheWrite: previous.cacheWrite + num(bucket.cacheWrite),
            output: previous.output + num(bucket.output),
          }
          any = true
        }
      }
    }
  }
  return any ? out : null
}

/** Merge call ledgers. */
export function mergeCalls(...ledgers: Array<CallLedger | null | undefined>): CallLedger | null {
  const out: CallLedger = {}
  let any = false
  for (const ledger of ledgers) {
    if (ledger === null || ledger === undefined) continue
    for (const provider of Object.keys(ledger)) {
      const models = ledger[provider]
      if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
      const branch = out[provider] ?? (out[provider] = {})
      for (const model of Object.keys(models)) {
        branch[model] = (branch[model] ?? 0) + num(models[model])
        any = true
      }
    }
  }
  return any ? out : null
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** The currency symbol: `CNY → ¥`, `USD → $`, anything else `CODE + space`. */
export function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return `${currency} `
}

/** Format an amount with its symbol. Below 1 keeps two significant digits (so a fraction of a cent
 * does not read as `0.00`); above 1 keeps two decimals. No locale grouping: the value is a cost, not
 * a quantity. */
export function formatCost(amount: number, currency: Currency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  const value = amount < 1 ? trimPrecision(amount) : amount.toFixed(2)
  return `${symbol}${value}`
}

function trimPrecision(amount: number): string {
  const text = amount.toPrecision(2)
  return /e/i.test(text) ? amount.toFixed(4) : text
}

/** Format a quoted rate: always two decimals. */
export function formatRate(amount: number, currency: Currency): string {
  return `${currency === 'cny' ? '¥' : '$'}${amount.toFixed(2)}`
}

/** A platform's own billing currency code. */
export type SpendCurrency = 'CNY' | 'USD'

/** Render an amount in a **platform's own** billing currency, independent of the UI language: a
 * DeepSeek balance is always ¥ and a third-party balance always $, whatever the interface says. */
export function formatNativeSpend(usd: number, currency: SpendCurrency): string {
  return `${symbolOf(currency)}${(currency === 'CNY' ? toCurrency(usd, 'cny') : usd).toFixed(2)}`
}

/** Format a credit count: trim trailing zeros so an exact `0.1` does not print `0.10`. */
export function formatCredits(value: number): string {
  const fixed = value.toFixed(2)
  return fixed.replace(/\.?0+$/, '') || '0'
}

/** Drop every provider that bills per request (credits) from a ledger, so a money total never adds a
 * credit count to a currency. A provider is uniform: any credit model drops the whole provider. */
export function moneyOnly(
  usage: CostLedger | null | undefined,
  creditRates: Record<string, Record<string, number>> | null | undefined,
): CostLedger | null {
  if (usage === null || usage === undefined) return null
  if (creditRates === null || creditRates === undefined) return usage
  const out: CostLedger = {}
  let any = false
  for (const [provider, models] of Object.entries(usage)) {
    const creditModels = creditRates[provider]
    if (creditModels !== undefined && Object.keys(creditModels).length > 0) continue
    out[provider] = models
    any = true
  }
  return any ? out : null
}

/** Every official model row, for the dock's rate table. */
export function officialRows(): typeof OFFICIAL_TABLE {
  return OFFICIAL_TABLE
}
