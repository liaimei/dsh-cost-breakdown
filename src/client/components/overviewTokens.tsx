/** Context Insights 面板里聚合的 Token Stats 卡片——第一行的 token 那半，
 * 分类方式与 Context 标签页的 Token 卡片完全一致
 * （statsTokens.tsx）：把本区间的计费量按 token「是什么」来拆——
 * 用组成类别的 `≈` 估计值去分配各会话由 provider 上报的 prompt 总量，
 * 再加上精确的 output——由 tokenPartsOf 折叠。中心数字仍是 KPI 带里 Tokens Used 单元格
 * 显示的精确合并计费总量。 */

import { useState, type ReactElement } from 'react'
import type { TokenPartTotal } from '../overview'
import type { ViewKit } from '../viewkit'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import type { DonutProps } from './donut'

/** 绑定 `kit` 与共享的 `Donut`，返回本区间的 token 组成卡片；没有任何计费量的区间
 *  显示空提示，而不是一个全零的环。 */
export function makeOverviewTokens(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  /** 本区间按类别折叠后的计费拆分（null：没有任何计费）。 */
  tokens: { parts: TokenPartTotal[]; total: number } | null
}) => ReactElement {
  const { t, fmt, fmtShare, catLabel } = kit
  return function OverviewTokens(props: { tokens: { parts: TokenPartTotal[]; total: number } | null }): ReactElement {
    // 图例行 ↔ 环图分段的悬停联动（共享 key，两侧都可设置）。
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const tokens = props.tokens
    const total = tokens?.total ?? 0
    // 只要有计费，值为零的类别就隐藏（沿用单会话 Token 卡片的惯例）；
    // 本区间没有计费 token 时显示空提示。
    const shown = tokens !== null && total > 0 ? tokens.parts.filter(p => p.value > 0) : []
    const rows: SliceRow[] = shown.map(p => ({
      key: p.key,
      color: p.color,
      label: p.key === 'output' ? t('tokens.output') : catLabel(p.key),
      pct: fmtShare(p.value, total),
      // 类别数字是按会话比例估计出来的（沿用单会话卡片的 ≈ 惯例，再求和）；
      // output 的数字则是 provider 精确值。
      count: p.key === 'output' ? `${fmt(p.value)} · ${t('tokens.outputNote')}` : '≈' + fmt(p.value),
    }))
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('tokens.title')}</span>
        </div>
        {shown.length === 0
          ? <div className="lc-empty">{t('ov.stats.empty')}</div>
          : (
            // 环图 + 图例行：与单会话环图卡片同一套结构
            // （卡片 320px 时间隙收拢，低于 240px 时该行换行）。
            <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
              <Donut
                segments={shown.map(p => ({ key: p.key, color: p.color, value: p.value }))}
                size={96}
                centerTop={fmt(total)}
                centerSub={t('tokens.total')}
                hoverKey={hoverKey}
                onHoverKey={setHoverKey}
              />
              <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
            </div>
          )}
      </div>
    )
  }
}
