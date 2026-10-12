/**
 * 输入框下方常驻花费行背后的 composer 停靠区读数。
 *
 * 它读取的 `contextTimeline` 投影与 Context 标签页相同，
 * 停靠区与标签页因此不可能给出不一致的结果；这里只需要头部标量
 * （计费账本与 model/provider 面孔），而这些信息也搭载在精简 head 上。
 *
 * 定价时段由插件自己的官方价目表在本地算出，
 * 读数因此能按自己的时钟翻转峰/谷时，无需往 host 跑一趟。
 */

import { useEffect, useState } from 'react'
import { billedTokensOf, estimateSessionCost, mergeCostUsage } from './cost'
import type { CostCurrency, ModelBook } from './cost'
import { useModelPrices } from './modelPrices'
import { projectionOf, type SessionStandardProps } from './services'
import { timelineOf } from './services'
import { DEFAULT_HOLIDAYS, msUntilFlip, periodAt, type PricingPeriod } from '../shared/officialRates'
import type { ContextTimeline, SessionCostUsage } from '../shared/types'
import { isDeepSeekProvider } from '../shared/providers'

/** 停靠区那一行渲染的全部内容，已把当前 agent 及其后代合并进来——
 *  组件自身不做任何折叠。`period` 刻意不在这里：它按自己的时钟跳动
 *  （{@link usePricingPeriod}），不能成为投影读取重渲染
 *  的理由。 */
export interface DockReading {
  /** session timeline；首个值推入之前为 null。 */
  timeline: ContextTimeline | null
  /** 本 agent 连同每个后代 subagent 合并后的计费账本。 */
  usage: SessionCostUsage | null
  /** 整个家族按显示货币估算的成本；未能定价时为 null。 */
  cost: number | null
  tokens: number
  /** 是否有任何计费 provider 是 DeepSeek（此时时段划分才有意义）。 */
  deepseek: boolean
  /** 当前定价时段及其下一次翻转。 */
  period: PricingPeriod
  failed: boolean
  book: ModelBook | null
}

/** 一秒，倒计时读数自己的节拍。 */
const TICK_MS = 1000

/**
 * 实时的定价时段，外加距离下一次翻转的剩余时间。
 *
 * 读数挂载期间一直跑一秒节拍，让徽标与倒计时随窗口同步翻转，卸载后停止。
 * `remainingMs` 每拍都会变，所以调用方每拍都会重渲染——倒计时读的就是它；
 * 而时段本身只在真正翻转时才换新对象，于是「时段没变」的帧不会白白触发
 * 投影重读。
 */
export interface LivePricingPeriod extends PricingPeriod {
  /** 距离下一次时段翻转的毫秒数；扫描窗口内没有已知边界时为 null。 */
  remainingMs: number | null
  /** 这一拍所用的时刻。界面据此判断「今天为什么全天谷时」，
   *  与 `remainingMs` 取自同一个瞬间，两处不会互相矛盾。 */
  now: number
}

export function usePricingPeriod(now: () => number = Date.now, holidays: readonly string[] = DEFAULT_HOLIDAYS): LivePricingPeriod {
  const [state, setState] = useState<LivePricingPeriod>(() => {
    const at = now()
    return { ...periodAt(at, holidays), remainingMs: msUntilFlip(at, holidays), now: at }
  })
  useEffect(() => {
    const timer = setInterval(() => {
      const at = now()
      const next = periodAt(at, holidays)
      const remainingMs = msUntilFlip(at, holidays)
      // 时段与剩余毫秒都没变就不换对象：同一个输入不该产生新的渲染。
      setState(prev => (prev.peak === next.peak && prev.next?.at === next.next?.at && prev.remainingMs === remainingMs
        ? prev
        : { ...next, remainingMs, now: at }))
    }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [now, holidays])
  return state
}

/** 驱动停靠区读数的接缝；生产环境挂载时只传 `currency`。 */
export interface DockDeps {
  /** 时钟接缝；生产环境用 Date.now。 */
  now?: () => number
  holidays?: readonly string[]
  currency: CostCurrency
}

/**
 * 从某个 session 推入的投影读取停靠区的数字。这个座位会被无条件调用：
 * `projectionOf` 是 hook，且键的顺序是稳定的。
 */
export function readDock(props: SessionStandardProps, deps: DockDeps, book: ModelBook | null, failed: boolean): Omit<DockReading, 'period'> {
  const timeline = projectionOf(props, 'contextTimeline', timelineOf)
  const usage: SessionCostUsage | null = timeline?.cost ?? null
  // 即便只有一方也走 `mergeCostUsage`：`timelineOf` 的透传会原样保留
  // host 的 cost 对象，其中的桶可能缺字段，只有合并时的重建会在
  // 定价前把四个字段都补零（agentTree 的 subagent 折叠也让每份参与
  // 的账本都经过它，二者因此对方形保持一致）。
  const merged = mergeCostUsage(usage)
  return {
    timeline,
    usage: merged,
    cost: estimateSessionCost(merged, book, deps.currency),
    tokens: billedTokensOf(merged),
    // 峰/谷时只对 DeepSeek provider 有意义；其他厂商的 `peak`
    // 桶就是普通牌价，做成开关只会说假话。
    deepseek: merged !== null && Object.keys(merged).some(p => isDeepSeekProvider(p)),
    failed,
    book,
  }
}

/** 价目册座位，重新导出以便停靠区组件只读一个 hook。 */
export function useDockBook(): { book: ModelBook | null; failed: boolean } {
  const { book, failed } = useModelPrices()
  return { book, failed }
}
