/**
 * 统计页那张**计费 Token** 卡：本区间由 provider 上报的四个计费分桶，
 * 完全按实际计量——缓存命中、未缓存输入、缓存写入与输出。
 *
 * 只讲 token。旁边同样口径的组成环图说明 token「是什么」，这张卡则按平台
 * 实际计费的分桶来拆，读的人由此能看出这些量里有多少走在缓存命中上、
 * 多少是全新输入。费用有它自己那一段（平台卡 + 明细表），不在这里出现。
 */

import { useState, type ReactElement } from 'react'
import type { BilledTotals } from '../overview'
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
}) => ReactElement {
  const { t, fmt, fmtShare } = kit
  return function OverviewBilled(props: { billed: BilledTotals | null }): ReactElement {
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
    // 没有可画的 token 分桶时，只要还有平台明细就仍然要渲染外壳——纯积分消费
    // 正是这种情况：它有花销，但一分钱都不按 token 计。
    if (buckets.length === 0 && billed.platforms.length === 0) {
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
    // 这张卡只讲 token：峰谷费用拆分属于费用那一段（平台卡与明细表），
    // 混在这里会让同一张卡同时声称两种量纲。
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        {head}
        {buckets.length > 0 ? (
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
        ) : null}
      </div>
    )
  }
}
