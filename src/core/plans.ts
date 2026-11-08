/**
 * Subscription plans: the billing model that is *not* a per-token price.
 *
 * A Chinese coding platform sells the same models two ways, and the two must never be added together:
 *
 *   - **Metered (按量计费)** — every call is charged at a per-million-token rate. DeepSeek's own
 *     routes work this way, with Beijing peak/off-peak windows.
 *   - **Subscription (订阅套餐)** — a monthly fee buys a quota, and calls inside the quota cost
 *     nothing at the margin. 智谱 GLM Coding Plan, MiniMax M Plan and Kimi Code Plan all work this
 *     way, and their harness routes are named for it (`zai-coding-cn`, `kimi-coding`, `minimax-cn`).
 *
 * Why the route decides instead of a guess: the route id is the one field that is always present and
 * factual. A subscription route's ledger still carries token counts (the harness reports what the
 * model read and wrote), so a naive reading would price those tokens at the list rate and report a
 * bill the user never receives. Mapping route → plan family is what keeps the two models apart.
 *
 * Every number below is transcribed from the vendor's own pricing documentation; the `source` field
 * carries the URL, and anything a vendor does not publish is `null` rather than a guess. A `null`
 * price makes the surface say "套餐价未配置" instead of inventing one.
 */

/** One model's credit coefficients: how many credits one unit of each token bucket consumes. */
export interface PlanCreditRate {
  /** Per-token coefficient for uncached input. */
  input: number
  /** Per-token coefficient for cache-hit input. */
  cachedInput: number
  /** Per-token coefficient for generated output. */
  output: number
}

/** One tier of a plan family. */
export interface PlanTier {
  /** Stable id inside its family: `lite`/`pro`/`max`, or `go`/`explore`/`build`. */
  id: string
  /** Display label as the vendor writes it. */
  label: string
  /** Monthly fee in CNY; `null` when the vendor does not publish a fixed price. */
  monthlyCny: number | null
  /** Credits granted per rolling 5-hour window; `null` when the plan does not meter credits. */
  credits5h: number | null
  /** Credits granted per week; `null` when the plan does not meter credits or meters by month. */
  creditsWeek: number | null
  /** Credits granted per subscription month; `null` when the plan does not meter credits by month. */
  creditsMonth?: number | null
  /** Relative usage versus the family's entry tier, for plans that publish a multiple instead of a
   * credit table (MiniMax M Plan: 1× / 3× / 12×). `null` when the plan meters credits. */
  usageMultiple: number | null
}

/** A peak-window rule: the listed weekdays and hours bill at the base rate, everything else at
 * `offPeakFactor` of it. */
export interface PlanPeakRule {
  /** ISO weekdays (Monday = 1) that have a peak window at all. */
  weekdays: readonly number[]
  /** Peak window start hour, Beijing time (inclusive). */
  fromHour: number
  /** Peak window end hour, Beijing time (exclusive). */
  toHour: number
  /** Multiplier applied to credits outside the peak window (智谱: 0.5). */
  offPeakFactor: number
}

/** One vendor's subscription family. */
export interface PlanFamily {
  /** Stable id: `glm-coding`, `minimax-mplan`, `kimi-code`. */
  id: string
  /** Registry vendor id the family prices under. */
  vendor: string
  /** Display name as the vendor brands it. */
  label: string
  /** Harness route ids that bill through this plan rather than per token. */
  routes: readonly string[]
  /** Lowercased model-id prefixes the family covers. A model outside them still belongs to the
   * route, but has no credit coefficients, so its credits are reported as uncomputable. */
  models: readonly string[]
  tiers: readonly PlanTier[]
  /** Credit coefficients per model id. Absent for plans that meter in usage multiples. */
  creditRates?: Record<string, PlanCreditRate>
  /** Peak/off-peak rule for the credit charge. Absent when the plan has no time-of-day pricing. */
  peak?: PlanPeakRule
  /** The vendor page these figures come from. */
  source: string
}

/**
 * 智谱 GLM Coding Plan (积分制, in force since the 2026-07-30 revision).
 *
 * Credit charge = (input × inputCoef + cachedInput × cachedInputCoef + output × outputCoef) / 10000,
 * halved outside the weekday 14:00–18:00 peak window. Tiers, quotas and coefficients are all from
 * the vendor's 套餐概览 / 团队版权益 pages.
 */
const GLM_CREDIT_DIVISOR = 10000

export const GLM_CODING: PlanFamily = {
  id: 'glm-coding',
  vendor: 'zhipuai',
  label: 'GLM Coding Plan',
  routes: ['zai-coding-cn'],
  models: ['glm-'],
  tiers: [
    { id: 'lite', label: 'Lite', monthlyCny: 49, credits5h: 2000, creditsWeek: 10000, usageMultiple: null },
    { id: 'pro', label: 'Pro', monthlyCny: 149, credits5h: 12000, creditsWeek: 60000, usageMultiple: null },
    { id: 'max', label: 'Max', monthlyCny: 469, credits5h: 28000, creditsWeek: 140000, usageMultiple: null },
  ],
  creditRates: {
    'glm-5.3': { input: 6.9, cachedInput: 1.7, output: 24 },
    'glm-5.3-flash': { input: 2.3, cachedInput: 0.56, output: 8 },
  },
  peak: { weekdays: [1, 2, 3, 4, 5], fromHour: 14, toHour: 18, offPeakFactor: 0.5 },
  source: 'https://docs.bigmodel.cn/cn/coding-plan/overview',
}

/**
 * MiniMax M Plan. The vendor publishes usage multiples (1× / 3× / 12×) rather than a credit table and
 * does not publish the tier prices in its documentation, so every fee is `null`: the surface then
 * shows the equivalent metered value and says the plan price is unconfigured, instead of inventing one.
 */
export const MINIMAX_MPLAN: PlanFamily = {
  id: 'minimax-mplan',
  vendor: 'minimax',
  label: 'M Plan',
  routes: ['minimax-cn'],
  models: ['minimax-'],
  tiers: [
    { id: 'go', label: 'Go', monthlyCny: null, credits5h: null, creditsWeek: null, usageMultiple: 1 },
    { id: 'explore', label: 'Explore', monthlyCny: null, credits5h: null, creditsWeek: null, usageMultiple: 3 },
    { id: 'build', label: 'Build', monthlyCny: null, credits5h: null, creditsWeek: null, usageMultiple: 12 },
  ],
  source: 'https://platform.minimax.cn/docs/m-plan/intro',
}

/**
 * Kimi Code Plan. Moonshot's API is metered and explicitly "无订阅制方案"; the Code Plan is a separate
 * product whose prices the public documentation does not state, so the family carries no fee and no
 * credit table. It exists so the route is *recognised* as a subscription rather than silently priced
 * as if it were the metered API.
 */
export const KIMI_CODE: PlanFamily = {
  id: 'kimi-code',
  vendor: 'moonshotai',
  label: 'Kimi Code Plan',
  routes: ['kimi-coding'],
  models: ['kimi-'],
  tiers: [
    { id: 'entry', label: 'Kimi Code', monthlyCny: null, credits5h: null, creditsWeek: null, usageMultiple: 1 },
  ],
  source: 'https://www.kimi.com/code',
}

/**
 * 阿里云百炼 Token Plan 个人版 — Credits metered per **subscription month** (not per week), so the
 * quota is stated directly and no week→month conversion applies.
 *
 * Prices are the catalogue prices; the vendor also runs a limited-time discount (39/79/139/499), which
 * is deliberately not encoded: a promo price that silently expires would misreport every later month.
 * The vendor publishes no per-model credit coefficients, so usage is metered in credits only where the
 * console reports them — the card therefore shows the quota share, not a per-model split.
 */
export const QWEN_TOKEN_PLAN: PlanFamily = {
  id: 'qwen-token-plan',
  vendor: 'qwen',
  label: 'Token Plan',
  routes: ['qwen-token-plan', 'qwen-token-plan-cn', 'qwen-token-plan-individual'],
  models: ['qwen', 'auto', 'deepseek-', 'glm-', 'kimi-', 'minimax-', 'wan', 'happyhorse-'],
  tiers: [
    { id: 'lite', label: 'Lite', monthlyCny: 60, credits5h: null, creditsWeek: null, creditsMonth: 11_500, usageMultiple: null },
    { id: 'essential', label: 'Essential', monthlyCny: 120, credits5h: null, creditsWeek: null, creditsMonth: 25_500, usageMultiple: null },
    { id: 'standard', label: 'Standard', monthlyCny: 180, credits5h: null, creditsWeek: null, creditsMonth: 45_000, usageMultiple: null },
    { id: 'pro', label: 'Pro', monthlyCny: 600, credits5h: null, creditsWeek: null, creditsMonth: 180_000, usageMultiple: null },
  ],
  source: 'https://help.aliyun.com/zh/model-studio/token-plan-personal-overview',
}

/**
 * Xiaomi MiMo Token Plan — a subscription, but its documentation publishes neither a credit table nor
 * per-model coefficients, so only the *identity* is recorded: the route is recognised as a plan and
 * its figure stays unknown instead of being priced as if it were the metered API.
 */
export const XIAOMI_TOKEN_PLAN: PlanFamily = {
  id: 'xiaomi-token-plan',
  vendor: 'xiaomi',
  label: 'MiMo Token Plan',
  routes: ['xiaomi-token-plan-cn', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-sgp'],
  models: ['mimo-'],
  tiers: [
    { id: 'entry', label: 'Token Plan', monthlyCny: null, credits5h: null, creditsWeek: null, usageMultiple: 1 },
  ],
  source: 'https://platform.xiaomimimo.com/token-plan',
}

/**
 * Z.AI's international GLM Coding Plan (the `zai` route, USD-priced).
 *
 * Same product as the domestic plan but a different account and a different currency, so it is a
 * separate family: the domestic CNY figures must never be printed against a USD subscription. The
 * vendor states "starting at 18 USD/month" and publishes the tier table only on the subscribe page,
 * so the fee stays unknown here rather than being guessed from the marketing line.
 */
export const GLM_CODING_INTL: PlanFamily = {
  id: 'glm-coding-intl',
  vendor: 'zai',
  label: 'GLM Coding Plan (intl)',
  routes: ['zai'],
  models: ['glm-'],
  tiers: [
    { id: 'lite', label: 'Lite', monthlyCny: null, credits5h: null, creditsWeek: null, usageMultiple: null },
    { id: 'pro', label: 'Pro', monthlyCny: null, credits5h: null, creditsWeek: null, usageMultiple: null },
    { id: 'max', label: 'Max', monthlyCny: null, credits5h: null, creditsWeek: null, usageMultiple: null },
  ],
  creditRates: {
    'glm-5.3': { input: 6.9, cachedInput: 1.7, output: 24 },
    'glm-5.3-flash': { input: 2.3, cachedInput: 0.56, output: 8 },
  },
  peak: { weekdays: [1, 2, 3, 4, 5], fromHour: 14, toHour: 18, offPeakFactor: 0.5 },
  source: 'https://docs.z.ai/devpack/overview',
}

/** Every family this build knows, in display order. */
export const PLAN_FAMILIES: readonly PlanFamily[] = [
  GLM_CODING, GLM_CODING_INTL, QWEN_TOKEN_PLAN, MINIMAX_MPLAN, KIMI_CODE, XIAOMI_TOKEN_PLAN,
]

/** The family a harness route bills through, or `null` for a metered route. */
export function planFamilyOf(route: string): PlanFamily | null {
  const needle = route.trim().toLowerCase()
  for (const family of PLAN_FAMILIES) {
    if (family.routes.includes(needle)) return family
  }
  return null
}

/** The tier at a 0-based index (clamped to the family's range), so one preference can pick a tier
 * across families whose tier counts differ. */
export function tierAt(family: PlanFamily, index: number): PlanTier | null {
  if (family.tiers.length === 0) return null
  const clamped = Math.min(Math.max(index, 0), family.tiers.length - 1)
  return family.tiers[clamped] ?? null
}

/** Whether a model is covered by the family's credit table (and therefore credit-computable). */
export function planCoversModel(family: PlanFamily, model: string): boolean {
  const needle = model.trim().toLowerCase()
  return family.models.some(prefix => needle.startsWith(prefix))
}

/** The credit coefficients of one model, matched by longest prefix so `glm-5.3-flash` never resolves
 * to the `glm-5.3` row. */
export function planCreditRateOf(family: PlanFamily, model: string): PlanCreditRate | null {
  const table = family.creditRates
  if (table === undefined) return null
  const needle = model.trim().toLowerCase()
  let best: { key: string; rate: PlanCreditRate } | null = null
  for (const [key, rate] of Object.entries(table)) {
    if (!needle.startsWith(key)) continue
    if (best === null || key.length > best.key.length) best = { key, rate }
  }
  return best === null ? null : best.rate
}

/** Token buckets one billing period contributed. Mirrors the wire's `BucketTotals`. */
export interface PlanBuckets {
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** Credits one model's period contributes, or `null` when the family has no coefficient for it. */
export function creditsOfModel(
  family: PlanFamily,
  model: string,
  buckets: PlanBuckets,
  offPeak: boolean,
): number | null {
  const rate = planCreditRateOf(family, model)
  if (rate === null) return null
  const raw = buckets.uncached * rate.input
    + buckets.cacheRead * rate.cachedInput
    // Cache writes bill as ordinary input: the vendor's formula has no separate write column, and
    // charging them nothing would understate the quota.
    + buckets.cacheWrite * rate.input
    + buckets.output * rate.output
  const factor = offPeak && family.peak !== undefined ? family.peak.offPeakFactor : 1
  return (raw / GLM_CREDIT_DIVISOR) * factor
}

/** One model's credit contribution, with the uncomputable case kept distinguishable from zero. */
export interface ModelCredits {
  model: string
  credits: number | null
}

/** Credits consumed by a whole ledger for one plan family, plus the models the plan could not meter. */
export interface PlanUsage {
  /** Total credits, summing only the computable models. */
  credits: number
  /** Per-model credits, in ledger order; `null` marks a model the plan has no coefficients for. */
  byModel: ModelCredits[]
  /** Whether at least one model was computable. */
  any: boolean
}

/**
 * Credits a ledger consumed on one plan family.
 *
 * The wire ledger is already split by billing period (`peak`/`off`), and the family's own peak rule
 * says which side is discounted — so the off-peak factor is applied per period rather than re-derived
 * from timestamps. Re-deriving would need the request times the ledger does not carry here.
 */
export function planUsageOf(
  family: PlanFamily,
  usage: Readonly<Record<string, Readonly<Record<string, { peak?: PlanBuckets; off?: PlanBuckets }>>>> | null | undefined,
): PlanUsage {
  const out: PlanUsage = { credits: 0, byModel: [], any: false }
  if (usage === null || usage === undefined) return out
  for (const route of Object.keys(usage)) {
    if (planFamilyOf(route)?.id !== family.id) continue
    const models = usage[route]
    if (models === null || typeof models !== 'object') continue
    for (const model of Object.keys(models)) {
      const periods = models[model]
      let total = 0
      let computable = false
      for (const period of ['peak', 'off'] as const) {
        const buckets = periods?.[period]
        if (buckets === undefined) continue
        const credits = creditsOfModel(family, model, buckets, period === 'off')
        if (credits === null) continue
        total += credits
        computable = true
      }
      out.byModel.push({ model, credits: computable ? total : null })
      if (computable) {
        out.credits += total
        out.any = true
      }
    }
  }
  return out
}

/** The weekly quota of a tier, or `null` when the plan does not meter credits. */
export function weeklyQuotaOf(tier: PlanTier): number | null {
  return tier.creditsWeek
}

/** Average weeks in a calendar month. The monthly fee is amortised over a month, so a weekly quota has
 * to be converted on this basis; the value is the Gregorian mean (365.2425 / 7 / 12). */
export const WEEKS_PER_MONTH = 4.3482

/**
 * The share of a month's quota this usage consumed, as a fraction. `null` when the tier publishes no
 * credit quota — an unknown share must not render as 0%.
 */
export function monthlyShareOf(credits: number, tier: PlanTier): number | null {
  // A plan that meters by subscription month (阿里云 Token Plan) states its quota directly; only the
  // weekly plans need the week→month conversion.
  const monthly = tier.creditsMonth
  if (typeof monthly === 'number' && monthly > 0) return credits / monthly
  const weekly = weeklyQuotaOf(tier)
  if (weekly === null || weekly <= 0) return null
  return credits / (weekly * WEEKS_PER_MONTH)
}

/**
 * The part of the monthly fee this usage consumed: `monthly × share`. `null` when either the fee or
 * the quota is unpublished — a subscription with an unknown price has no per-use figure.
 */
export function amortisedFeeOf(credits: number, tier: PlanTier): number | null {
  const share = monthlyShareOf(credits, tier)
  if (share === null || tier.monthlyCny === null) return null
  return tier.monthlyCny * share
}

/** Per-million-CNY equivalent of a tier: fee ÷ quota tokens. Used to explain the saving in the
 * platform card's footnote. `null` when either side is unpublished. */
export function tierValueOf(tier: PlanTier): number | null {
  if (tier.monthlyCny === null) return null
  if (tier.creditsWeek === null || tier.creditsWeek <= 0) return null
  return tier.monthlyCny / (tier.creditsWeek * WEEKS_PER_MONTH)
}
