/**
 * 每轮消费：把 host 折出的 `turnCost` 原料算成一个可显示的数。
 *
 * 按平台动态决定显示什么，这正是需求：
 * - **按 token 计价的平台**（DeepSeek 官方账号/API、以及用户声明了每百万 token 费率的第三方）
 *   → 算**金额**，并区分峰谷（官方模型峰时翻倍）。
 * - **按次计费的平台**（积分制，如 workbuddy 的「N 积分/次」）
 *   → 算**积分**。一次请求就是一次扣费，与 token 量无关，因此这一路完全不读 token。
 *
 * 金额一路**不自己算**：直接调用 `estimateSessionCostByBucket`，与汇总卡同一处定价、
 * 同一套峰谷规则，因此两处不可能对同一次结算给出两个答案。
 *
 * 归属或单价拿不到时返回 `null`，界面显示破折号：宁可空着，也不猜一个看起来合理的数。
 */

import type { ModelBook } from './cost'
import { estimateSessionCostByBucket } from './cost'
import type { ThirdPartyRates } from '../shared/thirdPartyRates'
import type { CostModelUsage, SessionCostUsage, TurnCostEntry } from '../shared/types'

/** 一次显示：算出来的数 + 它的单位。 */
export interface TurnSpend {
  /** 数值本身（金额按美元，或积分数）。 */
  value: number
  /** `money` 走显示货币换算；`credits` 原样显示积分。 */
  unit: 'money' | 'credits'
}

/** 按次计费的费率表：`<provider>:<model>` → 每次请求的积分数。
 *  形状与 `thirdPartyRates` 一致，只是语义不同（按次，不是按 token）。 */
export type CreditRates = Record<string, Record<string, number>>

/** 收窄设置里的积分费率表：坏项整条丢弃，一行写错不该让整张表失效。
 *  只接受**数字**：平台的展示文案（如 `"x0.29 credits"`）不可计算，留在展示层。 */
export function creditRatesOf(value: unknown): CreditRates | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: CreditRates = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const at = key.indexOf(':')
    if (at <= 0) continue
    const provider = key.slice(0, at).trim().toLowerCase()
    const model = key.slice(at + 1).trim().toLowerCase()
    if (provider === '' || model === '') continue
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) continue
    const models = out[provider] ?? {}
    models[model] = raw
    out[provider] = models
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 查一次请求的积分数；provider 与 model 都忽略大小写，逐字匹配。 */
export function creditRateOf(
  rates: CreditRates | null | undefined,
  provider: string,
  model: string,
): number | null {
  if (rates === null || rates === undefined) return null
  const models = rates[provider.trim().toLowerCase()]
  if (models === undefined) return null
  const rate = models[model.trim().toLowerCase()]
  return rate === undefined ? null : rate
}

/**
 * 算出一轮的消费。
 *
 * 每条 `(provider, model)` 只走**一条**计价路径：
 * 1. 用户在积分表里声明了它 → 按次算积分。积分制平台的账单与 token 量无关，
 *    而且它通常也不在 models.dev 注册表里，无从按 token 计价。
 * 2. 其余一切交给 {@link estimateSessionCostByBucket}：官方价目表优先（峰时翻倍），
 *    其次用户声明的每百万 token 第三方费率，再其次注册表。
 *
 * 一轮里若**混用**了积分与按 token 的平台，返回积分——那类平台的账单无法折算成金额，
 * 而金额可以，因此优先给出不可替代的那一个。
 *
 * 返回 `null` 表示这一轮没有任何可定价的请求。
 */
export function turnSpendOf(
  entry: TurnCostEntry | undefined,
  book: ModelBook | null | undefined,
  rates: ThirdPartyRates | null | undefined,
  credits: CreditRates | null | undefined,
): TurnSpend | null {
  if (entry === undefined) return null
  let creditTotal = 0
  let anyCredit = false
  // 按 token 计价的那部分单独收集，交给共用定价函数——它只处理它能定价的行。
  const moneyUsage: SessionCostUsage = {}
  for (const provider of Object.keys(entry.usage)) {
    const models: Record<string, CostModelUsage> = entry.usage[provider]
    for (const model of Object.keys(models)) {
      const perCall = creditRateOf(credits, provider, model)
      if (perCall !== null) {
        creditTotal += perCall * (entry.requests?.[provider]?.[model] ?? 0)
        anyCredit = true
        continue
      }
      moneyUsage[provider] ??= {}
      moneyUsage[provider][model] = models[model]
    }
  }
  const cost = estimateSessionCostByBucket(moneyUsage, book, rates)
  // 两条路径都没产出数字时不显示任何东西（既不显示 ¥0.00 也不显示 0 积分）。
  if (anyCredit) return { value: creditTotal, unit: 'credits' }
  return cost.any ? { value: cost.total, unit: 'money' } : null
}

/** 积分按平台习惯去尾零：小于 1 保留三位，否则两位。 */
export function fmtCredits(value: number): string {
  if (value === 0) return '0'
  const digits = Math.abs(value) < 1 ? 3 : 2
  return value.toFixed(digits).replace(/\.?0+$/, '')
}
