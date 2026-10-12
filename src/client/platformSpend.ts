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

import { estimateSessionCostByBucket, type ModelBook } from './cost'
import type { SessionCallCounts, SessionCostUsage } from '../shared/types'
import { creditRateOf } from '../shared/creditRates'
import type { ThirdPartyRates } from '../shared/thirdPartyRates'

/** 一个平台（一批 provider 键）的消费明细。 */
export interface PlatformSpend {
  /** 展示用的平台名（取账本里的 provider 键，它是平台的事实标识）。 */
  provider: string
  /** `money` 走显示货币换算；`credits` 原样显示积分。 */
  unit: 'money' | 'credits'
  /** 数值（金额按美元，或积分数）。 */
  value: number
  /** 该平台的请求次数；按次计费的平台就是它乘倍率。 */
  calls: number
  /** 该平台出现的模型 id，按名称排序。 */
  models: string[]
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
      out.push({
        provider,
        unit: 'credits',
        value: creditCallsOf(provider, perProviderCalls, credits),
        calls: callTotal,
        models,
      })
      continue
    }
    // 金额一路：把这一个 provider 的账本单独交给共用定价函数，得到的数只属于它。
    const cost = estimateSessionCostByBucket({ [provider]: usage[provider] }, book, rates)
    if (!cost.any) continue
    out.push({ provider, unit: 'money', value: cost.total, calls: callTotal, models })
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
