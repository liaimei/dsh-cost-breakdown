/** Context 标签页与 /context 弹窗的头条推导，锚定到 provider 实测值：用的正是聊天
 * composer 环也读取的那两个官方 token 计量投影——`contextPressure` 给出锚定总量、
 * `contextBreakdown` 给出构成计数——图例因此天然与环面板一致。 */

import type { ContextBreakdown, ContextPressure, ContextTimeline } from '../shared/types'
import { anchoredParts, officialParts, type PartsPart } from './categories'

/** Context 标签页的头部数字。`tokens` 是环的锚定总量，`pct` 是它
 *  占 `window` 的比例（没有可用窗口时为 null）；`parts` 刻意以另一
 *  口径求和——见该字段的注释。 */
export interface Headline {
  tokens: number
  window?: number
  pct: number | null
  /** 构成分段：`value` 是锚定到 provider 实测值的条宽（即环的填充量），
   *  `raw` 是图例与 tooltip 展示的官方启发式计数。 */
  parts: PartsPart[]
}

/**
 * 内核自己那套 composer 环推导（ui-conversation 的 `contextOccupancy`：
 * `Math.min(100, Math.round(used / window * 100))`，`used` = `projectedTokens ?? pressureTokens`），
 * 只是落在 0.1 的栅格上。调用方负责保证 `window > 0`。
 */
export function occupancyPercent(tokens: number, window: number): number {
  return Math.min(100, Math.round(tokens / window * 1000) / 10)
}

/** 从 timeline 推导头部，host 下发了 token 计量投影时优先用它们。
 *  调用方可以两个都不传；agentTree 里也会从某行的
 *  投影值中读出它们。 */
export function headlineOf(
  data: ContextTimeline,
  pressure: ContextPressure | null = null,
  breakdown: ContextBreakdown | null = null,
): Headline {
  const current = data.current
  // 与聊天环展示的公式相同：官方投影是最近一次用量采样，
  // 再按采样以来启发式 surface 的变动推算至今。
  const projected = pressure !== null && typeof pressure.projectedTokens === 'number'
    ? pressure.projectedTokens
    : undefined
  // 内核自己的回退顺序（`contextOccupancy`）：直接用 provider 采样值。真正的折叠
  // 会同时打上 `pressureTokens` 与 surface 采样，因此这个顺序只对外来或手工改过的行有意义。
  const sampled = pressure !== null && typeof pressure.pressureTokens === 'number'
    ? pressure.pressureTokens
    : undefined
  // 回退锚点，比投影晚一条请求：最新请求的 provider prompt 加上
  // 它被记录以来启发式的变动。分离生成方式的 wire head 把该记录的计费
  // 摘要放在 `last` 里（请求记录走 detail 通道）；内联生成方式则读它最新的记录。
  const last = data.last
  const requests = data.requests
  const lastReq = requests.length > 0 ? requests[requests.length - 1] : null
  const anchor = last !== undefined ? last : lastReq
  const derived = anchor !== null && typeof anchor.prompt === 'number'
    ? anchor.prompt + (current.total - anchor.total)
    : undefined
  const occupancyTokens = projected ?? sampled ?? derived ?? null
  const window = pressure !== null && typeof pressure.contextWindow === 'number'
    ? pressure.contextWindow
    : data.contextWindow
  const tokens = occupancyTokens ?? current.total
  const pct = window !== undefined && window > 0 ? occupancyPercent(tokens, window) : null
  const parts = anchoredParts(
    officialParts(current, breakdown),
    occupancyTokens !== null && tokens > 0 ? tokens : null,
  )
  return { tokens, window, pct, parts }
}
