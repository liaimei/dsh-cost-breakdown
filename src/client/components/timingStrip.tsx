/**
 * 计时卡片的会话时间条：把 fold 画出的各个时间跨度（每个已完成步骤的 TTFT 等待、
 * 按流顺序排列的解码块、工具运行窗口，以及步骤内残余时间）按发生顺序
 * 首尾相接地压实——这条条带读的是「时间花在哪里」，而不是「何时」：
 * 每个带的宽度是它在会话累计活动时间中的占比（即环图的 Active Time），
 * 步骤之间的空闲时间完全不占轨道。这是把 DNA 那套手法用在时间消耗上。
 * 轴从 0 跑到总活动时间，其间有四分之一刻度（0、¼、½、¾、满）。
 * 悬停通过卡片的共享 hover key 把该时间跨度的种类传出去，
 * 所以同一类别的每个跨度都会与它的环图弧、图例行一起点亮
 * （DNA 那种按生命周期高亮的做法）；浮动的提示只响应条带自身的指针——
 * 来自图例/环图的镜像悬停只点亮对应的带，
 * 而不会在指针并不在其上的表面上再浮出第二个提示
 * （沿用堆叠条那条
 * 镜像规则）。
 *
 *
 * 生长扫入（共享的 stacked-in 动画令牌）只挂在带外层的唯一包裹层上，绝不挂在各个带
 * 自己身上：长会话会压实出成千上万个带，而逐带动画会把它们每一个都提升为
 * 独立的合成层（一场 Layerize 风暴，直接卡住卡片的展开）。包裹层上一次 transform
 * 只产生一个合成层，读起来就是一次自左向右的扫过；它所替代的逐带涟漪
 * 最多只有八个错开槽位，所以压实的条带本来就已经是一次扫过了。
 */

import { useState, type ReactElement } from 'react'
import type { TimingSpan } from '../../shared/types'
import type { ViewKit } from '../viewkit'

/** 条带的调色板，以时间跨度种类为键；`statsTiming.tsx` 复用它，
 *  好让同一类别在计时卡片的条带、环图与图例中保持同一个颜色。 */
export const TIMING_COLOR: Record<TimingSpan['kind'], string> = {
  ttft: 'var(--color-blue-500)',
  reasoning: 'var(--color-violet-500)',
  text: 'var(--color-pink-500)',
  toolarg: 'var(--color-amber-500)',
  tools: 'var(--color-teal-500)',
  other: 'var(--color-slate-400)',
}

/** 每种时间跨度在图例里的标签 key（计时卡片自己的词汇）。 */
const KIND_LABEL: Record<TimingSpan['kind'], string> = {
  ttft: 'timing.ttft',
  reasoning: 'timing.reasoning',
  text: 'timing.text',
  toolarg: 'timing.toolArgs',
  tools: 'timing.tools',
  other: 'timing.other',
}

/** 轴上固定的刻度分数：零、三个四分位，以及整段跨度。 */
const TICK_FRACS: readonly number[] = [0, 0.25, 0.5, 0.75, 1]

/** 条带上一个已定位的带，由一个净化后的时间跨度预先算好。 */
interface StripBand {
  key: number
  kind: TimingSpan['kind']
  leftPct: number
  widthPct: number
  /** 预格式化的悬停文本（'Tool runs 5.0s · 14:23:01'）。 */
  tip: string
}

/**
 * 绑定 `kit`，返回这条压实时间的条带。轴是累计「活动」时间而非墙钟：
 * 每个带的宽度是它时长在总量中的占比，空闲间隙不占轨道。
 * 净化后没有时间跨度幸存时返回 null，好让卡片丢掉整块，
 * 而不是画一条空轴。
 */
export function makeTimingStrip(kit: ViewKit): (props: {
  /** fold 画出的各时间跨度，按日志顺序排列（不可信——逐项重新校验）。 */
  spans: TimingSpan[]
  /** 被悬停的分段种类——带 ↔ 环图弧 ↔ 图例行的悬停联动。 */
  hoverKey?: string | null
  /** 悬停中继；不传则各带不响应。 */
  onHoverKey?: (key: string | null) => void
}) => ReactElement | null {
  const { t, fmtDuration, fmtTime } = kit
  return function TimingStrip(props: {
    spans: TimingSpan[]
    hoverKey?: string | null
    onHoverKey?: (key: string | null) => void
  }): ReactElement | null {
    // 条带自身的指针悬停：浮动提示只响应它。
    const [tipKey, setTipKey] = useState<number | null>(null)
    // 净化这份不可信集合：未知的种类，或无法使用/
    // 首尾颠倒的时刻，直接整条丢掉，而不是让轴被污染。
    const valid = props.spans.filter(s =>
      Object.hasOwn(TIMING_COLOR, s.kind)
      && Number.isFinite(s.start)
      && Number.isFinite(s.end)
      && s.end > s.start)
    if (valid.length === 0) return null
    // 轴的城域：0 → 会话的累计「活动」时间（各时间跨度
    // 按日志顺序无缝压实——它们之间的空闲时间不占轨道）。
    let total = 0
    for (const s of valid) total += s.end - s.start
    let cursor = 0
    const bands: StripBand[] = valid.map((s, i) => {
      const leftPct = cursor / total * 100
      cursor += s.end - s.start
      return {
        key: i,
        kind: s.kind,
        leftPct,
        widthPct: (s.end - s.start) / total * 100,
        tip: `${t(KIND_LABEL[s.kind])} ${fmtDuration(s.end - s.start)} · ${fmtTime(s.start)}`,
      }
    })
    const hoverKey = props.hoverKey
    const hovering = hoverKey !== null && hoverKey !== undefined && bands.some(b => b.kind === hoverKey)
    // 提示居中于它所属带渲染出的区间，两端各留出 10% 的内缩，好让细如发丝的带的提示留在卡片内。
    let tip: { text: string; leftPct: number } | null = null
    for (const b of bands) {
      if (b.key === tipKey) {
        tip = { text: b.tip, leftPct: Math.max(10, Math.min(b.leftPct + b.widthPct / 2, 90)) }
        break
      }
    }
    return (
      <div className="lc-tstrip" role="img" aria-label={t('timing.strip')}>
        <div className="lc-tstrip-wrap">
          <div
            className={'lc-tstrip-bar' + (hovering ? ' lc-tstrip-dim' : '')}
            onMouseLeave={() => {
              setTipKey(null)
              props.onHoverKey?.(null)
            }}
          >
            {/* 各个带挂在唯一的动画包裹层上：条带靠它那一次合成好的 transform
                自左向右擦开，而不是每个带各跑一次动画
                （见模块头注释）。 */}
            <div className="lc-tstrip-fill animate-lc-stacked-in motion-reduce:animate-none">
              {bands.map(b => (
                <div
                  key={b.key}
                  className={'lc-tstrip-seg' + (hoverKey === b.kind ? ' lc-tstrip-seg-on' : '')}
                  style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`, background: TIMING_COLOR[b.kind] }}
                  onMouseEnter={() => {
                    setTipKey(b.key)
                    props.onHoverKey?.(b.kind)
                  }}
                />
              ))}
            </div>
          </div>
          {/* 始终挂载（提示类只渐隐不透明度），所以离开时是淡出而不是立刻卸载。 */}
          <div
            className={'lc-tip lc-bar-tip' + (tip !== null ? ' lc-bar-tip-on' : '')}
            style={{ left: `${tip !== null ? tip.leftPct : 50}%` }}
          >{tip !== null ? tip.text : ''}</div>
        </div>
        <div className="lc-tstrip-axis">
          {TICK_FRACS.map((frac, i) => {
            const ms = total * frac
            return (
              <span
                key={frac}
                className={'lc-tstrip-tick' + (i === 0 ? ' lc-tstrip-tick-first' : i === TICK_FRACS.length - 1 ? ' lc-tstrip-tick-last' : '')}
                style={{ left: `${frac * 100}%` }}
              >{ms === 0 ? '0' : fmtDuration(ms)}</span>
            )
          })}
        </div>
      </div>
    )
  }
}
