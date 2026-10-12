/** 费用卡片：本会话这笔钱花在哪儿——按**计费分桶**拆（缓存输入 /
 * 未缓存输入 / 缓存写入 / 输出），再按**定价时段**拆（峰 / 谷），
 * 并带上账户余额。
 *
 * 与正上方的 Token 卡片同作用域、同口径：那边给出 provider 上报的精确
 * token 数，这边把同一批数字乘上各自费率，因此「用得多」与「花得多」
 * 是同一件事的两面。费率与峰谷判定都走 cost.ts 的同一个入口，
 * 所以两张卡片（以及输入框下方那条读数）不会互相漂移。
 *
 * 余额沿用 Insights 页那颗胶囊的两个来源：先画出上一次记住的数字，
 * 再由 host 路由在后台校正；取不到时整行不出现，绝不用一个零蒙混。
 */

import { useState, type ReactElement } from 'react'
import { balanceEntryOf, readPlatformBalance } from '../balance'
import type { PlatformBalance, SessionCallCounts, SessionCostUsage } from '../../shared/types'
import { estimateSessionCostByBucket, formatCost, toCurrency, type CostCurrency } from '../cost'
import { platformSpendsOf } from '../platformSpend'
import { fmtCredits } from '../turnSpend'
import { useModelPrices } from '../modelPrices'
import type { ViewKit } from '../viewkit'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import type { DonutProps } from './donut'

/** 平台所支持币种的符号前缀；其余币种直接显示代码。 */
function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return currency + ' '
}

/** 平台控制台页面，点余额行时打开。 */
const USAGE_URL = 'https://platform.deepseek.com/usage'

/** 四个计费分桶，沿用成本图表自己的调色板——与输入框下方那条读数同色，
 *  同一个桶在两处长得一样。 */
const BUCKETS: readonly { key: 'cacheRead' | 'uncached' | 'cacheWrite' | 'output'; color: string; label: string }[] = [
  { key: 'cacheRead', color: 'var(--color-green-500)', label: 'stats.costHit' },
  { key: 'uncached', color: 'var(--color-amber-500)', label: 'stats.costMiss' },
  { key: 'cacheWrite', color: 'var(--color-purple-500)', label: 'stats.costWrite' },
  { key: 'output', color: 'var(--color-pink-500)', label: 'stats.costOut' },
]

/** 峰 / 谷两段；色值与读数卡一致。零值的一段仍然列出——「这段没花钱」
 *  是一个可见的事实，环图自己会跳过零弧，图例不该跟着消失。 */
const PERIODS: readonly { key: 'peak' | 'off'; color: string; label: string }[] = [
  { key: 'peak', color: 'var(--color-red-500)', label: 'dock.peak' },
  { key: 'off', color: 'var(--color-green-500)', label: 'dock.off' },
]

/**
 * 绑定 `kit` 与共享的 `Donut`，返回费用卡片。`usage` 为 null 表示这个
 * 会话还没有任何计费上报——据实展示空状态，而不是画一张全零的图。
 */
export function makeStatsCost(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  usage: SessionCostUsage | null
  calls?: SessionCallCounts | null
  creditRates?: Record<string, Record<string, number>> | null
  currency: CostCurrency
}) => ReactElement {
  const { t, fmtShare } = kit
  return function StatsCost(props: {
    usage: SessionCostUsage | null
    calls?: SessionCallCounts | null
    creditRates?: Record<string, Record<string, number>> | null
    currency: CostCurrency
  }): ReactElement {
    // 图例行 ↔ 环图分段的悬停联动（共享 key，两侧都可设置）。
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    // 价目册与 Token/统计卡共用同一份缓存；拿不到费率时下面会据实说明。
    const { book } = useModelPrices()
    // 余额：初始化函数同步画出记住的数字，同时挂上后台校正的回调，
    // 因此这里不会先闪一帧空白。
    const [balance, setBalance] = useState<PlatformBalance | null>(() => readPlatformBalance((v) => { setBalance(v) }))
    const currency = props.currency
    const split = estimateSessionCostByBucket(props.usage, book)
    const entry = balanceEntryOf(balance, currency)
    // 「有计费、却一行都定不了价」与「压根没有计费」是两件事：前者要说清是价格拿不到，
    // 而不是让读者以为这个会话没花过钱。`split.any` 为假时两者都无图可画。
    const hasLedger = props.usage !== null && props.usage !== undefined && Object.keys(props.usage).length > 0
    const unpriced = !split.any && hasLedger
    // wire 处处是美元，只在展示时换算；格式沿用插件既有的费用写法
    // （不到 1 元取两位有效数字，其余取到分），因此同一笔钱在这张卡、
    // Token 卡角标与输入框下方那条读数里长得一样。
    const money = (usd: number): string => formatCost(toCurrency(usd, currency), currency)
    const totalText = split.any ? money(split.total) : '—'
    // 分桶行：主行给占比（环图上的份额），次行给这笔钱本身——两者都是这张卡要回答的问题。
    // 只有真的花了钱的分桶才进环图与图例，环图因此不会画零弧。
    // 按平台拆分：积分平台与人民币平台各自成行，绝不加成一个数（两种货币不能相加）。
    const platforms = platformSpendsOf(props.usage, props.calls, book, null, props.creditRates)
    const buckets = BUCKETS.filter(b => split[b.key] > 0)
    const rows: SliceRow[] = buckets.map(b => ({
      key: b.key,
      color: b.color,
      label: t(b.label),
      pct: fmtShare(split[b.key], split.total),
      count: money(split[b.key]),
    }))
    const periodSum = split.peak + split.off
    // 卡片是否有内容：有钱可分桶，**或**有平台明细可列。只有积分平台时 `split.any`
    // 为假（积分不能按 token 定价），但那正是最该显示平台明细的情况——此前它会被
    // 当成「无数据」整卡收起，积分消费因此完全看不见。
    const hasContent = split.any || platforms.length > 0
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('costStat.title')}</span>
          {/* 标题右角的总额：整张卡片里最该先被读到的数字。 */}
          {split.any
            ? <span className="lc-card-rate" title={t('costStat.note')}>{totalText}</span>
            : null}
        </div>
        {!hasContent
          ? <div className="lc-empty">{unpriced ? t('stats.costUnavailable') : t('costStat.empty')}</div>
          : (
            <>
              {split.any ? (
              <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
                <Donut
                  segments={buckets.map(b => ({ key: b.key, color: b.color, value: split[b.key] }))}
                  size={96}
                  centerTop={totalText}
                  centerSub={t('costStat.total')}
                  hoverKey={hoverKey}
                  onHoverKey={setHoverKey}
                />
                <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
              </div>
              ) : null}
              {/* 时段拆分与分桶拆分出自同一次累加，所以两行的和恒等于总额。 */}
              {split.any ? (
              <div className="lc-sc-periods">
                {PERIODS.map(p => (
                  <span key={p.key} className={'lc-sc-period' + (split[p.key] <= 0 ? ' lc-sc-period-dim' : '')}>
                    <i style={{ background: p.color }} />
                    <span className="lc-sc-period-label">{t(p.label)}</span>
                    <b>{money(split[p.key])}</b>
                    <em>{fmtShare(split[p.key], periodSum)}</em>
                  </span>
                ))}
              </div>
              ) : null}
              {/* 平台明细：回答「这笔钱花在哪个平台上」。只有一个平台时这行价值不大，
                  但一旦用过积分平台，总额与平台之和就对不上——那时必须让读者看见为什么。 */}
              {platforms.length > 0
                ? (
                  <div className="lc-sc-platforms">
                    {platforms.map(row => (
                      <span key={row.provider} className="lc-sc-platform" data-unit={row.unit}>
                        <span className="lc-sc-platform-name" title={row.models.join(' · ')}>{row.provider}</span>
                        <b>{row.unit === 'credits' ? t('costStat.credits', { n: fmtCredits(row.value) }) : money(row.value)}</b>
                        <em>{t('costStat.calls', { n: row.calls })}</em>
                      </span>
                    ))}
                  </div>
                )
                : null}
              {/* 余额：有则给出充值/赠送明细，取不到时整行不出现。 */}
              {entry !== null
                ? (
                  <a
                    className="lc-sc-balance"
                    href={USAGE_URL}
                    target="_blank"
                    rel="noreferrer"
                    title={[
                      ...(entry.toppedUp > 0 ? [t('balance.tip.toppedUp') + ': ' + symbolOf(entry.currency) + entry.toppedUp.toFixed(2)] : []),
                      ...(entry.granted > 0 ? [t('balance.tip.granted') + ': ' + symbolOf(entry.currency) + entry.granted.toFixed(2)] : []),
                    ].join('\n') || undefined}
                  >
                    <span className="lc-sc-balance-label">{t('balance.title')}</span>
                    <b>{symbolOf(entry.currency) + entry.total.toFixed(2)}</b>
                  </a>
                )
                : null}
            </>
          )}
      </div>
    )
  }
}
