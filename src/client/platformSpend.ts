/**
 * 按平台拆分消费：一个会话（或一组会话）在**每个平台**上花了多少、各调用了几次。
 *
 * 为什么必须按平台拆：不同平台的账单单位不同。DeepSeek 官方账号按人民币 token 计价
 * （还分峰谷），而积分制平台按次扣积分。把它们加成一个数字等于把两种货币相加——
 * 那个数字没有意义。因此这里产出的是一行行的平台明细，每行自带**自己的单位**。
 *
 * 一个平台走哪条计价路径由 {@link platformKindOf} 决定，与每轮读数、汇总卡用的是
 * 同一套判断，因此三处不会对同一个平台给出不同的口径。
 */

import { estimateSessionCostByBucket, type ModelBook, type SpendCurrency } from './cost'
import type { SessionCallCounts, SessionCostUsage } from '../shared/types'
import { creditRateOf } from '../shared/creditRates'
import { isDeepSeekProvider } from '../shared/providers'
import type { ThirdPartyRates } from '../shared/thirdPartyRates'

/** 账单币种的唯一声明在 cost.ts（格式化也在那里）；这里再导出，两个模块的消费方
 *  不必各自记住它住在哪儿。 */
export type { SpendCurrency } from './cost'

/** 一个平台（一批 provider 键）的消费明细。 */
export interface PlatformSpend {
  /** 展示用的平台名（取账本里的 provider 键，它是平台的事实标识）。 */
  provider: string
  /** `money` 走平台自己的账单币种；`credits` 原样显示积分。 */
  unit: 'money' | 'credits'
  /** 金额平台的账单币种；积分平台缺失（积分没有币种）。 */
  currency?: SpendCurrency
  /** 数值（金额按美元，或积分数）。 */
  value: number
  /** 该平台的请求次数；按次计费的平台就是它乘倍率。 */
  calls: number
  /** 该平台出现的模型 id，按名称排序。 */
  models: string[]
  /** 该平台每个模型各自的消费（金额按美元，或积分数）——环图按它分段。
   *  只含能定价的模型；两者的键集不要求相同。 */
  byModel?: Record<string, number>
/** 该平台每个模型的调用次数——与 `byModel` 同源，是分段占比的另一种口径。 */
  callsByModel?: Record<string, number>
}

/** 平台明细表的一行：该平台某个模型的消费与调用次数。
 *
 *  `value` 为 `null` 表示这个模型**定不出价**——不是「不花钱」。明细视图必须把这两种
 *  情况分开显示（¥0 会声称这些调用免费，而事实是插件拿不到费率）。 */
export interface ModelSpendRow {
  model: string
  /** 金额（美元空间）或积分数；未定价时为 null。 */
  value: number | null
  calls: number
}

/** 把一条平台明细摊成逐模型的表格行：已定价的按消费降序，其后是未定价的（按名）。
 *
 *  单独一个纯函数，是为了让汇总卡、明细表与测试读同一套排序与「未定价」判定。 */
export function modelSpendRowsOf(row: PlatformSpend): ModelSpendRow[] {
  const priced: ModelSpendRow[] = []
  const unpriced: ModelSpendRow[] = []
  for (const model of row.models) {
    const calls = row.callsByModel?.[model] ?? 0
    const value = row.byModel?.[model]
    if (value === undefined) unpriced.push({ model, value: null, calls })
    else priced.push({ model, value, calls })
  }
  priced.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.model.localeCompare(b.model))
  unpriced.sort((a, b) => a.model.localeCompare(b.model))
  return [...priced, ...unpriced]
}

/**
 * 某个 provider 是否由积分计价。
 *
 * 只要它在**任意一个**模型的积分表里有条目，整条 provider 就按积分计价：同一个平台的
 * 套餐是统一的，个别模型缺费率不该让同一个平台的另一半数字变成人民币。
 */
function isCreditProvider(
  provider: string,
  models: readonly string[],
  credits: Record<string, Record<string, number>> | null | undefined,
): boolean {
  if (credits === null || credits === undefined) return false
  return models.some(model => creditRateOf(credits, provider, model) !== null)
}

/** 该平台下能定出积分的模型数（用于按次计价时只累计有费率的那些调用）。 */
function creditCallsOf(
  provider: string,
  calls: SessionCallCounts[string] | undefined,
  credits: Record<string, Record<string, number>> | null | undefined,
): number {
  if (calls === undefined) return 0
  let total = 0
  for (const model of Object.keys(calls)) {
    const rate = creditRateOf(credits, provider, model)
    if (rate === null) continue
    // 一次请求扣一次倍率。倍率是相对值（平台自己标注「倍率只是显示」），
    // 因此这里给出的是**相对消耗**，不是账单上的绝对积分。
    total += rate * calls[model]
  }
  return total
}

/** 金额平台的账单币种：官方 DeepSeek 按人民币报价（它的账本数字正是由人民币费率
 *  换算进美元空间的），一切第三方路由按美元报价。 */
function spendCurrencyOf(provider: string): SpendCurrency {
  return isDeepSeekProvider(provider) ? 'CNY' : 'USD'
}

/**
 * 拆出每个平台的消费。
 *
 * 积分平台的数字来自「请求次数 × 模型倍率」，与 token 量无关；其余平台走
 * {@link estimateSessionCostByBucket}（官方价目表优先、峰谷翻倍、其次用户声明的
 * 每百万 token 费率、再其次注册表）。两种单位**绝不混加**，各自成行。
 *
 * 无法定价的平台不出现在结果里——宁可少一行，也不给一个看起来合理的错数。
 */
export function platformSpendsOf(
  usage: SessionCostUsage | null | undefined,
  calls: SessionCallCounts | null | undefined,
  book: ModelBook | null | undefined,
  rates: ThirdPartyRates | null | undefined,
  credits: Record<string, Record<string, number>> | null | undefined,
): PlatformSpend[] {
  if (usage === null || usage === undefined) return []
  const out: PlatformSpend[] = []
  for (const provider of Object.keys(usage)) {
    const models = Object.keys(usage[provider]).sort()
    if (models.length === 0) continue
    const perProviderCalls = calls?.[provider]
    const callTotal = perProviderCalls === undefined
      ? 0
      : Object.values(perProviderCalls).reduce((n, c) => n + c, 0)
    if (isCreditProvider(provider, models, credits)) {
      // 逐模型给出积分数：环图与明细行按它分段，读者才能看出「这一次花在哪个模型上」。
      const byModel: Record<string, number> = {}
      const callsByModel: Record<string, number> = {}
      for (const model of models) {
        const n = perProviderCalls?.[model] ?? 0
        callsByModel[model] = n
        const rate = creditRateOf(credits, provider, model)
        if (rate !== null) byModel[model] = rate * n
      }
      out.push({
        provider,
        unit: 'credits',
        value: creditCallsOf(provider, perProviderCalls, credits),
        calls: callTotal,
        models,
        byModel,
        callsByModel,
      })
      continue
    }
    // 金额一路：把这一个 provider 的账本单独交给共用定价函数，得到的数只属于它。
    const cost = estimateSessionCostByBucket({ [provider]: usage[provider] }, book, rates)
    if (!cost.any) continue
    // 逐模型的金额：把每个模型单独定价即可，与上面同一个函数，因此分项之和恒等于总额。
    // 定不出价的模型不进 `byModel`——明细视图据「有调用却不在 byModel 里」把它标成
    // 「未配置费率」，而不是显示一个声称不花钱的 ¥0。
    const byModel: Record<string, number> = {}
    const callsByModel: Record<string, number> = {}
    for (const model of models) {
      const one = estimateSessionCostByBucket({ [provider]: { [model]: usage[provider][model] } }, book, rates)
      if (one.any) byModel[model] = one.total
      callsByModel[model] = perProviderCalls?.[model] ?? 0
    }
    out.push({
      provider,
      unit: 'money',
      currency: spendCurrencyOf(provider),
      value: cost.total,
      calls: callTotal,
      models,
      byModel,
      callsByModel,
    })
  }
  // 消费高的在前；同额时按平台名，保证渲染顺序稳定。
  return out.sort((a, b) => b.value - a.value || a.provider.localeCompare(b.provider))
}

/** 把多个会话的平台明细合并（概览页/统计页跨会话汇总用同一套口径）。 */
export function mergePlatformSpends(
  ...groups: readonly (readonly PlatformSpend[])[]
): PlatformSpend[] {
  const byProvider = new Map<string, PlatformSpend>()
  for (const group of groups) {
    for (const row of group) {
      const prev = byProvider.get(row.provider)
      if (prev === undefined) {
        byProvider.set(row.provider, { ...row, models: [...row.models] })
        continue
      }
      // 同一平台在多个会话里只会是同一种单位；万一不同，保留先出现的那个口径，
      // 而不是把两种货币加在一起。
      prev.value += row.unit === prev.unit ? row.value : 0
      prev.calls += row.calls
      for (const model of row.models) if (!prev.models.includes(model)) prev.models.push(model)
      // 逐模型的分项同样累加，环图在跨会话视图下才与总额一致。
      if (row.byModel !== undefined) {
        const byModel = prev.byModel ?? {}
        const callsByModel = prev.callsByModel ?? {}
        for (const model of Object.keys(row.byModel)) {
          byModel[model] = (byModel[model] ?? 0) + (row.unit === prev.unit ? row.byModel[model] : 0)
        }
        for (const model of Object.keys(row.callsByModel ?? {})) {
          callsByModel[model] = (callsByModel[model] ?? 0) + (row.callsByModel?.[model] ?? 0)
        }
        prev.byModel = byModel
        prev.callsByModel = callsByModel
      }
    }
  }
  const rows = [...byProvider.values()]
  for (const row of rows) row.models.sort()
  return rows.sort((a, b) => b.value - a.value || a.provider.localeCompare(b.provider))
}

/** 合并多个会话的请求次数（跨会话汇总与 {@link mergePlatformSpends} 配套）。 */
export function mergeCallCounts(
  ...groups: readonly (SessionCallCounts | null | undefined)[]
): SessionCallCounts | null {
  const out: SessionCallCounts = {}
  let any = false
  for (const group of groups) {
    if (group === null || group === undefined) continue
    for (const provider of Object.keys(group)) {
      const models = out[provider] ?? {}
      for (const model of Object.keys(group[provider])) {
        models[model] = (models[model] ?? 0) + group[provider][model]
        any = true
      }
      out[provider] = models
    }
  }
  return any ? out : null
}
