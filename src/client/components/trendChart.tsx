import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type UIEvent } from 'react'
import type { Category, ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS } from '../categories'
import { deltaBandsOf, dnaBaseLabel } from '../dna'
import type { DnaDelta, TrendBand } from '../dna'
import { containHorizontalOverscroll } from '../overscroll'
import type { ViewKit } from '../viewkit'

/** 入场动画的类对，追加到当前模式所绘制的那个元素上。 */
const RISE_CLASS = ' animate-lc-bar-in motion-reduce:animate-none'

/** 只有最新的 `RISE_CAP` 列会播放生长动画：图表挂载时锚定在最新的柱子上，
 * 而给窗口左边的一切都加动画会让整张图分层化，并卡住卡片的展开。 */
export const RISE_CAP = 200

/** 趋势图的 props：请求日志、按下标与它对齐的边界标记，
 *  以及四个受控的选择中继。柱子几何在这里推导，绝不从外面传入。 */
export interface TrendChartProps {
  requests: RequestRecord[]
  markers: (ContextEventRecord | undefined)[]
  selectedSeq: number | null
  hoveredSeq: number | null
  activeTurn: number | null
  granularity: 'step' | 'turn'
  mode: 'total' | 'delta'
  focusTurn: number | null
  hoverCat: string | null
  /** 无法识别的 key（过期或恶意的 state）降级为未聚焦的图表。 */
  focusCat?: string | null
  adaptive?: boolean
  durationCurve?: boolean
  /** DNA 模式：每根柱子把它的组装上下文按读取顺序分解为每个条目一条带（dna.ts），
   * 并按下标与 `requests` 对齐。 */
  dna?: TrendBand[][] | null
  onPickBand?: (seq: number, band: { key: string; cat: Category | 'system' | 'tools' }) => void
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverTurn: (turn: number | null) => void
  onPickTurn: (turn: number) => void
  onFocusTurnHandled: () => void
}

/** 每轮一根柱子：同一轮的连续记录合并为它的「最后」一条记录（打上 `stepCount`），其 `activeMs` 是各步骤之和。 */
export function aggregateByTurn(requests: RequestRecord[]): RequestRecord[] {
  const out: RequestRecord[] = []
  let runSteps = 0
  let runActiveMs = 0
  let runHasActiveMs = false
  for (const req of requests) {
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && (last.turn ?? 0) === (req.turn ?? 0)) {
      runSteps++
      if (req.activeMs !== undefined) { runActiveMs += req.activeMs; runHasActiveMs = true }
      out[out.length - 1] = { ...req, stepCount: runSteps, ...(runHasActiveMs ? { activeMs: runActiveMs } : {}) }
    } else {
      runSteps = 1
      runActiveMs = req.activeMs ?? 0
      runHasActiveMs = req.activeMs !== undefined
      out.push({ ...req, stepCount: 1 })
    }
  }
  return out
}

/** 没有轮次戳的记录汇到 0 之下；取值器对列表之外的轮次回答 1，好让调用方永远不会落空。 */
export function turnStepsOf(requests: RequestRecord[]): (turn: number | undefined) => number {
  const counts = new Map<number, number>()
  for (const req of requests) {
    const turn = req.turn ?? 0
    counts.set(turn, (counts.get(turn) ?? 0) + 1)
  }
  return turn => counts.get(turn ?? 0) ?? 1
}

/** 每个边界事件（compaction/prune）挂在它之后记录的第一条请求上；与明细
 * 面板共享，所以两者显示的是「同一个」事件。 */
export function attachMarkers(requests: RequestRecord[], events: ContextEventRecord[]): (ContextEventRecord | undefined)[] {
  const markers: (ContextEventRecord | undefined)[] = new Array<ContextEventRecord | undefined>(requests.length)
  for (const ev of events) {
    if (ev.kind !== 'compaction' && ev.kind !== 'prune') continue
    for (let r = 0; r < requests.length; r++) {
      if (requests[r].seq >= ev.seq) {
        if (markers[r] === undefined) markers[r] = ev
        break
      }
    }
  }
  return markers
}

/** 聊天→Context 跳转的目标：被点击的那条收尾回复所属的轮次柱（中继过来的 seq 是一轮的「最后」
 * 一步），或者在该轮已老去之后用最老的保留柱。只有历史为空时才返回 null。 */
export function jumpTargetOf(requests: RequestRecord[], seq: number): RequestRecord | null {
  for (const req of requests) if (req.seq === seq) return req
  return requests.length > 0 ? requests[0] : null
}

/**
 * 绑定 `kit`，返回这张图。返回的组件是一个 memo 过的柱子列表加
 * 一趟由滚动驱动的测量：凡是身份必须在悬停中存活的（柱子
 * 组件、聚合出来的记录）都在这里只建一次，下面每次渲染的工作
 * 被刻意限制为自适应刻度所需要的那部分。
 */
export function makeTrendChart(kit: ViewKit): (props: TrendChartProps) => ReactElement {
  const { t, fmt, fmtDuration, eventLabel, eventAt, catLabel } = kit

  const CHART_H = 112
  // 与 trendChart.css 里的 .lc-axis-q1/.lc-axis-q3 相镜像：图表顶部 18 + 112px 柱区的
  // 四分之一/四分之三 − 11px 标签盒的一半。
  const Q3_TOP = 41
  const Q1_TOP = 97
  const fmtSigned = (v: number): string => (v > 0 ? '+' : '') + fmt(v)
  // 柱宽恒定（下面的轮次带镜像同一套列网格）：密集的历史靠滚动，而不是压缩。
  const BAR_W = 14
  const BAR_GAP = 2
  const STAGGER_CAP = 20
  const STEP_FLAG_EVERY = 5
  // 中性的斑马纹，刻意与类别调色板「不相交」：这条带是一层分区，不是柱子的一个分段。
  const TURN_FILLS = [
    'color-mix(in srgb, var(--color-neutral-500) 12%, transparent)',
    'color-mix(in srgb, var(--color-neutral-500) 26%, transparent)',
  ]
  // 标签按自然宽度渲染并溢出自己的块：下面的对间隙定尺会把它们「全部」统一收缩，
  // 而 updateTurnLabels 里那条测量链是最后一道兜底。OVERHANG 界定一个标签能够到的范围；GAP 是盒间间隙。
  const LABEL_OVERHANG = 48
  const LABEL_GAP = 2
  // 10px 基准镜像 trendChart.css 里的 .lc-turn；每个数字 6.5px 是该字号下的保守上界，下限取 6px。
  const LABEL_FONT = 10
  const LABEL_FONT_MIN = 6
  const estTurnLabel = (turn: number): number => 6.5 * String(turn).length

  /** 聚焦某个类别：保留的分桶携带它的 fold 数字，而 `total` 就是被绘制的数字。原始 fold 数字
   * 原样绘制——按 provider 的 prompt 重新缩放会随启发式的误差漂移，造出虚假的增长。 */
  const focusOf = (req: RequestRecord, cat: string): RequestRecord => {
    const key = cat as Category | 'system' | 'tools'
    const out: RequestRecord = { ...req }
    const v = req[key] || 0
    out.total = v
    for (const c of CATS) out[c.key] = c.key === key ? v : 0
    return out
  }

  /** 增量模式：每个类别保留相对上一条记录的「带符号」变化；`total` 是变动量（各绝对值之和），
   * `net` 则是提示里用的带符号变化。provider 的 prompt/output 被丢掉——它们不是增量。 */
  const deltaOf = (req: RequestRecord, prev: RequestRecord | null): RequestRecord => {
    const { prompt: _prompt, output: _output, ...out } = req
    let churn = 0
    let net = 0
    for (const c of CATS) {
      const d = prev !== null ? (req[c.key] || 0) - (prev[c.key] || 0) : 0
      out[c.key] = d
      churn += Math.abs(d)
      net += d
    }
    out.total = churn
    out.net = net
    return out
  }

  interface VisibleMax {
    total: number
    up: number
    down: number
    activeMs: number
  }

  interface ChartBarProps {
    req: RequestRecord
    marker: ContextEventRecord | undefined
    selected: boolean
    hovered: boolean
    inTurn: boolean
    maxTotal: number
    /** 增量模式的几何量以「原始值」形式给出（memo 过的柱子靠浅比较退让）：零线偏移（px）以及
     * 两条臂共用的每 token 一像素的刻度。 */
    upPx?: number
    downPx?: number
    deltaScale?: number
    enterIndex: number
    rise: boolean
    flag: number | null
    dna: TrendBand[] | null
    dnaDelta: DnaDelta | null
    dnaScale: number | undefined
    zeroBottom: number | undefined
    onDnaHit: (key: string | null) => void
    onPickBand?: (seq: number, band: { key: string; cat: Category | 'system' | 'tools' }) => void
    onSelect: (seq: number | null) => void
    onHover: (seq: number | null) => void
  }

  /** DNA 柱子内部：单个渐变 div，同色各带合并（长串会把 style 字符串撑大），
   * 零 token 的带跳过。 */
  interface DnaBarProps {
    bands: TrendBand[]
    total: number
    maxTotal: number
    enterIndex: number
    rise: boolean
    seq: number
    onHit: (key: string | null) => void
    onPick?: (seq: number, band: TrendBand) => void
  }

  const DnaBar = function DnaBar(props: DnaBarProps): ReactElement | null {
    const visible: TrendBand[] = []
    for (const b of props.bands) if (b.tokens > 0) visible.push(b)
    if (visible.length === 0) return null
    const runs: { color: string; from: number; to: number }[] = []
    for (const b of visible) {
      const from = Math.round(b.off / props.total * 10000) / 100
      const to = Math.round((b.off + b.tokens) / props.total * 10000) / 100
      const last = runs.length > 0 ? runs[runs.length - 1] : null
      if (last !== null && last.color === b.color && last.to === from) last.to = to
      else runs.push({ color: b.color, from, to })
    }
    // 命中必然存在（第一个可见带从 off 0 开始；小数被夹住），所以类型里没有 null。
    const hitAt = (e: { clientY: number; currentTarget: HTMLDivElement }): TrendBand => {
      const rect = e.currentTarget.getBoundingClientRect()
      const frac = rect.height > 0 ? Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height)) : 0
      const pos = frac * props.total
      let hit = visible[0]
      for (const b of props.bands) {
        if (b.off > pos) break
        if (b.tokens > 0) hit = b
      }
      return hit
    }
    return (
      <div
        className={'lc-bar-dna' + (props.rise ? RISE_CLASS : '')}
        style={{
          height: `${Math.max(1, Math.round(props.total / props.maxTotal * CHART_H))}px`,
          background: 'linear-gradient(to top, ' + runs.map(r => `${r.color} ${r.from}%, ${r.color} ${r.to}%`).join(', ') + ')',
          '--lc-i': Math.min(props.enterIndex, STAGGER_CAP),
        } as CSSProperties}
        onMouseMove={(e) => { props.onHit(hitAt(e).key) }}
        onMouseLeave={() => { props.onHit(null) }}
        onClick={(e) => {
          if (props.onPick !== undefined) props.onPick(props.seq, hitAt(e))
        }}
      />
    )
  }

  /** DNA + 增量的柱子内部：单个渐变 div 横跨两条臂——下行臂的各带按读取顺序「倒序」，然后是上行臂。 */
  interface DnaDeltaBarProps {
    d: DnaDelta
    scale: number
    zeroBottom: number
    enterIndex: number
    rise: boolean
    seq: number
    onHit: (key: string | null) => void
    onPick?: (seq: number, band: { key: string; cat: Category | 'system' | 'tools' }) => void
  }

  const DnaDeltaBar = function DnaDeltaBar(props: DnaDeltaBarProps): ReactElement | null {
    let upSum = 0
    for (const b of props.d.up) upSum += b.tokens
    let downSum = 0
    for (const b of props.d.down) downSum -= b.tokens
    const gradSpan = upSum + downSum
    if (gradSpan === 0) return null
    const runs: { color: string; from: number; to: number }[] = []
    const pushRun = (color: string, mag: number, at: number): number => {
      const from = Math.round(at / gradSpan * 10000) / 100
      const to = Math.round((at + mag) / gradSpan * 10000) / 100
      const last = runs.length > 0 ? runs[runs.length - 1] : null
      if (last !== null && last.color === color && last.to === from) last.to = to
      else runs.push({ color, from, to })
      return at + mag
    }
    let acc = 0
    for (let i = props.d.down.length - 1; i >= 0; i--) acc = pushRun(props.d.down[i].color, -props.d.down[i].tokens, acc)
    for (const b of props.d.up) acc = pushRun(b.color, b.tokens, acc)
    const height = Math.max(1, Math.round(gradSpan * props.scale))
    const hitAt = (e: { clientY: number; currentTarget: HTMLDivElement }): { key: string; cat: Category | 'system' | 'tools' } => {
      const rect = e.currentTarget.getBoundingClientRect()
      const frac = rect.height > 0 ? Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height)) : 0
      const pos = frac * gradSpan - downSum
      const useUp = pos >= 0 && props.d.up.length > 0
      const arm = useUp ? props.d.up : props.d.down
      const p = useUp ? pos : -pos
      let hit = arm[0]
      for (const b of arm) {
        if (b.off > p) break
        hit = b
      }
      return hit
    }
    return (
      <div
        className={'lc-bar-dna' + (props.rise ? RISE_CLASS : '')}
        style={{
          position: 'absolute',
          bottom: `${Math.round(props.zeroBottom - downSum * props.scale)}px`,
          height: `${height}px`,
          background: 'linear-gradient(to top, ' + runs.map(r => `${r.color} ${r.from}%, ${r.color} ${r.to}%`).join(', ') + ')',
          // 入场上升从零线长出，而不是从某条臂的末端。
          transformOrigin: `50% ${Math.round(downSum / gradSpan * 10000) / 100}%`,
          '--lc-i': Math.min(props.enterIndex, STAGGER_CAP),
        } as CSSProperties}
        onMouseMove={(e) => { props.onHit(hitAt(e).key) }}
        onMouseLeave={() => { props.onHit(null) }}
        onClick={(e) => { if (props.onPick !== undefined) props.onPick(props.seq, hitAt(e)) }}
      />
    )
  }

  /** 跨柱的生命周期高亮：一行弹性布局镜像柱网格，每根仍然持有被悬停条目的柱子出一片；做了 memo。 */
  interface DnaHighlightsProps {
    slices: ({ bottom: number; height: number } | null)[] | null
  }

  const DnaHighlights = memo(function DnaHighlights(props: DnaHighlightsProps): ReactElement | null {
    if (props.slices === null) return null
    return (
      <div className="lc-dna-hl">
        {props.slices.map((s, i) => (
          <span key={i} className="lc-dna-cell">
            {s !== null ? (
              <span className="lc-dna-slice" style={{ bottom: `${s.bottom}px`, height: `${s.height}px` }} />
            ) : null}
          </span>
        ))}
      </div>
    )
  })

  // 做了 memo，好让一次悬停/选中变化只重渲染那些标志翻转的柱子（保留的日志会整体渲染）；
  // `req`/`marker` 保持稳定身份，因为父级 memo 了它的聚合，所以默认的浅比较就够。
  const ChartBar = memo(function ChartBar(props: ChartBarProps): ReactElement {
    const { req, marker } = props
    const markerAt = marker !== undefined ? eventAt(marker) : null
    const diverge = props.upPx !== undefined && props.downPx !== undefined && props.deltaScale !== undefined
    const enterStyle = { '--lc-i': Math.min(props.enterIndex, STAGGER_CAP) } as CSSProperties
    const riseCls = props.rise ? RISE_CLASS : ''
    return (
      <div
        className={'lc-bar hover:bg-(--dsw-alias-bg-layer-2)'
          + (props.selected ? ' lc-bar-selected' : '')
          + (props.hovered ? ' lc-bar-hovered' : '')
          + (props.inTurn ? ' lc-bar-in-turn' : '')}
        data-seq={req.seq}
        style={{ width: `${BAR_W}px` }}
        onClick={() => { props.onSelect(props.selected ? null : req.seq) }}
        onMouseEnter={() => { props.onHover(req.seq) }}
      >
        {props.flag !== null ? (
          // 画在 ✂ 标记「下面」（后者在 DOM 顺序上更靠后）：罕见的同柱冲突时，
          // 事件图形优先于地标。
          <span className="lc-step-flag" aria-hidden="true"><span className="lc-step-flag-label">{props.flag}</span></span>
        ) : null}
        {marker !== undefined ? (
          <span
            className="lc-bar-marker"
            title={'✂ ' + (markerAt !== null ? markerAt + ' — ' : '') + eventLabel(marker)}
          >{'✂'}</span>
        ) : null}
        {props.dna !== null ? (
          props.dnaDelta !== null && props.dnaScale !== undefined && props.zeroBottom !== undefined ? (
            <DnaDeltaBar
              d={props.dnaDelta}
              scale={props.dnaScale}
              zeroBottom={props.zeroBottom}
              enterIndex={props.enterIndex}
              rise={props.rise}
              seq={req.seq}
              onHit={props.onDnaHit}
              onPick={props.onPickBand}
            />
          ) : (
            <DnaBar
              bands={props.dna}
              total={req.total}
              maxTotal={props.maxTotal}
              enterIndex={props.enterIndex}
              rise={props.rise}
              seq={req.seq}
              onHit={props.onDnaHit}
              onPick={props.onPickBand}
            />
          )
        ) : diverge ? (
          <>
            <div className={'lc-bar-up' + riseCls} style={{ bottom: `${props.downPx}px`, ...enterStyle }}>
              {CATS.map((c) => {
                const d = req[c.key] || 0
                if (d <= 0) return null
                return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(d * (props.deltaScale as number)))}px`, background: c.color }} />
              })}
            </div>
            <div className={'lc-bar-down' + riseCls} style={{ top: `${props.upPx}px`, ...enterStyle }}>
              {CATS.map((c) => {
                const d = req[c.key] || 0
                if (d >= 0) return null
                return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(-d * (props.deltaScale as number)))}px`, background: c.color }} />
              })}
            </div>
          </>
        ) : (
          <div className={'lc-bar-stack' + riseCls} style={enterStyle}>
            {CATS.map((c) => {
              const v = req[c.key] || 0
              if (!v) return null
              // 用 px（而不是 %）定高：这个堆叠由内容决定，百分比高度会在不确定的基上塌掉。
              return <div key={c.key} data-cat={c.key} className="lc-cat-seg" style={{ height: `${Math.max(1, Math.round(v / props.maxTotal * CHART_H))}px`, background: c.color }} />
            })}
          </div>
        )}
      </div>
    )
  })

  return function TrendChart(props: TrendChartProps): ReactElement {
    const dnaBands = props.dna ?? null
    const dnaOn = dnaBands !== null
    const delta = props.mode === 'delta'
    const dnaDeltaOn = dnaOn && delta
    const durationOn = props.durationCurve === true
    // 无法识别的聚焦 key 降级为未聚焦的图表，而不是画一条空轴。
    const focus = !dnaOn && props.focusCat !== null && props.focusCat !== undefined && CATS.some(c => c.key === props.focusCat)
      ? props.focusCat
      : null
    const [dnaHit, setDnaHit] = useState<string | null>(null)
    // 每根柱子的各带与上一根柱子按 key 配对（dna.ts），并按下标与 `requests` 对齐；
    // 第一根柱子不携带任何变化。
    const dnaDeltas = useMemo(
      () => (dnaDeltaOn ? dnaBands.map((bands, i) => deltaBandsOf(bands, i > 0 ? dnaBands[i - 1] : null)) : null),
      [dnaDeltaOn, dnaBands],
    )
    const requests = useMemo(
      () => {
        const base = focus !== null ? props.requests.map(req => focusOf(req, focus)) : props.requests
        return delta ? base.map((req, i) => deltaOf(req, i > 0 ? base[i - 1] : null)) : base
      },
      [props.requests, delta, focus],
    )
    const markers = props.markers
    // 屏幕上各柱子的最大值；第一次测量之前为 null，那时退回整份日志的刻度，所以
    // 首帧绝不会画出空轴，而在一个未变动的窗口内滚动也什么都不重渲染。
    const adaptive = props.adaptive === true
    const [visMax, setVisMax] = useState<VisibleMax | null>(null)
    const measureVisible = (el: HTMLDivElement): void => {
      if (!adaptive) return
      const n = requests.length
      // 量不出任何东西（空历史、零宽视口）：保留上一个刻度，而不是把所有柱子压平。
      if (n === 0 || el.clientWidth <= 0) return
      const pitch = BAR_W + BAR_GAP
      const sl = el.scrollLeft
      const vr = sl + el.clientWidth
      let total = 0
      let up = 0
      let down = 0
      let activeMs = 0
      const from = Math.max(0, Math.floor(sl / pitch))
      const to = Math.min(n - 1, Math.max(from, Math.floor((vr - 1) / pitch)))
      for (let i = from; i <= to; i++) {
        const col = i * pitch
        if (col >= vr || col + BAR_W <= sl) continue
        const req = requests[i]
        // 时长叠加层的窗口峰值走同一趟测量，无论叠加层是否开启都测
        // （所以开启开关时绝不会重新测量）。
        const m = req.activeMs ?? 0
        if (m > activeMs) activeMs = m
        if (dnaDeltaOn && dnaDeltas !== null) {
          let bu = 0
          let bd = 0
          for (const b of dnaDeltas[i].up) bu += b.tokens
          for (const b of dnaDeltas[i].down) bd -= b.tokens
          if (bu > up) up = bu
          if (bd > down) down = bd
        } else if (delta) {
          let bu = 0
          let bd = 0
          for (const c of CATS) {
            const d = req[c.key] || 0
            if (d > 0) bu += d
            else bd -= d
          }
          if (bu > up) up = bu
          if (bd > down) down = bd
        } else if (req.total > total) {
          total = req.total
        }
      }
      setVisMax(prev => prev !== null && prev.total === total && prev.up === up && prev.down === down && prev.activeMs === activeMs
        ? prev
        : { total, up, down, activeMs })
    }
    // 整份日志的最大值：自适应关闭时的轴，以及窗口内毫无变化时增量回退用的刻度。
    let maxTotal = 1
    let maxUp = 0
    let maxDown = 0
    if (dnaDeltaOn && dnaDeltas !== null) {
      for (const d of dnaDeltas) {
        let up = 0
        let down = 0
        for (const b of d.up) up += b.tokens
        for (const b of d.down) down -= b.tokens
        if (up > maxUp) maxUp = up
        if (down > maxDown) maxDown = down
      }
    } else if (delta) {
      for (const req of requests) {
        let up = 0
        let down = 0
        for (const c of CATS) {
          const d = req[c.key] || 0
          if (d > 0) up += d
          else down -= d
        }
        if (up > maxUp) maxUp = up
        if (down > maxDown) maxDown = down
      }
    } else {
      for (const req of requests) {
        if (req.total > maxTotal) maxTotal = req.total
      }
    }
    if (adaptive && visMax !== null) {
      if (delta) {
        if (visMax.up + visMax.down > 0) {
          maxUp = visMax.up
          maxDown = visMax.down
        }
      } else {
        maxTotal = Math.max(1, visMax.total)
      }
    }
    // 右侧轴与模式无关（曲线画的是原始活动时间）：默认取整份日志，
    // 自适应时取可见窗口的最大值。
    let maxActiveMs = 0
    if (durationOn) {
      for (const req of requests) {
        const m = req.activeMs ?? 0
        if (m > maxActiveMs) maxActiveMs = m
      }
      if (adaptive && visMax !== null) maxActiveMs = visMax.activeMs
    }
    // 没有 `activeMs` 的柱子会断开这条折线，而不是伪造一个值；孤立的单点需要画一个圆点——
    // 单点折线渲染出来是看不见的。
    const durationRuns: string[] = []
    const durationDots: [number, number][] = []
    if (durationOn) {
      const scale = CHART_H / Math.max(1, maxActiveMs)
      let run: [number, number][] = []
      const flushRun = (): void => {
        if (run.length >= 2) durationRuns.push(run.map(p => `${p[0]},${p[1]}`).join(' '))
        else if (run.length === 1) durationDots.push(run[0])
        run = []
      }
      for (let i = 0; i < requests.length; i++) {
        const m = requests[i].activeMs
        if (m === undefined) {
          flushRun()
          continue
        }
        run.push([i * (BAR_W + BAR_GAP) + BAR_W / 2, Math.round((CHART_H - m * scale) * 100) / 100])
      }
      flushRun()
    }
    // 零线按较大一侧「按比例」切分柱区，所以零线上下每 token 的像素数完全相同。
    const span = Math.max(1, maxUp + maxDown)
    const deltaScale = CHART_H / span
    const upPx = Math.round(maxUp * deltaScale)
    const downPx = CHART_H - upPx
    // 当增量的四分之一刻度其 11px 标签盒会与零标签重叠时，它整体让位；总模式的刻度则总会渲染。
    const q3Clear = Math.abs(Q3_TOP - 13 - upPx) >= 11
    const q1Clear = Math.abs(Q1_TOP - 13 - upPx) >= 11

    // `span` 统计该组覆盖的步骤列数（每条步骤记录算一列），所以带块在两种粒度下
    // 都与柱子对齐。
    const groups: { turn: number; count: number; span: number; agg: boolean }[] = []
    for (const req of requests) {
      let grp = groups.length > 0 ? groups[groups.length - 1] : null
      if (grp === null || grp.turn !== (req.turn ?? 0)) {
        grp = { turn: req.turn ?? 0, count: 0, span: 0, agg: req.stepCount !== undefined }
        groups.push(grp)
      }
      grp.count++
      grp.span += req.stepCount ?? 1
    }

    // 以内容 px 计算，好让滚动处理函数能解析地重新居中标签，并只测量屏幕上的标签。
    const turnOffsets: number[] = []
    const turnWidths: number[] = []
    {
      let x = 0
      for (const grp of groups) {
        const w = grp.agg ? BAR_W : grp.span * (BAR_W + BAR_GAP) - BAR_GAP
        turnOffsets.push(x)
        turnWidths.push(w)
        x += w + BAR_GAP
      }
    }

    const riseFrom = Math.max(0, requests.length - RISE_CAP)

    // 统一尺寸（不是逐标签），且只由分组算出，所以尺寸绝不混用，滚动时数值也保持稳定。
    let labelFont = ''
    {
      let scale = 1
      for (let i = 0; i + 1 < groups.length; i++) {
        const avail = (turnWidths[i] + turnWidths[i + 1]) / 2 + BAR_GAP
        const need = (estTurnLabel(groups[i].turn) + estTurnLabel(groups[i + 1].turn)) / 2 + LABEL_GAP
        if (need > avail) scale = Math.min(scale, avail / need)
      }
      if (scale < 1) labelFont = `${Math.max(LABEL_FONT_MIN, Math.floor(LABEL_FONT * scale))}px`
    }

    const scrollRef = useRef<HTMLDivElement | null>(null)
    const scrolledOnce = useRef(false)
    const lastGranRef = useRef(props.granularity)
    // 布局 effect 只在右边缘真的移动时重跑；悬停/选中变化保留各自的滚动位置。
    const lastSeqRef = useRef(0)
    // 上一趟 effect 的 scrollWidth：等布局 effect 运行时，`el.scrollWidth` 已经是新的、
    // 更宽的值，所以拿它做近边缘判断会漏掉自动跟随。
    const prevScrollWidthRef = useRef(0)
    // 为悬停路径缓存视口宽度/滚动偏移：在 syncTip 里读 clientWidth/scrollLeft 会强制同步
    // 刷新这次提交刚刚弄脏的一切。提交 effect、滚动处理函数与尺寸观察器都会刷新它们。
    const cwRef = useRef(0)
    const slRef = useRef(0)
    /** 把每个轮次标签居中于它所在块的可见切片内，然后抽稀相互碰撞的标签；先批量读再写。 */
    const updateTurnLabels = (el: HTMLDivElement): void => {
      const labels = el.querySelectorAll<HTMLElement>('.lc-turn-label')
      const n = Math.min(labels.length, turnOffsets.length)
      const sl = el.scrollLeft
      const vr = sl + el.clientWidth
      const writes: [HTMLElement, string, string][] = []
      let chainR = -Infinity
      for (let i = 0; i < n; i++) {
        const off = turnOffsets[i]
        const w = turnWidths[i]
        let dx = 0
        let vis = ''
        if (off + w + LABEL_OVERHANG > sl && off - LABEL_OVERHANG < vr) {
          const lw = labels[i].offsetWidth
          const visL = Math.max(off, sl)
          const visR = Math.min(off + w, vr)
          if (visR > visL && lw < w) {
            const center = (visL + visR) / 2 - off
            dx = Math.min(Math.max(center, lw / 2), w - lw / 2) - w / 2
          }
          const left = off + w / 2 + dx - lw / 2
          if (left < chainR) vis = 'hidden'
          else chainR = left + lw + LABEL_GAP
        }
        const next = dx !== 0 ? `translateX(${dx}px)` : ''
        if (labels[i].style.transform !== next || labels[i].style.visibility !== vis) writes.push([labels[i], next, vis])
      }
      for (const [label, next, vis] of writes) {
        label.style.transform = next
        label.style.visibility = vis
      }
    }
    useLayoutEffect(() => {
      const el = scrollRef.current
      /* 滚动 div 无条件渲染，而 React
         在布局 effect 运行之前挂上 ref；这里 el 永远不是 null。 */
      if (el === null) return
      const newestSeq = requests.length === 0 ? 0 : requests[requests.length - 1].seq
      const grew = newestSeq !== lastSeqRef.current
      const widthBeforeAppend = prevScrollWidthRef.current
      if (props.granularity !== lastGranRef.current) {
        lastGranRef.current = props.granularity
        scrolledOnce.current = false
      }
      // 被条带点击聚焦的轮次会把它的柱子居中，而不是锚定到最新处；这通过 onFocusTurnHandled 一次性消费。
      if (props.focusTurn !== null) {
        const gi = groups.findIndex(g => g.turn === props.focusTurn)
        if (gi >= 0) {
          scrolledOnce.current = true
          el.scrollLeft = Math.max(0, gi * (BAR_W + BAR_GAP) + BAR_W / 2 - el.clientWidth / 2)
        }
        props.onFocusTurnHandled()
      } else if (!scrolledOnce.current) {
        scrolledOnce.current = true
        el.scrollLeft = el.scrollWidth
      } else if (grew && el.scrollLeft + el.clientWidth >= widthBeforeAppend - 24) {
        el.scrollLeft = el.scrollWidth
      }
      lastSeqRef.current = newestSeq
      prevScrollWidthRef.current = el.scrollWidth
      slRef.current = el.scrollLeft
      cwRef.current = el.clientWidth
      updateTurnLabels(el)
      syncTip(el)
      measureVisible(el)
      // DNA↔堆叠或 total↔delta 的切换会改变窗口峰值的含义，所以重新测量，而不是沿着过期的自适应刻度走。
    }, [props.granularity, props.focusTurn, requests, adaptive, dnaDeltaOn])

    // 观察器需要「最新」的测量闭包（它捕获了 `requests`/`delta`）；用 ref 保持它是新的，
    // 而不必拆掉观察器。
    const measureRef = useRef(measureVisible)
    useLayoutEffect(() => { measureRef.current = measureVisible })
    // 窗格尺寸变化会在没有任何渲染的情况下改变可见窗口，所以由观察器重新测量；jsdom 不提供 ResizeObserver。
    useLayoutEffect(() => {
      const el = scrollRef.current
      /* 滚动 div 无条件渲染，而 React
         在布局 effect 运行之前挂上 ref；这里 el 永远不是 null。 */
      if (el === null) return
      if (typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(() => { cwRef.current = el.clientWidth; measureRef.current(el) })
      observer.observe(el)
      return () => { observer.disconnect() }
    }, [])
    // 横向滑动跑出图表边缘时，绝不能链接进浏览器的历史导航（overscroll.ts 覆盖 WebKit）。
    useLayoutEffect(() => {
      const el = scrollRef.current
      /* 滚动 div 无条件渲染，而 React
         在布局 effect 运行之前挂上 ref；这里 el 永远不是 null。 */
      if (el === null) return
      return containHorizontalOverscroll(el)
    }, [])

    const stepsOf = useMemo(() => turnStepsOf(props.requests), [props.requests])
    const hoveredIdx = props.hoveredSeq !== null ? requests.findIndex(r => r.seq === props.hoveredSeq) : -1
    const hoveredReq = hoveredIdx >= 0 ? requests[hoveredIdx] : null
    const hoveredBands = dnaOn && !dnaDeltaOn && hoveredIdx >= 0 ? dnaBands[hoveredIdx] : null
    const hitBand = hoveredBands !== null && dnaHit !== null
      ? hoveredBands.find(b => b.key === dnaHit && b.tokens > 0) ?? null
      : null
    const hoveredDelta = dnaDeltaOn && hoveredIdx >= 0 && dnaDeltas !== null
      ? dnaDeltas[hoveredIdx].up.find(b => b.key === dnaHit) ?? dnaDeltas[hoveredIdx].down.find(b => b.key === dnaHit) ?? null
      : null
    const dnaSlices = useMemo(() => {
      if (!dnaOn || dnaHit === null) return null
      const slices: ({ bottom: number; height: number } | null)[] = []
      if (dnaDeltaOn && dnaDeltas !== null) {
        for (const d of dnaDeltas) {
          const hit = d.up.find(b => b.key === dnaHit) ?? d.down.find(b => b.key === dnaHit) ?? null
          if (hit === null) { slices.push(null); continue }
          // 上行臂的切片从零线升起，下行臂的切片挂在它下面（`off` 是从零线算起的累计幅值）。
          const mag = Math.abs(hit.tokens)
          const edge = hit.tokens > 0
            ? downPx + hit.off * deltaScale
            : downPx - (hit.off + mag) * deltaScale
          slices.push({ bottom: Math.round(edge), height: Math.max(1, Math.round(mag * deltaScale)) })
        }
      } else {
        for (const bands of dnaBands) {
          const hit = bands.find(b => b.key === dnaHit && b.tokens > 0) ?? null
          slices.push(hit === null ? null : {
            bottom: Math.round(hit.off / maxTotal * CHART_H),
            height: Math.max(1, Math.round(hit.tokens / maxTotal * CHART_H)),
          })
        }
      }
      return slices
    }, [dnaOn, dnaHit, dnaDeltaOn, dnaDeltas, dnaBands, downPx, deltaScale, maxTotal])
    const tipRowsOf = (req: RequestRecord): string[] => {
      const n = req.stepCount ?? 1
      const head = props.granularity === 'turn'
        ? (n > 1 ? t('tip.turn', { t: req.turn ?? 0, n }) : t('tip.turn1', { t: req.turn ?? 0 }))
        : t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0, n: stepsOf(req.turn) })
      // DNA 模式：指标行点出被悬停的条目；悬停在柱子的内边距上则落到模式自己的那一行。
      const band = hitBand ?? hoveredDelta
      let metric: string
      if (band !== null) {
        metric = t('trend.dnaItem', { label: dnaBaseLabel(band, t, catLabel), n: dnaDeltaOn ? fmtSigned(band.tokens) : fmt(band.tokens) })
      } else if (delta) {
        /* 增量模式只接收来自 deltaOf 的记录，
           而它总会赋值 net；这个兜底纯属防御。 */
        metric = t('tip.delta', { n: fmtSigned(req.net ?? 0) })
      } else {
        // 聚焦时：指标行「就是」被聚焦类别的数字，所以提示点名它，而不是声称一个总量。
        metric = focus !== null
          ? t('tip.cat', { cat: catLabel(focus), n: fmt(req.total) })
          : t('tip.total', { n: fmt(req.total) })
      }
      const rows = [head, metric]
      if (durationOn && req.activeMs !== undefined) rows.push(t('tip.duration', { n: fmtDuration(req.activeMs) }))
      return rows
    }

    const tipColRef = useRef(0)

    /** 把悬停提示粘到它所属柱子的可见切片上。提示刻意「不」住在滚动内容里面：
     * 滚动容器的绝对定位子节点会计入它的可滚动溢出，所以一个很宽的提示会把滚动条抖出来。
     */
    const syncTip = (el: HTMLDivElement): void => {
      /* 滚动 div 在挂载期间无条件渲染，所以它的父级存在。 */
      const tip = (el.parentElement ?? document.body).querySelector<HTMLElement>('.lc-chart-tip')
      if (tip === null) return
      const lw = tip.offsetWidth
      const cw = cwRef.current
      // 居中于柱子的可见切片之上，并夹进视口；比视口还宽的提示则在视口上居中。
      const half = Math.min(lw / 2, cw / 2)
      const cx = Math.min(Math.max(tipColRef.current - slRef.current, half), cw - half)
      const next = `translate(${Math.round(cx - lw / 2)}px, 0)`
      if (tip.style.transform !== next) tip.style.transform = next
    }

    // 每次提交后重新定位（提示在悬停变化时挂载，那不会碰这里其他依赖）后再绘制；
    // 所有文档级读取都走缓存好的 ref，所以一次无关提交是一趟不写任何东西的便宜操作。
    useLayoutEffect(() => {
      /* 滚动 div 无条件渲染，而 React 在布局 effect 运行之前
         挂上 ref；这里 el 永远不是 null。 */
      if (scrollRef.current === null) return
      tipColRef.current = hoveredIdx >= 0 ? hoveredIdx * (BAR_W + BAR_GAP) + BAR_W / 2 : 0
      syncTip(scrollRef.current)
    })

    return (
      <div className="lc-chartrow">
        <div className="lc-axis">
          {delta ? (
            <>
              <span className="lc-axis-top">{fmtSigned(maxUp)}</span>
              {q3Clear
                ? <span className="lc-axis-q3">{fmtSigned(Math.round(maxUp - span / 4))}</span>
                : null}
              {/* 0 那个标签骑在零线上（图表顶部内边距 18px，再上移 11px 行高的一半）。 */}
              <span className="lc-axis-mid" style={{ top: `${13 + upPx}px` }}>{'0'}</span>
              {q1Clear
                ? <span className="lc-axis-q1">{fmtSigned(Math.round(maxUp - 3 * span / 4))}</span>
                : null}
              <span className="lc-axis-bot">{fmtSigned(-maxDown)}</span>
            </>
          ) : (
            <>
              <span className="lc-axis-top">{fmt(maxTotal)}</span>
              <span className="lc-axis-q3">{fmt(Math.round(maxTotal * 3 / 4))}</span>
              <span className="lc-axis-mid">{fmt(Math.round(maxTotal / 2))}</span>
              <span className="lc-axis-q1">{fmt(Math.round(maxTotal / 4))}</span>
              <span className="lc-axis-bot">{'0'}</span>
            </>
          )}
        </div>
        {/* 只有滚动的「内容」住在 .lc-chart-scroll 下；悬停提示坐在它旁边——
            滚动容器的绝对定位子节点会把自己的溢出撑大，并随内容一起平移。 */}
        <div className="lc-chart-wrap">
          <div
            className={'lc-chart-scroll' + (props.activeTurn !== null ? ' lc-chart-dim' : '')}
            ref={scrollRef}
            onScroll={(e: UIEvent<HTMLDivElement>) => {
              slRef.current = e.currentTarget.scrollLeft
              cwRef.current = e.currentTarget.clientWidth
              updateTurnLabels(e.currentTarget)
              syncTip(e.currentTarget)
              measureVisible(e.currentTarget)
            }}
          >
            <div
              className="lc-chart"
              // 共享的类别悬停走一个普通属性：CSS 会点亮每根柱子里那个 key 的分段，
              // 所以 memo 过的柱子在一次跨卡片悬停时绝不会重渲染。
              data-catdim={props.hoverCat ?? undefined}
              onMouseLeave={() => { props.onHover(null); setDnaHit(null) }}
            >
              <div className="lc-grid lc-grid-top" />
              {/* 虚线导引把柱子与轴的 1/4 刻度对齐；让位给零标签的增量刻度
                  也不再画自己的导引线。 */}
              {(!delta || q3Clear) ? <div className="lc-grid lc-grid-q3" /> : null}
              {(!delta || q1Clear) ? <div className="lc-grid lc-grid-q1" /> : null}
              {!delta ? <div className="lc-grid lc-grid-mid" /> : null}
              <div className="lc-grid lc-grid-zero" style={delta ? { top: `${18 + upPx}px` } : undefined} />
              {requests.map((req, i) => (
                <ChartBar
                  // 粒度必须进 key：一轮的聚合「就是」它最后一步的那条记录，所以切换会
                  // 复用一个 DOM 节点，永远不会重放它的上升动画。
                  key={`${req.seq}:${props.granularity}`}
                  req={req}
                  marker={markers[i]}
                  selected={props.selectedSeq === req.seq}
                  hovered={props.hoveredSeq === req.seq}
                  inTurn={props.activeTurn !== null && (req.turn ?? 0) === props.activeTurn}
                  // 轮次柱跳过这个标志：下面的轮次带已经给那套网格编了号。
                  flag={props.granularity === 'step' && (i + 1) % STEP_FLAG_EVERY === 0 ? i + 1 : null}
                  maxTotal={maxTotal}
                  upPx={delta ? upPx : undefined}
                  downPx={delta ? downPx : undefined}
                  deltaScale={delta ? deltaScale : undefined}
                  // 从窗口边缘开始计数，所以即使日志远远超出窗口，升起的各列也自左向右级联。
                  enterIndex={Math.max(0, i - riseFrom)}
                  rise={i >= riseFrom}
                  dna={dnaOn ? dnaBands[i] : null}
                  dnaDelta={dnaDeltaOn && dnaDeltas !== null ? dnaDeltas[i] : null}
                  dnaScale={dnaDeltaOn ? deltaScale : undefined}
                  zeroBottom={dnaDeltaOn ? downPx : undefined}
                  onDnaHit={setDnaHit}
                  onPickBand={props.onPickBand}
                  onSelect={props.onSelect}
                  onHover={props.onHover}
                />
              ))}
              {dnaOn ? <DnaHighlights slices={dnaSlices} /> : null}
              {/* 一条 svg 骑在滚动内容上，所以它随柱子一起滚动；z-index 与 DNA 高亮持平，但
                  在 DOM 顺序上更靠后，因此曲线读起来在切片之上。每一段都画两次（一层卡片背景打孔垫底）。 */}
              {durationOn && (durationRuns.length > 0 || durationDots.length > 0) ? (
                <svg
                  className="lc-duration"
                  width={requests.length * (BAR_W + BAR_GAP) - BAR_GAP}
                  height={CHART_H}
                  aria-hidden="true"
                >
                  {durationRuns.map((pts, i) => (
                    <Fragment key={i}>
                      <polyline className="lc-dur-halo" points={pts} />
                      <polyline points={pts} />
                    </Fragment>
                  ))}
                  {durationDots.map((p, i) => (
                    <Fragment key={i}>
                      <circle className="lc-dur-halo" cx={p[0]} cy={p[1]} r={2} />
                      <circle cx={p[0]} cy={p[1]} r={1.2} />
                    </Fragment>
                  ))}
                </svg>
              ) : null}
            </div>
            <div className="lc-turns" style={labelFont !== '' ? { fontSize: labelFont } : undefined} onMouseLeave={() => { props.onHoverTurn(null) }}>
              {groups.map((grp, gi) => {
                const on = props.activeTurn === grp.turn
                return (
                  <span
                    key={`turn-${gi}`}
                    className={'lc-turn' + (on ? ' lc-turn-on' : '')}
                    style={{
                      width: `${turnWidths[gi]}px`,
                      background: TURN_FILLS[gi % TURN_FILLS.length],
                    }}
                    title={`T${grp.turn}`}
                    onMouseEnter={() => { props.onHoverTurn(grp.turn) }}
                    onClick={() => { props.onPickTurn(grp.turn) }}
                  ><span className="lc-turn-label">{`${grp.turn}`}</span></span>
                )
              })}
            </div>
          </div>
          {hoveredReq !== null ? (
            <div className="lc-chart-tip">{tipRowsOf(hoveredReq).map((row, i) => <span key={i}>{row}</span>)}</div>
          ) : null}
        </div>
        {durationOn ? (
          <div className="lc-axis lc-axis-r">
            <span className="lc-axis-top">{fmtDuration(maxActiveMs)}</span>
            <span className="lc-axis-q3">{fmtDuration(Math.round(maxActiveMs * 3 / 4))}</span>
            <span className="lc-axis-mid">{fmtDuration(Math.round(maxActiveMs / 2))}</span>
            <span className="lc-axis-q1">{fmtDuration(Math.round(maxActiveMs / 4))}</span>
            <span className="lc-axis-bot">{'0'}</span>
          </div>
        ) : null}
      </div>
    )
  }
}
