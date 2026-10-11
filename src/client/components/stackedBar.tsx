/** 组成条 + 图例；共享的悬停联动提示是专门写的——没有哪个共享原语能复现这种跨分段/图例的联动——
 * 样式走共享的 `--dsw-alias-*` 令牌。挂载时各分段与空闲轨道自左向右展开
 * （stackedBar.css，用下面那些有上限的逐段 `--lc-i` 槽位错开，因此一长串 DNA 带能很快收敛）；
 * 预留带不参与动画。 */

import { useState, type CSSProperties, type ReactElement } from 'react'
import type { PartsPart } from '../categories'
import type { ViewKit } from '../viewkit'

/** 镜像 dsh-compaction-basic 的默认 `thresholdRatio`（0.8）：一旦 `floor(contextWindow × ratio)`
 * 达成，它就在步骤边界压缩；DSH 并不把配置好的比例公布给插件/客户端，所以这条预留带镜像的是默认值——
 * 调过 `thresholdRatio`/`modelPolicies` 的部署应相应调整它。 */
export const AUTO_COMPACT_RATIO = 0.8

/** 入场错开的上限：浏览器的 DNA 带可能列到几十项，所以展开级联超过这么多槽位后就不再
 * 继续延后，后来的带只是落在上限内（stackedBar.css 按 `--lc-i` 延时）；
 * 组成条那几段类别永远到不了这个数。 */
const STAGGER_CAP = 8

/** 条的输入。`max` 是条据以铺排的窗口（不传则已占用总量
 *  把它填满）；`minBand`/`tip`/`reserve` 是浏览器 DNA 模式下的细化项。 */
export interface StackedBarProps {
  parts: PartsPart[]
  max?: number
  height?: number
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /** 分段点击（浏览器的 DNA 模式借此展开该带的折叠行）：各分段获得可选中的光标并上报自己的 key。 */
  onPickKey?: (key: string) => void
  /** 每个分段保住的最小宽度，按「已占用」区域的比例计（浏览器的 DNA 带：一个极小的项必须
   * 仍然可悬停，而不是渲染到不足一个像素）。低于下限的带钉在下限上，其余按比例
   * 重新缩放；下限封顶在均分处（100/N），到那时整条退化成宽度均匀的带。提示
   * 仍然报告真实占比——只有宽度被抬到下限。 */
  minBand?: number
  /** 是否渲染悬停提示（默认 true）；只「镜像」别的卡片悬停的条会把它关掉，
   * 好让提示只浮在指针真正停驻的那个表面上。 */
  tip?: boolean
  /** 可选的自动压缩预留带：窗口最右侧的 (1−ratio) 一段，带条纹的「余量」——
   * 会话通常避免填到的那块区域，因为越过阈值就会触发自动压缩；只在 `max`（窗口）为正时渲染。
   */
  reserve?: { ratio: number; label: string }
}

/** 绑定 `kit`，返回组成条；预留悬停标记是逐实例的，
 *  所以同一页面上的两条永远不会点亮对方的带。 */
export function makeStackedBar(kit: ViewKit): (props: StackedBarProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function StackedBar(props: StackedBarProps): ReactElement {
    // 预留悬停标记放在这里，好让唯一的提示位同时服务各分段与该预留带。
    const [reserveOn, setReserveOn] = useState(false)
    // `scale` 是布局分母（已知窗口时用窗口，否则用已占用总量）；
    // `free` 是剩余余量，只在窗口超过总量时才存在。
    let total = 0
    for (const p of props.parts) total += p.value
    const scale = props.max !== undefined && props.max > total ? props.max : total
    const free = props.max !== undefined && props.max > total ? props.max - total : 0
    // 各分段的「宽度」按整个窗口（scale）铺排，但图例/提示里的百分比是已占用总量的占比——悬停时
    // 会有一个实心框勾出已占用区域（宽 = used/scale），好让这个参照系可见；只在存在空闲轨道时。
    const usedPct = scale > 0 ? total / scale * 100 : 0
    const hovering = props.hoverKey !== null && props.hoverKey !== undefined
    const showBox = free > 0 && hovering
    const pickKey = props.onPickKey
    const minBand = props.minBand !== undefined && props.minBand > 0 ? props.minBand : 0

    // 可渲染的分段（值为零的部分跳过），带它们的「bar 单位」宽度，并按已占用单位
    // 抬到 `minBand` 的下限：被钉住的分段取用下限，其余重新缩放进剩余空间，
    // 使整条仍然精确地加总为已占用区域。总有至少一个带不被钉住（各占比加起来是 100，下限 ≤ 100/N），
    // 所以 restRaw 永远不会除以零。
    const visible = total > 0 ? props.parts.filter(p => p.value > 0) : []
    const widths = ((): number[] => {
      if (minBand === 0 || visible.length < 2) return visible.map(p => p.value / scale * 100)
      const shares = visible.map(p => p.value / total * 100)
      const floor = Math.min(minBand, 100 / visible.length)
      let pinned = 0
      let pinnedRaw = 0
      for (const s of shares) {
        if (s < floor) { pinned += 1; pinnedRaw += s }
      }
      if (pinned === 0) return visible.map(p => p.value / scale * 100)
      const restRoom = 100 - pinned * floor
      const restRaw = 100 - pinnedRaw
      return shares.map(s => (s < floor ? floor : s * restRoom / restRaw) * total / scale)
    })()

    // 预留带按「窗口单位」铺排（`ratio × max` → `max`），再缩放到条实际覆盖的任意总量上，因此无论有没有
    // 空闲轨道，它都是同一片物理切片（一旦用量超过窗口，条纹就压在最外层的那几个分段上）。
    const reserve = props.reserve !== undefined && props.max !== undefined && props.max > 0
      ? { ...props.reserve, max: props.max }
      : null
    const reserveLeft = reserve !== null ? Math.round(reserve.max * reserve.ratio / scale * 1000) / 10 : 0
    const reserveWidth = reserve !== null ? Math.round((1 - reserve.ratio) * reserve.max / scale * 1000) / 10 : 0

    // 提示「派生自」共享的 hover key，所以一个分段与它的图例标签会点亮同一个分段并显示同一条提示
    // （按百分比居中，无需测量）；外层包裹让它留在被裁剪的堆叠之外；预留带用自己的标签
    // 覆盖这个提示位。
    let tip: { text: string; leftPct: number } | null = null
    if (reserveOn && reserve !== null) {
      tip = {
        text: reserve.label,
        leftPct: Math.max(12, Math.min(reserveLeft + reserveWidth / 2, 88)),
      }
    } else if (props.hoverKey !== null && props.hoverKey !== undefined) {
      if (props.hoverKey === 'free' && free > 0) {
        const pct = scale > 0 ? free / scale * 100 : 0
        tip = {
          text: `${t('overview.free')} ${fmt(free)} (${Math.round(pct)}%)`,
          leftPct: Math.max(12, Math.min((total / scale * 100) + pct / 2, 88)),
        }
      } else {
        let acc = 0
        // 计数来自该部分启发式的 `raw` 数字（环图
        // 面板的那些行）；宽度则走抬过下限的 `widths`，好让提示居中于「实际渲染出来」的分段。
        let rawTotal = 0
        for (const p of props.parts) rawTotal += p.raw ?? p.value
        for (let i = 0; i < visible.length; i++) {
          const p = visible[i]
          if (p.key === props.hoverKey) {
            const count = p.raw ?? p.value
            tip = {
              text: `${p.label ?? catLabel(p.key)} ≈${fmt(count)} (${rawTotal > 0 ? Math.round(count / rawTotal * 100) : 0}%) `
                + t('overview.ofUsed'),
              leftPct: Math.max(12, Math.min(acc + widths[i] / 2, 88)),
            }
            break
          }
          acc += widths[i]
        }
      }
    }

    return (
      <div className="lc-stacked-wrap">
        <div
          className={'lc-stacked' + (hovering ? ' lc-stacked-dim' : '')}
          style={{ height: `${props.height || 14}px` }}
          onMouseLeave={() => {
            if (props.onHoverKey !== undefined) props.onHoverKey(null)
            setReserveOn(false)
          }}
        >
          {visible.map((p, i) => {
            // 精确 key 的悬停点亮那一段；某个部分的 `group` 则回应镜像过来的「类别」悬停（DNA 带按类别点亮）。
            const on = props.hoverKey !== undefined
              && (props.hoverKey === p.key || (p.group !== undefined && props.hoverKey === p.group))
            return (
              <div
                key={p.key}
                className={'lc-stacked-seg animate-lc-stacked-in motion-reduce:animate-none' + (on ? ' lc-stacked-seg-on' : '') + (pickKey !== undefined ? ' lc-stacked-seg-pick' : '')}
                // 生长扫入的错开槽位（animate-lc-stacked-in 令牌的延时）：每个分段依次从左边
                // scaleX 展开，并设了上限，好让一长串 DNA 带迅速收敛。
                style={{ width: `${widths[i]}%`, backgroundColor: p.color, '--lc-i': Math.min(i, STAGGER_CAP) } as CSSProperties}
                onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
                onClick={pickKey !== undefined ? () => { pickKey(p.key) } : undefined}
              />
            )
          })}
          {free > 0 ? (
            <div
              key="free"
              className={'lc-stacked-free animate-lc-stacked-in motion-reduce:animate-none' + (props.hoverKey === 'free' ? ' lc-stacked-free-on' : '')}
              // 空闲轨道紧跟在最后一个已占用分段之后展开（超过错开上限后它落在
              // 被封顶的分段之后一格）。
              style={{ width: `${free / scale * 100}%`, '--lc-i': Math.min(visible.length, STAGGER_CAP + 1) } as CSSProperties}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey('free') }}
            />
          ) : null}
          {/* 画在轨道/分段之上，好让条纹覆盖它们；它占住指针，因此显示自己的说明——并会在探索它时
              清掉分段的悬停联动。
               */}
          {reserve !== null ? (
            <div
              className="lc-reserve"
              style={{ left: `${reserveLeft}%`, width: `${reserveWidth}%` }}
              onMouseEnter={() => {
                setReserveOn(true)
                if (props.onHoverKey !== undefined) props.onHoverKey(null)
              }}
              onMouseLeave={() => { setReserveOn(false) }}
            />
          ) : null}
          {/* 已占用区域的框：最后画，好让它的边框压在分段之上；始终挂载（`.lc-occupied-box-on` 切换
              不透明度），所以离开时是淡出而不是立刻卸载。
               */}
          <div
            className={'lc-occupied-box' + (showBox ? ' lc-occupied-box-on' : '')}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        {/* 悬停提示同样始终挂载（用 `.lc-bar-tip-on` 控制不透明度），所以它是渐入渐出的；不可见时它既不接收指针事件，
            也不占任何宽度。
             */}
        {props.tip !== false
          ? (
            <div
              className={'lc-tip lc-bar-tip' + (tip ? ' lc-bar-tip-on' : '')}
              style={{ left: tip ? `${tip.leftPct}%` : '50%' }}
            >{tip ? tip.text : ''}</div>
          )
          : null}
      </div>
    )
  }
}

/** 绑定 `kit`，返回图例。与条共享同一套 hover key 契约，
 *  所以两者永远由一处控制；计数走 `raw`（启发式数字），而
 *  条的宽度走抬过下限的值，因此两者有意允许不一致。 */
export function makeLegend(kit: ViewKit): (props: {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function Legend(props: {
    parts: PartsPart[]
    hoverKey?: string | null
    onHoverKey?: (key: string | null) => void
  }): ReactElement {
    let total = 0
    for (const p of props.parts) total += p.raw ?? p.value
    return (
      <div className="lc-legend">
        {props.parts.map((p) => {
          const count = p.raw ?? p.value
          const on = props.hoverKey !== undefined && props.hoverKey === p.key
          return (
            <span
              key={p.key}
              className={'lc-chip' + (on ? ' lc-chip-on' : '')}
              title={t('overview.ofUsed')}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(p.key) }}
              onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
            >
              <i style={{ background: p.color }} />
              <span className="lc-chip-label">{catLabel(p.key)}</span>
              <span className="lc-chip-nums">
                {'≈' + fmt(count)}
                {total > 0 ? <em>{`${Math.round(count / total * 100)}%`}</em> : null}
              </span>
            </span>
          )
        })}
      </div>
    )
  }
}
