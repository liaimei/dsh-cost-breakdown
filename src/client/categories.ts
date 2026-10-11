/** 分类展示配置。每个分段都带两个数字：`raw` 是启发式计数，
 * `value` 是按启发式比例换算的、锚定到 provider 实测值的条形宽度
 * （无锚点可用时二者相等）。 */

import type { Category, ContextBreakdown, RequestRecord, Snapshot, TokenUsage } from '../shared/types'

/** 构成条/图例中的一个分段。`value` 是宽度（可能已按 provider 锚点重新配比），
 *  而 `raw` 保留启发式计数，因此图例打印的数字可以与它所标注的条不同，
 *  二者却不会在总量上互相矛盾。 */
export interface PartsPart {
  key: string
  color: string
  value: number
  /** 图例与 tooltip 展示的启发式计数（默认取 value）。 */
  raw?: number
  /** tooltip 显示名，默认取 `key` 的分类标签。 */
  label?: string
  /** 共享悬停组：悬停键等于某分段的 group 时该段点亮。 */
  group?: string
}

/** 堆叠构成的顺序，而不只是一份调色板：`system` 与 `tools` 搭的是
 *  已缓存的 prompt 前缀，因此先绘制，消息分段随后按 prompt 自身的
 *  排布展开。各处分段顺序都由 `CATS.map` 定义。 */
export const CATS: { key: Category | 'system' | 'tools'; color: string }[] = [
  { key: 'system', color: 'var(--color-indigo-500)' },
  { key: 'tools', color: 'var(--color-amber-500)' },
  { key: 'user', color: 'var(--color-green-500)' },
  { key: 'inject', color: 'var(--color-purple-500)' },
  { key: 'skill', color: 'var(--color-orange-500)' },
  { key: 'assistant', color: 'var(--color-blue-500)' },
  { key: 'tool', color: 'var(--color-teal-500)' },
]

/** 键 → CSS 自定义属性，供 DNA 色带与甜甜圈切片查表。由 {@link CATS}
 *  派生，因此颜色不可能只在一处被改而另一处漏改。 */
export const CAT_COLOR = Object.fromEntries(CATS.map(c => [c.key, c.color])) as Record<Category | 'system' | 'tools', string>

// `contextBreakdown` 数字细分出的五个分类；`system` 与 `tools` 直接由
// breakdown 承担，故意不并入此列表。
const MESSAGE_CATS: readonly (Category | 'system' | 'tools')[] = ['user', 'inject', 'skill', 'assistant', 'tool']

/** 把折叠自身的计数作为分段，且不做锚定：用于没有 provider 样本
 *  可供重新缩放的场合（tooltip 里的 breakdown、旧格式行）。 */
export function partsOf(breakdown: Snapshot['current'] | RequestRecord): PartsPart[] {
  return CATS.map((c) => {
    return { key: c.key, color: c.color, value: breakdown[c.key] || 0 }
  })
}

/** 官方 `contextBreakdown` 数字下发时，用它构建与饼图一致的原始分段，
 * 消息部分按折叠比例细分；该投影缺失时改由折叠自身的汇总值承担。 */
export function officialParts(
  current: Snapshot['current'],
  breakdown: ContextBreakdown | null,
): PartsPart[] {
  const foldSurface = current.user + current.inject + current.skill + current.assistant + current.tool
  const system = breakdown?.systemTokens ?? current.system
  const tools = breakdown?.toolsTokens ?? current.tools
  const messages = breakdown?.messageTokens ?? foldSurface
  const shares: Record<string, number> = { system, tools }
  if (foldSurface > 0) {
    let assigned = 0
    let largest: Category = 'user'
    for (const cat of MESSAGE_CATS) {
      // breakdown 给的是总量，折叠的分分类计数提供比例。
      // 即便 breakdown 缺失，比例也取自 `current`，此时
      // `messages` 恰好等于 `foldSurface`，这一轮取整相当于空操作。
      const count = Math.round(messages * (current[cat as Category] / foldSurface))
      shares[cat] = count
      assigned += count
      if (current[cat as Category] > current[largest]) largest = cat as Category
    }
    // 取整残差落到最大的分类上；下限截断避免一个很小的消息桶
    // 在若干份额向上取整后变成负数。
    shares[largest] = Math.max(0, shares[largest] + messages - assigned)
  } else {
    for (const cat of MESSAGE_CATS) shares[cat] = 0
  }
  return CATS.map(c => ({
    key: c.key,
    color: c.color,
    /** v8 ignore next 1 -- `shares` 用 system/tools 初始化，foldSurface 的两个分支
     * 又会给每个 MESSAGE_CATS 键赋值，因此每个键必然有定义；这里只是防御性兜底。 */
    value: shares[c.key] ?? 0,
  }))
}

/** 按 provider 锚定目标重新配比启发式分段：启发式提供比例，
 * provider 样本提供总量；`value` 取锚定后的数字，`raw` 保留启发式计数。 */
/** 按 provider 锚定目标重新配比启发式分段：启发式提供比例，
 * provider 样本提供总量；`value` 取锚定后的数字，`raw` 保留启发式计数。
 *
 * null 判断之后的每个分支都只重算 `value`：图例打印的是 `raw`，
 * 重缩放绝不能把它弄丢。目标为 null、0 或全零时，返回的分段
 * 只补上 `raw`、`value` 不动——条形此时展示的就是启发式。 */
export function anchoredParts(parts: PartsPart[], target: number | null): PartsPart[] {
  const sourced = parts.map(p => ({ ...p, raw: p.raw ?? p.value }))
  if (target === null || target <= 0) return sourced
  let total = 0
  for (const p of sourced) total += p.raw
  if (total <= 0) return sourced
  if (total === target) return sourced.map(p => ({ ...p, value: p.raw }))
  const scale = target / total
  return sourced.map(p => ({ ...p, value: Math.round(p.raw * scale) }))
}

/** Token 卡片按 token 性质拆分的计费构成：六个构成分类
 * 按构成卡的比例瓜分 provider 上报的 prompt 总量，
 * 精确的 output 计数补齐成环，各分段因此天然等于聊天行的 token 总数。 */
export function billedParts(
  current: Snapshot['current'],
  breakdown: ContextBreakdown | null,
  usage: TokenUsage,
): PartsPart[] {
  const input = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const estimated = officialParts(current, breakdown)
  const prompt = input > 0
    ? anchoredParts(estimated, input)
    : estimated.map(p => ({ ...p, value: 0 }))
  return [...prompt, { key: 'output', color: 'var(--color-pink-500)', value: Math.max(0, usage.outputTokens) }]
}
