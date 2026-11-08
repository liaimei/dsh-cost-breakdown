/**
 * Per-platform spend: what one session (or a group of sessions) spent on **each** platform, and how
 * many calls that took.
 *
 * Why the split is mandatory: platforms bill in different units. DeepSeek bills CNY per token (with
 * peak/off-peak windows) while a credit platform bills per request. Adding them into one number
 * would be adding two currencies together — the result means nothing. So this module emits one row
 * per platform, each carrying **its own** unit.
 *
 * Which path a platform takes is decided in one place (`isCreditBilled`), shared with the per-turn
 * readout and the summary cards, so the three surfaces cannot disagree about the same platform.
 */

import type { CallLedger, CostLedger } from '../../wire/model'
import { creditRateOf } from '../../core/credits'
import { isDeepSeekRoute } from '../../core/providers'
import {
  amortisedFeeOf, monthlyShareOf, planFamilyOf, planUsageOf, tierAt, type PlanFamily, type PlanTier,
} from '../../core/plans'
import { estimateByBucket, toCurrency, type PriceBook, type SpendCurrency } from './cost'
import { noteRelayRoute } from './relayPrices'
import type { ThirdPartyRates } from './thirdPartyRates'

/** A subscription plan's share of one platform's ledger. Present only on a plan-billed row: the
 * numbers describe *quota consumed*, which is not money and must never be summed with a bill. */
export interface PlanSpend {
  /** The vendor family (智谱 GLM Coding Plan / MiniMax M Plan / Kimi Code Plan). */
  family: PlanFamily
  /** The tier in force, from the preference; `null` when the family has no tier rows. */
  tier: PlanTier | null
  /** Credits consumed (the plan's own unit); `0` when the family does not meter credits. */
  credits: number
  /** Fraction of one month's quota this usage consumed; `null` when the quota is unpublished. */
  share: number | null
  /** The amortised part of the monthly fee this usage consumed, in CNY; `null` when unpublished. */
  feeCny: number | null
  /** Per-model credits, `null` for a model the plan has no coefficients for. */
  byModel: Array<{ model: string; credits: number | null }>
}

/** One platform's spend detail. */
export interface PlatformSpend {
  /** Display name: the ledger's provider key, which is the platform's factual identity. */
  provider: string
  /** `money` bills per token in a currency; `credits` bills per request; `plan` is a subscription
   * whose marginal cost is zero and whose real figure is quota consumed. */
  unit: 'money' | 'credits' | 'plan'
  /** The subscription detail, present exactly when `unit === 'plan'`. */
  plan?: PlanSpend
  /** Billing currency for money platforms; absent for credits (credits have no currency). */
  currency?: SpendCurrency
  /** The value (USD for money, credits for credit platforms). */
  value: number
  /** Request count; for per-request platforms this is the multiplier's basis. */
  calls: number
  /** Model ids seen on this platform, sorted. */
  models: string[]
  /** Per-model spend (USD or credits) — the donut segments. Only priceable models appear, and the
   * key set deliberately differs from `models`. */
  byModel?: Record<string, number>
  /** Per-model call counts, from the same source as `byModel`. */
  callsByModel?: Record<string, number>
  /** A plan row only: what the same ledger would cost at the platform's metered list rate, in CNY.
   * This is the comparison figure — it is *not* a bill the user receives. `null` when the list rate
   * cannot price these models. */
  planMetered?: number | null
}

/** One row of the per-model table inside a platform card.
 *
 * `value === null` means the model **cannot be priced**, which is not the same as "free". The detail
 * view must render those two differently: `¥0` would claim the calls cost nothing, when the truth is
 * that no rate is available. */
export interface ModelSpendRow {
  model: string
  /** Money (USD space) or credits; `null` when unpriced. */
  value: number | null
  calls: number
}

/** Flatten one platform row into per-model table rows: priced ones by spend descending, then the
 * unpriced ones by name.
 *
 * A separate pure function so the summary card, the detail table and the tests read the same sort
 * order and the same "unpriced" verdict. */
export function modelSpendRowsOf(row: PlatformSpend): ModelSpendRow[] {
  const priced: ModelSpendRow[] = []
  const unpriced: ModelSpendRow[] = []
  for (const model of row.models) {
    const calls = row.callsByModel?.[model] ?? 0
    const value = row.byModel?.[model]
    if (value === undefined) unpriced.push({ model, value: null, calls })
    else priced.push({ model, value, calls })
  }
  priced.sort((left, right) => (right.value ?? 0) - (left.value ?? 0) || left.model.localeCompare(right.model))
  unpriced.sort((left, right) => left.model.localeCompare(right.model))
  return [...priced, ...unpriced]
}

/**
 * Whether a provider bills per request (credits).
 *
 * One credit-rated model makes the whole provider credit-billed: a platform's plan is uniform, and
 * letting a single model without a rate turn half of that platform's numbers into yuan would be
 * worse than showing fewer rows.
 */
export function isCreditBilled(
  provider: string,
  models: readonly string[],
  credits: Record<string, Record<string, number>> | null | undefined,
): boolean {
  if (credits === null || credits === undefined) return false
  return models.some(model => creditRateOf(credits, provider, model) !== null)
}

/** Relative credit consumption of a platform: request count times the model's credit rate. The
 * rate is documented by the platform as display-only, so this is a relative figure rather than the
 * absolute number on the bill. */
function creditSpendOf(
  provider: string,
  calls: Record<string, number> | undefined,
  credits: Record<string, Record<string, number>> | null | undefined,
): number {
  if (calls === undefined) return 0
  let total = 0
  for (const model of Object.keys(calls)) {
    const rate = creditRateOf(credits, provider, model)
    if (rate === null) continue
    total += rate * calls[model]
  }
  return total
}

/** A money platform's billing currency: official DeepSeek quotes CNY (its ledger figures are CNY
 * rates converted into USD space), every third-party route quotes USD. */
function billingCurrencyOf(provider: string): SpendCurrency {
  return isDeepSeekRoute(provider) ? 'CNY' : 'USD'
}

/**
 * Split a ledger into per-platform spend.
 *
 * Credit platforms' figures come from "requests × model multiplier" and have nothing to do with
 * token volume; every other platform goes through `estimateByBucket` (official table first, peak
 * doubling, then the user's per-million rate, then the registry). The two units are **never** summed
 * — each becomes its own row.
 *
 * A platform that cannot be priced at all is omitted: a row too few beats a plausible wrong number.
 */
export function platformSpendsOf(
  usage: CostLedger | null | undefined,
  calls: CallLedger | null | undefined,
  book: PriceBook | null | undefined,
  rates: ThirdPartyRates | null | undefined,
  credits: Record<string, Record<string, number>> | null | undefined,
  planTierIndex = 0,
): PlatformSpend[] {
  if (usage === null || usage === undefined) return []
  const out: PlatformSpend[] = []
  for (const provider of Object.keys(usage)) {
    const models = Object.keys(usage[provider]).sort()
    if (models.length === 0) continue
    // Remember every relay row id the ledger carries, so its published price list can be resolved
    // under that exact id (a rate lookup is an exact match, and the list is published once per relay).
    noteRelayRoute(provider)
    const providerCalls = calls?.[provider]
    const callTotal = providerCalls === undefined
      ? 0
      : Object.values(providerCalls).reduce((sum, count) => sum + count, 0)
    // A subscription route is checked **first**: its ledger carries real token counts, so any later
    // branch would price those tokens at the list rate and report a bill the user never receives.
    const family = planFamilyOf(provider)
    if (family !== null) {
      const tier = tierAt(family, planTierIndex)
      const planUsage = planUsageOf(family, { [provider]: usage[provider] })
      // The metered equivalent: what these same tokens would cost at the vendor's list rate. Priced
      // through the ordinary estimator (registry rate, no period doubling for a non-DeepSeek model),
      // then converted into the plan's own CNY space so the two figures are comparable.
      const listCost = estimateByBucket({ [provider]: usage[provider] }, book, rates)
      const meteredCny = listCost.any ? toCurrency(listCost.total, 'cny') : null
      const byModel: Record<string, number> = {}
      for (const entry of planUsage.byModel) if (entry.credits !== null) byModel[entry.model] = entry.credits
      out.push({
        provider,
        unit: 'plan',
        value: planUsage.credits,
        calls: callTotal,
        models,
        byModel,
        ...(providerCalls !== undefined ? { callsByModel: { ...providerCalls } } : {}),
        planMetered: meteredCny,
        plan: {
          family,
          tier,
          credits: planUsage.credits,
          share: tier === null ? null : monthlyShareOf(planUsage.credits, tier),
          feeCny: tier === null ? null : amortisedFeeOf(planUsage.credits, tier),
          byModel: planUsage.byModel,
        },
      })
      continue
    }
    if (isCreditBilled(provider, models, credits)) {
      // Per-model credits, so the donut and the detail rows can show where the requests went.
      const byModel: Record<string, number> = {}
      const callsByModel: Record<string, number> = {}
      for (const model of models) {
        const count = providerCalls?.[model] ?? 0
        callsByModel[model] = count
        const rate = creditRateOf(credits, provider, model)
        if (rate !== null) byModel[model] = rate * count
      }
      out.push({
        provider,
        unit: 'credits',
        value: creditSpendOf(provider, providerCalls, credits),
        calls: callTotal,
        models,
        byModel,
        callsByModel,
      })
      continue
    }
    // Money path: hand this one provider's ledger to the shared estimator so the figure belongs to it
    // alone.
    const cost = estimateByBucket({ [provider]: usage[provider] }, book, rates)
    if (!cost.any) continue
    // Per-model money: price each model on its own with the same function, so the parts always sum to
    // the total. Unpriceable models stay out of `byModel` — the detail view reads "has calls but no
    // entry" as "rate not configured" rather than showing a ¥0 that claims the calls were free.
    const byModel: Record<string, number> = {}
    const callsByModel: Record<string, number> = {}
    for (const model of models) {
      const one = estimateByBucket({ [provider]: { [model]: usage[provider][model] } }, book, rates)
      if (one.any) byModel[model] = one.total
      callsByModel[model] = providerCalls?.[model] ?? 0
    }
    out.push({
      provider,
      unit: 'money',
      currency: billingCurrencyOf(provider),
      value: cost.total,
      calls: callTotal,
      models,
      byModel,
      callsByModel,
    })
  }
  // Highest spend first; ties by platform name so the render order is stable.
  return out.sort((left, right) => right.value - left.value || left.provider.localeCompare(right.provider))
}

/** Merge platform detail across sessions (the Insights page and the cross-session cards use one
 * vocabulary). */
export function mergePlatformSpends(...groups: ReadonlyArray<readonly PlatformSpend[]>): PlatformSpend[] {
  const byProvider = new Map<string, PlatformSpend>()
  for (const group of groups) {
    for (const row of group) {
      const previous = byProvider.get(row.provider)
      if (previous === undefined) {
        byProvider.set(row.provider, { ...row, models: [...row.models] })
        continue
      }
      // One platform cannot change unit between sessions; if it somehow does, keep the first verdict
      // rather than adding two currencies.
      previous.value += row.unit === previous.unit ? row.value : 0
      previous.calls += row.calls
      for (const model of row.models) if (!previous.models.includes(model)) previous.models.push(model)
      if (row.byModel !== undefined) {
        const byModel = previous.byModel ?? {}
        const callsByModel = previous.callsByModel ?? {}
        for (const model of Object.keys(row.byModel)) {
          byModel[model] = (byModel[model] ?? 0) + (row.unit === previous.unit ? row.byModel[model] : 0)
        }
        for (const model of Object.keys(row.callsByModel ?? {})) {
          callsByModel[model] = (callsByModel[model] ?? 0) + (row.callsByModel?.[model] ?? 0)
        }
        previous.byModel = byModel
        previous.callsByModel = callsByModel
      }
    }
  }
  const rows = [...byProvider.values()]
  for (const row of rows) row.models.sort()
  return rows.sort((left, right) => right.value - left.value || left.provider.localeCompare(right.provider))
}
