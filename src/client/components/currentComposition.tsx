import { type ReactElement } from 'react'
import type { PartsPart } from '../categories'
import type { Headline } from '../headline'
import type { ViewKit } from '../viewkit'
import { AUTO_COMPACT_RATIO } from './stackedBar'
import type { StackedBarProps } from './stackedBar'

/** 由调用方注入的图例渲染器（`stackedBar.tsx` 里的 `makeLegend`），这样这张卡片
 *  不必依赖调色板自己的模块。 */
type LegendFn = (props: {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}) => ReactElement

/** 概览卡片的输入；`head` 已经由 `headline.ts` 的 `headlineOf` 提炼过。 */
export interface CurrentCompositionProps {
  head: Headline
  subtitle?: string
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

/**
 * 每次挂载绑定一次 `kit` 与两个注入的渲染器，返回概览卡片。
 * `StackedBar` 与 `Legend` 走注入而不是 import，是为了让调用方的单份实例
 * 既保持模块图无环，又共享同一个悬停 key。
 */
export function makeCurrentComposition(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactElement,
  Legend: LegendFn,
): (props: CurrentCompositionProps) => ReactElement {
  const { t, fmt } = kit
  return function CurrentComposition(props: CurrentCompositionProps): ReactElement {
    const head = props.head
    // 自动压缩带标出 harness 会在何处未经提示就压缩；上下文窗口未知时没有分母可供摆放它，
    // 因此略去这条带子。
    const reserve = head.window != null && head.window > 0
      ? { ratio: AUTO_COMPACT_RATIO, label: t('overview.compactReserve', { pct: Math.round(AUTO_COMPACT_RATIO * 100) }) }
      : undefined
    return (
      <div className="lc-card" data-lc-current>
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('overview.title')}</span>
          {props.subtitle !== undefined && props.subtitle !== ''
            ? <span className="lc-card-sub">{props.subtitle}</span>
            : null}
        </div>
        <div className="lc-overview-num">
          <b>{fmt(head.tokens)}</b>
          <span>
            {head.window
              ? ' / ' + fmt(head.window) + ' tokens'
              : ' ' + t('overview.estimate')}
          </span>
          {head.pct !== null ? (
            <span className="lc-overview-pct">
              {/* 保留一位小数：卡片对内核占用百分比的读法（headline.ts）。 */}
              <b>{`${head.pct.toFixed(1)}%`}</b>
              {t('overview.used')}
            </span>
          ) : null}
        </div>
        <StackedBar
          parts={head.parts}
          height={16}
          max={head.window}
          hoverKey={props.hoverKey}
          onHoverKey={props.onHoverKey}
          reserve={reserve}
        />
        <Legend parts={head.parts} hoverKey={props.hoverKey} onHoverKey={props.onHoverKey} />
      </div>
    )
  }
}
