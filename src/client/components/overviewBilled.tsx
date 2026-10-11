/**
 * Cost Statistics 面板里那张具体的用量卡片：本区间由 provider 上报的
 * 计费分桶，完全按实际计量——缓存命中、未缓存输入、缓存写入
 * 与输出——外加各定价时段各自花了多少。
 *
 * 这是账单一侧的数字。旁边的 Token Stats 卡片把同一个总量按
 * 上下文类别分摊（说明 token「是什么」）；这张卡片则按平台实际计费的
 * 分桶来拆，读的人由此能看出这笔开销里有多少走在缓存命中上，
 * 多少是全新输入。
 */

import { useState, type ReactElement } from 'react'
import type { BilledTotals } from '../overview'
import type { CostCurrency } from '../cost'
import { formatCost, toCurrency } from '../cost'
import type { ViewKit } from '../viewkit'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import type { DonutProps } from './donut'

/** 四个计费分桶，按图例的阅读顺序排列，沿用成本图表自己的调色板。 */
const BUCKETS: readonly { key: 'cacheRead' | 'uncached' | 'cacheWrite' | 'output'; color: string; label: string }[] = [
  { key: 'cacheRead', color: 'var(--color-green-500)', label: 'stats.costHit' },
  { key: 'uncached', color: 'var(--color-amber-500)', label: 'stats.costMiss' },
  { key: 'cacheWrite', color: 'var(--color-purple-500)', label: 'stats.costWrite' },
  { key: 'output', color: 'var(--color-pink-500)', label: 'stats.costOut' },
]

/** 绑定 `kit` 与共享的 `Donut` 渲染器，返回计费用量卡片；
 *  为 null 的那种情况表示本区间什么都没计量到。 */
export function makeOverviewBilled(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  billed: BilledTotals | null
  currency: CostCurrency
}) => ReactElement {
  const { t, fmt, fmtShare } = kit
  return function OverviewBilled(props: { billed: BilledTotals | null; currency: CostCurrency }): ReactElement {
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const billed = props.billed
    const head = (
      <div className="lc-card-title">
        <span className="lc-card-title-text">{t('ov.billed.title')}</span>
      </div>
    )
    // 什么都没计费的区间没有分桶，也没有可画的拆分。
    if (billed === null) {
      return (
        <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
          {head}
          <div className="lc-empty">{t('ov.stats.empty')}</div>
        </div>
      )
    }
    // 只要有计费，零值分桶就会去掉，于是图例只列出真实发生过的部分。
    const buckets = BUCKETS.filter(b => billed[b.key] > 0)
    if (buckets.length === 0) {
      return (
        <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
          {head}
          <div className="lc-empty">{t('ov.stats.empty')}</div>
        </div>
      )
    }
    const rows: SliceRow[] = buckets.map(b => ({
      key: b.key,
      color: b.color,
      label: t(b.label),
      pct: fmtShare(billed[b.key], billed.total),
      // 这里的每个数字都由 provider 上报，因此没有一个是估计值。
      count: fmt(billed[b.key]),
    }))
    // 按时段拆分，取自同一份台账，用展示货币计价。
    const peak = toCurrency(billed.cost.peak, props.currency)
    const off = toCurrency(billed.cost.off, props.currency)
    const periodSum = peak + off
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        {head}
        <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
          <Donut
            segments={buckets.map(b => ({ key: b.key, color: b.color, value: billed[b.key] }))}
            size={96}
            centerTop={fmt(billed.total)}
            centerSub={t('tokens.total')}
            hoverKey={hoverKey}
            onHoverKey={setHoverKey}
          />
          <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
        </div>
        {/* 按时段拆分：这笔开销落在费率卡的哪一侧。
            已计量、但涉及的模型没有费率的区间没有可展示的拆分。 */}
        {periodSum > 0
          ? (
            <div className="lc-ov-billed-periods">
              <span className="lc-ov-billed-period">
                <i style={{ background: 'var(--color-red-500)' }} />
                {t('dock.peak')}
                {' '}
                <b>{formatCost(peak, props.currency)}</b>
                <em>{fmtShare(peak, periodSum)}</em>
              </span>
              <span className="lc-ov-billed-period">
                <i style={{ background: 'var(--color-green-500)' }} />
                {t('dock.off')}
                {' '}
                <b>{formatCost(off, props.currency)}</b>
                <em>{fmtShare(off, periodSum)}</em>
              </span>
            </div>
          )
          : null}
      </div>
    )
  }
}
