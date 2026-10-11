/**
 * 浏览器的 DNA 模式：组装上下文中的每一项（system prompt、
 * 每个工具 schema、每条 surface 消息）对应一条带，按 **prompt** 顺序排列。
 *
 * header 世代的 seq **不能**用作排序键：dsh 在使用它的首个请求派发时
 * 追加 `request/header`，落点已在上下文中所有消息之后，
 * 若按 seq 排序，工具带会被排到这些 schema 所描述的结果
 * 之后。世代刷新时就地替换前缀，当前世代的带
 * 因此始终留在最前。
 */

import type { Category, SurfaceNode } from '../shared/types'
import type { Assembled } from './assemble'
import { CAT_COLOR } from './categories'
import type { Translate } from './i18n'

/** DNA 条上的一段。消息带会把节点一并传出，标签构建器
 * 因此能直接从它读出 tool/form/skill（联合类型按 `cat` 判别）。 */
export type DnaItem =
  | { key: string; cat: 'system' | 'tools'; tokens: number; time?: number }
  | { key: string; cat: Category; tokens: number; time?: number; node: SurfaceNode }

/** 某个组装步骤的 DNA 条：先是 system 带，然后是每个工具 schema，最后
 *  按 surface 顺序排列的消息带。顺序由视图自己决定、绝不用 seq——见文件头说明。 */
export function dnaOf(view: Assembled): DnaItem[] {
  const items: DnaItem[] = []
  if (view.system !== null) {
    items.push({ key: 'sys', cat: 'system', tokens: view.system.tokens, time: view.system.time })
  }
  if (view.header !== null) {
    for (const tool of view.header.tools) {
      items.push({ key: 'tool:' + tool.name, cat: 'tools', tokens: tool.tokens })
    }
  }
  // 零 token 项仍保留其带：条形会丢弃零宽度，而阅读顺序依然如实。
  for (const n of view.nodes) {
    items.push({
      key: 'n' + String(n.seq),
      cat: n.cat,
      tokens: n.tokens,
      node: n,
      ...(n.time !== undefined ? { time: n.time } : {}),
    })
  }
  return items
}

/** 趋势图条形的 DNA 渐变中的一段：同一套分解，加上颜色与 `off`，
 * 即它下方累计的 token 数（命中测试与跨条生命周期高亮都读 `off`）。 */
export type TrendBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Category; tokens: number; off: number; color: string; node: SurfaceNode }

/** 某个条形的渐变带：{@link dnaOf} 的条目再加上颜色与累计
 *  token 偏移，跨条高亮正是靠它找到同一片。 */
export function trendBandsOf(view: Assembled): TrendBand[] {
  const bands: TrendBand[] = []
  let off = 0
  for (const it of dnaOf(view)) {
    if ('node' in it) {
      bands.push({ key: it.key, cat: it.cat, tokens: it.tokens, off, color: CAT_COLOR[it.cat], node: it.node })
    } else {
      bands.push({ key: it.key, cat: it.cat, tokens: it.tokens, off, color: CAT_COLOR[it.cat] })
    }
    off += it.tokens
  }
  return bands
}

/** DNA 模式相对前一个条形的**增量**视图：两份带列表按 key 配对后逐项求差。
 * `tokens` 带符号（增为正、减为负），`off` 是从零线累计的幅度，
 * 被移除项的次序取自前一个条形。 */
export type DeltaBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Category; tokens: number; off: number; color: string; node: SurfaceNode }

/** 某个条形相对前一个条形的变化，按符号拆分，因为图会把两者
 *  分别画在同一零线的上下。 */
export interface DnaDelta {
  up: DeltaBand[]
  down: DeltaBand[]
}

/** 按 **key**（而不是位置）配对两个条形的带：在 prompt 中位移过的带
 *  仍然报告同一项的增量，被移除的项则通过在后继中查找
 *  前驱丢失的键来定位。 */
export function deltaBandsOf(bands: TrendBand[], prev: TrendBand[] | null): DnaDelta {
  // 前驱为 null 即没有基线：该条不带变化，于是刻度由变化量驱动，
  // 而不会被开场上下文的体量钉死。
  if (prev === null) return { up: [], down: [] }
  const before = new Map(prev.map(b => [b.key, b.tokens] as const))
  const after = new Map(bands.map(b => [b.key, b.tokens] as const))
  const up: DeltaBand[] = []
  const down: DeltaBand[] = []
  for (const b of bands) {
    const d = b.tokens - (before.get(b.key) ?? 0)
    if (d <= 0) continue
    up.push('node' in b
      ? { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color, node: b.node }
      : { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color })
  }
  for (const b of prev) {
    const d = (after.get(b.key) ?? 0) - b.tokens
    if (d >= 0) continue
    down.push('node' in b
      ? { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color, node: b.node }
      : { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color })
  }
  let u = 0
  // `off` 在两个方向上都是从零线起的幅度：down 列表的 token
  // 为负，因此用减法累加才能保持为正。
  for (const x of up) { x.off = u; u += x.tokens }
  let dn = 0
  for (const x of down) { x.off = dn; dn -= x.tokens }
  return { up, down }
}

/** 两个 DNA 界面共用的紧凑项名：header 带给出 prompt 或工具 schema 名，消息带给出技能或工具名。 */
export function dnaBaseLabel(b: DnaItem | TrendBand | DeltaBand, t: Translate, catLabel: (key: string) => string): string {
  if (!('node' in b)) return b.cat === 'system' ? catLabel('system') : b.key.slice('tool:'.length)
  const n = b.node
  return n.skill !== undefined ? t('node.skillTag', { name: n.skill })
    : n.cat === 'tool' ? (n.tool ?? '?')
      : n.cat === 'inject' ? t('form.' + (n.form || 'context'))
        : catLabel(n.cat)
}
