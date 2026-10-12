/**
 * fold 对不可信输入的计量：把 provider 报告的 usage 归一成计费计数，
 * 以及把累计成本、解码、按工具计时的统计写入 state 的累加器。
 */

import type { CostBucketTotals, CostModelUsage, SessionCostUsage, TimingTotals, ToolTimingTotals } from '../shared/types'
import { pricedByOfficialPeriod } from '../shared/providers'
import { DEFAULT_HOLIDAYS, isPeakBeijing } from '../shared/officialRates'
import type { DecodeKind } from './logShapes'
import type { TimelineState } from './foldState'

/** fold 读取的持久 usage 对象形态——每个桶都经 `tokenCountOf` 重新核验，绝不直接相信。 */
export interface UsageLike {
  inputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  outputTokens?: unknown
}

/** 某个 usage 对象的各桶，已归一成计费计数（见 {@link tokenCountOf}）。成本账本把它们累加进
 * 自己对外提供的同一套分桶词表，因此共用一种形状。 */
export type BilledUsage = CostBucketTotals

/**
 * 把 provider 报告的一个 usage 桶转成计费计数；字段里没有可读数字时返回 null。小数四舍五入，
 * 负数钳到 0：网关若报告 `cached_tokens > prompt_tokens`，互不重叠的 uncached 值会被算成负数，
 * 而 state 里只要留下一个原始数字，之后每次投递都过不了 wire/state schema 的
 * `.int().nonnegative()` 关卡，该 session 的 projection 推送流会就此永久冻结。
 * NaN、无穷和非数字值一律按缺失处理。
 *
 * 导出是为了让 activity 单元用同一个清洗函数重新核验同一批桶。
 */
export function tokenCountOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null
  }
  return null
}

/** 某个瞬间是否按峰时费率记账：用 DeepSeek 自己的北京时段
 *  （shared/officialRates.ts），扣掉周末和全天按谷时计费的中国法定节假日。
 *  是否参与这套拆分由**模型**决定（见 {@link pricedByOfficialPeriod}）：
 *  官方价目表收录的模型无论走哪条 provider 路由都按它计费；
 *  其余 provider 一律记 `peak`，因为这套拆分是对 DeepSeek 峰谷翻倍的照搬，
 *  而不是替别家厂商另发明一套。 */
export function isPeakAt(
  time: number,
  provider: string,
  holidays: readonly string[] = DEFAULT_HOLIDAYS,
  model?: string,
): boolean {
  return !pricedByOfficialPeriod(provider, model) || isPeakBeijing(time, holidays)
}

/** 只克隆被改动的那条路径——未触及的分支继续与持久化的旧 state 共享，
 * apply 契约从不原地修改它。各桶进来时已清洗，汇总因此保持 schema 要求的非负安全整数。
 * 时间线 fold 与 activity 账本都靠这「一次」遍历计价，两者的记录因此形状一致。 */
export function addBilledUsage(
  prev: SessionCostUsage | undefined,
  provider: string,
  model: string,
  time: number,
  usage: BilledUsage,
  holidays: readonly string[] = DEFAULT_HOLIDAYS,
): SessionCostUsage {
  const period = isPeakAt(time, provider, holidays, model) ? 'peak' : 'off'
  const models = prev?.[provider] ?? {}
  const periods = models[model] ?? {}
  const b = periods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const nextPeriods: CostModelUsage = { ...periods }
  nextPeriods[period] = {
    uncached: b.uncached + usage.uncached,
    cacheRead: b.cacheRead + usage.cacheRead,
    cacheWrite: b.cacheWrite + usage.cacheWrite,
    output: b.output + usage.output,
  }
  const nextModels: Record<string, CostModelUsage> = { ...models, [model]: nextPeriods }
  return { ...(prev ?? {}), [provider]: nextModels }
}

/** {@link addBilledUsage} 的镜像：对外提供的值绝不能与它折叠自的持久记录别名共享，
 * 因此账本每一层都复制。 */
export function copyCostUsage(cost: SessionCostUsage): SessionCostUsage {
  const copy: SessionCostUsage = {}
  for (const provider in cost) {
    const models: Record<string, CostModelUsage> = {}
    for (const model in cost[provider]) {
      const periods = cost[provider][model]
      const modelCopy: CostModelUsage = {}
      if (periods.peak !== undefined) modelCopy.peak = { ...periods.peak }
      if (periods.off !== undefined) modelCopy.off = { ...periods.off }
      models[model] = modelCopy
    }
    copy[provider] = models
  }
  return copy
}

/** 键取自请求信封的 (provider, model)；没有 model 的请求无从计价。 */
export function accumulateCost(
  st: TimelineState,
  time: number,
  usage: BilledUsage,
  holidays: readonly string[] = DEFAULT_HOLIDAYS,
): void {
  const model = st.model
  if (model === undefined) return
  st.cost = addBilledUsage(st.cost, st.provider ?? '', model, time, usage, holidays)
}

/** 只保留最忙的 16 个工具名。 */
const TOOL_TIMING_CAP = 16

/** 生成阶段拆分用的解码分桶，按卡片顺序排列。 */
export const DECODE_KINDS: readonly DecodeKind[] = ['reasoning', 'text', 'toolarg']

/** 钳制过的 `to - from`，单位毫秒；端点非有限时按 0 处理，
 * 一个损坏的时间戳因此不会造出 NaN 区间而让 state schema 校验失败。 */
export function durOf(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, to - from)
}

/** 首次使用时创建，之后每次 `ensure()` 都「克隆」：持久化的旧 state 从不被原地写入。 */
export function ensureTiming(st: TimelineState): TimingTotals {
  if (st.timing === undefined) {
    st.timing = { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }
  }
  return st.timing
}

/** 各解码分桶的区间与计数分别落到 TimingTotals 的哪些字段。 */
const DECODE_FIELDS: Record<DecodeKind, { ms: 'reasoningMs' | 'textMs' | 'toolArgMs'; n: 'reasoningBlocks' | 'textBlocks' | 'toolArgBlocks' }> = {
  reasoning: { ms: 'reasoningMs', n: 'reasoningBlocks' },
  text: { ms: 'textMs', n: 'textBlocks' },
  toolarg: { ms: 'toolArgMs', n: 'toolArgBlocks' },
}

/** 区间或计数为 0 时「保持缺失」，拆分前的 state 因此不会凭空多出无用属性；卡片把缺失读作 0。 */
export function addDecode(timing: TimingTotals, kind: DecodeKind, ms: number, blocks: number): void {
  const field = DECODE_FIELDS[kind]
  if (ms > 0) timing[field.ms] = (timing[field.ms] ?? 0) + ms
  if (blocks > 0) timing[field.n] = (timing[field.n] ?? 0) + blocks
}

/** 超出上限的新名称会挤掉最小的统计项，因此即使面对全是唯一名称的敌意日志，state 仍保持有界。 */
export function bumpToolTotals(timing: TimingTotals, name: string, ms: number): void {
  // `__proto__` 是唯一一个会给原型赋值而非写入行的键：统计项会丢失，上限永远看不到它，
  // 随后 `foldWire` 的 `for...in` 还会把继承来的 `calls`/`ms` 当成 `{}` 复制出去——过不了
  // 严格的 wire schema，而该异常会在注册表没有兜底的驱动循环里抛出，让本单元的推送流永久卡住。
  // client 边界同样跳过这个名称。
  if (name === '__proto__') return
  // 用 hasOwn 而不是判索引：运行时确实可能缺少该键（名称不在持久化的统计表里）。
  if (!Object.hasOwn(timing.tools, name)) {
    if (Object.keys(timing.tools).length >= TOOL_TIMING_CAP) {
      let minKey = ''
      let minMs = Infinity
      for (const k in timing.tools) {
        if (timing.tools[k].ms < minMs) {
          minMs = timing.tools[k].ms
          minKey = k
        }
      }
      const kept: Record<string, ToolTimingTotals> = {}
      for (const k in timing.tools) {
        if (k !== minKey) kept[k] = timing.tools[k]
      }
      timing.tools = kept
    }
    timing.tools[name] = { calls: 1, ms }
    return
  }
  const cur = timing.tools[name]
  timing.tools[name] = { calls: cur.calls + 1, ms: cur.ms + ms }
}
