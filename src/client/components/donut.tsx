/** 统计卡片的环状图：按比例的 SVG 分段（在 100 单位的周长上做 stroke-dasharray，
 * 与 agent graph 的环同一招），中间嵌一个 HTML 标签。相邻分段之间靠卡片自己的背景
 * 留出一缕极细的分隔（每段弧两端各自让出半个间隙）；值为零的分段跳过；
 * 全零的环渲染成一条中性轨道，
 * 这样卡片永远不会画出误导性的「100% 的空」。
 * 中心字号随环的尺寸缩放，所以标签总能装进细描边留出的那个洞里。
 * 挂载时各分段依次扫入，
 * 挂载时各分段依次扫入，从 12 点方向顺时针长出各自的弧线
 * （stats.css，各分段用下面那个 `--lc-i` 槽位错开）。 */

import { type CSSProperties, type ReactElement, type ReactNode } from 'react'

/** 两个分段之间那缕极细的分隔，以 dasharray 为单位（1 单位 ≈ 周长的 1%
 * ≈ 96px 卡片环上的 2.3px，因此读起来约 1px）。 */
const SEG_GAP = 0.5

/** 一个环分段：以 `value` 相对环自身的正总量按比例取长。 */
export interface DonutSegment {
  key: string
  color: string
  value: number
}

/** 环的输入。`centerTop`/`centerSub` 是洞里那个 HTML 标签——
 *  之所以保留为节点，是为了让调用方能传入已格式化的数字而环不必知道单位。 */
export interface DonutProps {
  segments: DonutSegment[]
  /** 中心那个大数字（一段时长、一个 token 数、一个百分比）。 */
  centerTop: ReactNode
  /** 中心数字下方的小字说明。 */
  centerSub?: ReactNode
  /** 外径（px，默认 118）。 */
  size?: number
  /** 被悬停的分段 key——图例行 ↔ 分段的悬停联动。 */
  hoverKey?: string | null
  /** 悬停中继；不传则环不响应。 */
  onHoverKey?: (key: string | null) => void
}

/**
 * 环状图：每个非零分段画一条 SVG 弧，外加一个字号随 `size` 缩放的中心标签，
 * 因此它总能装进细描边留出的洞里。一个正分段都没有时，
 * 环渲染成一条中性轨道，而不是空圆或满圆，
 * 因为总量为零时没有任何诚实的比例可画。
 */
export function Donut(props: DonutProps): ReactElement {
  const size = props.size ?? 118
  let total = 0
  for (const s of props.segments) {
    if (Number.isFinite(s.value) && s.value > 0) total += s.value
  }
  // 1 个 dasharray 单位 = 周长的 1%（r = 15.9155 → C ≈ 100）；
  // 每段从上一段结束处开始，+25 的偏移把第一段钉在 12 点方向。
  const arcs: { key: string; color: string; len: number; offset: number }[] = []
  let acc = 0
  if (total > 0) {
    for (const s of props.segments) {
      const v = Number.isFinite(s.value) && s.value > 0 ? s.value : 0
      if (v === 0) continue
      const pct = v / total * 100
      arcs.push({ key: s.key, color: s.color, len: pct, offset: 100 - acc + 25 })
      acc += pct
    }
  }
  // 分隔：两侧都有邻居时分段两端各让出半个间隙，
  // 于是靠卡片自己的背景把颜色分开。孤零零一个已上色的
  // 分段保留完整的一圈（那里留缺口看起来像被啃了一口），而切口绝不会
  // 超过细条的一半——否则那 0.2% 的溢出楔形会整块消失。
  if (arcs.length > 1) {
    for (const a of arcs) {
      const cut = Math.min(SEG_GAP / 2, a.len / 4)
      a.len -= cut * 2
      a.offset -= cut
    }
  }
  // 只有悬停落在已上色的弧上时环才变暗——
  // 没有分段对应的图例行（零值分段）不会让环起变化。
  const hovering = props.hoverKey !== null && props.hoverKey !== undefined
    && arcs.some(a => a.key === props.hoverKey)
  return (
    <div
      className={'lc-donut @max-[240px]/lc-card:mx-auto' + (hovering ? ' lc-donut-dim' : '')}
      style={{ width: size, height: size }}
      onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
    >
      <svg viewBox="0 0 42 42" width={size} height={size} aria-hidden="true">
        {arcs.length === 0
          ? <circle className="lc-donut-track fill-none stroke-4" cx="21" cy="21" r="15.9155" />
          : arcs.map((a, i) => (
            <circle
              key={a.key}
              className={'lc-donut-seg fill-none stroke-4 animate-lc-donut-in motion-reduce:animate-none' + (props.hoverKey === a.key ? ' lc-donut-seg-on' : '')}
              cx="21"
              cy="21"
              r="15.9155"
              strokeDasharray={`${a.len} ${100 - a.len}`}
              strokeDashoffset={a.offset}
              // 扫入错开槽位（stats.css 把 stroke-dasharray 从 0 100 动画到这些属性值，
              // 于是各分段从 12 点方向顺时针依次长出来）。
              // 描边内联在这里，是因为颜色是 CSS 变量，
              // 而 SVG 呈现属性无法承载 var()。
              style={{ '--lc-i': i, stroke: a.color } as CSSProperties}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(a.key) }}
            />
          ))}
      </svg>
      <div className="lc-donut-center">
        <b style={{ fontSize: Math.max(11, Math.round(size * 0.13)) }}>{props.centerTop}</b>
        {props.centerSub !== undefined
          ? <span style={{ fontSize: Math.max(9, Math.round(size * 0.105)) }}>{props.centerSub}</span>
          : null}
      </div>
    </div>
  )
}
