/** Token 卡片：本会话全部的计费 token 用量——与 harness 聊天统计行在输入框下方
 * 显示的总量完全相同（未缓存输入 + 缓存读取 + 缓存写入 + 输出，
 * 取自官方的 `tokenUsage` projection）——按 token「是什么」拆分，
 * 而不是按 provider 的缓存方式拆。六个组成类别用组成卡片自己的估计比例
 * 分摊 provider 上报的 prompt 侧总量（billedParts），
 * provider 精确的 output 计数自成一个分段，因此环图与中心数字与聊天行
 * 按构造永远相等。估计出来的类别计数带 ≈ 标记（组成卡片的惯例）；
 * 中心总量与 output 计数是精确值。一旦有用量上报，值为零的类别就隐藏；
 * 按构造永远相等。估计出来的类别计数带 ≈ 标记（组成卡片的
 * 惯例）；中心总量与 output 计数是精确值。一旦有用量上报，值为零的类别
 * 就隐藏；空状态
 * （provider 尚未上报）则把全部七行留在一条短横线中心之后。
 * 标题行右角显示本会话的缓存命中份额——即 harness
 * 聊天行自己那套读取量比计费量的公式——在有计费之前保持隐藏。 */

import { useState, type ReactElement } from 'react'
import type { ContextBreakdown, Snapshot, TokenUsage } from '../../shared/types'
import { billedParts } from '../categories'
import { cacheHitPercent } from '../format'
import { numOf } from '../services'
import type { ViewKit } from '../viewkit'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import type { DonutProps } from './donut'

/** provider 用量尚不存在时 `billedParts` 需要的那份全零报告；
 *  有了它，空环图与空图例才会表现得一致。 */
const NO_USAGE: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/**
 * 绑定 `kit` 与共享的 `Donut`，返回 token 组成卡片。卡片自己的总量就是计费量，
 * 所以它的环图与中心数字始终与 harness 聊天行一致。
 */
export function makeStatsTokens(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  usage: TokenUsage | null
  current: Snapshot['current']
  breakdown: ContextBreakdown | null
}) => ReactElement {
  const { t, fmt, fmtShare, catLabel } = kit
  return function StatsTokens(props: {
    usage: TokenUsage | null
    current: Snapshot['current']
    breakdown: ContextBreakdown | null
  }): ReactElement {
    // 图例行 ↔ 环图分段的悬停联动（共享 key，两侧都可设置）。
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    // usage 为 null 表示 provider 没有上报，而 harness 聊天行本身也就什么都不显示——
    // 所以这里的零是展示上的约定，不是推断出来的测量值。
    const input = props.usage !== null
      ? numOf(props.usage.uncachedInputTokens) + numOf(props.usage.cacheReadTokens) + numOf(props.usage.cacheWriteTokens)
      : 0
    const output = props.usage !== null ? numOf(props.usage.outputTokens) : 0
    const total = input + output
    // 标题行角落的数字：缓存读取量比上计费的 prompt 侧输入量，
    // 即 harness 聊天行自己的公式（statsContext 的单元格共用它）。
    const hit = props.usage === null
      ? null
      : cacheHitPercent(numOf(props.usage.cacheReadTokens), input)
    // usage 为 null（provider 没有上报——聊天行同样什么都不显示）
    // 走 billedParts 为零报告产出的同一套全零拆分。
    const parts = billedParts(props.current, props.breakdown, props.usage ?? NO_USAGE)
    const shown = total > 0 ? parts.filter(p => p.value > 0) : parts
    const rows: SliceRow[] = shown.map(p => ({
      key: p.key,
      color: p.color,
      label: p.key === 'output' ? t('tokens.output') : catLabel(p.key),
      pct: fmtShare(p.value, total),
      // prompt 侧的六个份额是比例估计（≈，沿用组成卡片的惯例）；只有 output 是 provider 精确值。
      count: p.key === 'output' ? `${fmt(p.value)} · ${t('tokens.outputNote')}` : '≈' + fmt(p.value),
    }))
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('tokens.title')}</span>
          {hit !== null && (
            <span className="lc-card-rate" title={t('stats.cacheHitTip')}>{t('stats.cacheHit')} {hit}%</span>
          )}
        </div>
        {/* donut + legend 行：卡片 320px 时间隙收拢，低于 240px 时该行换行，
            环图居中于占满整宽的图例之上（全部以 lc-card 容器为准）。 */}
        <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
          <Donut
            segments={shown}
            size={96}
            centerTop={props.usage === null ? '—' : fmt(total)}
            centerSub={t('tokens.total')}
            hoverKey={hoverKey}
            onHoverKey={setHoverKey}
          />
          <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
        </div>
      </div>
    )
  }
}
