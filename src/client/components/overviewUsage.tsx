/**
 * Context Insights 面板第一行的用量图——KPI 那一行的右半。七个日列，
 * 以今天收尾，每列配一对柱子，价钱取自
 * 合并后的每日台账（overview.ts 的 aggregateDays）：计费 TOKEN 数（沿用热力图
 * 那种蓝）与当天估算的 COST（绿色）。费用走
 * 与宿主 fold 在每轮开始时记账的同一批按日定价记录，
 * 用的也是与 KPI 带里成本单元格相同的价目表与估算器——
 * 绝不会把整个会话的开销全堆到它最后活动的那一天。两条序列各按「自己」的
 * 窗口峰值缩放（一周 2 美元不能在 1.69 亿 token 的一周旁被压平），
 * 所以每根柱子读起来是它所属序列峰值的占比；提示（页面 portal 出去的悬停提示，挂在列的
 * `data-lc-tip` 上）给出精确数字。窗口固定为
 * 最近 7 天——上方的区间选择器约束的是 KPI 那些数字，
 * 而不是
 * 这个日历。
 *
 * 这张图按图表的方式加框：在各自序列峰值的 0/25/50/75/100% 处画发丝级
 * 网格线，0 处一条实底基线，两侧各一条刻度轨
 * ——左边 TOKENS，右边 COST，都由柱子据以缩放的同一批
 * 峰值算出。成本轨在有某天真正计价之前读作
 * '—'。
 */

import type { ReactElement } from 'react'
import { formatCost, type CostCurrency } from '../cost'
import { type DayTotals } from '../overview'
import { shiftDayKey } from '../../shared/days'
import type { ViewKit } from '../viewkit'

/** 用量图的输入；窗口由 `today` 算出，而不是由区间选择器决定。 */
export interface OverviewUsageProps {
  /** 合并后的每日台账（日 key → 当天的数字）。 */
  days: Record<string, DayTotals>
  /** 当日费用计价所用的展示货币。 */
  currency: CostCurrency
  /** 本地今天的 key（注入进来以便测试固定日历）。 */
  today: string
}

/** 图表窗口：今天以及它之前的六天，最早的在最前。一次日期位移失败
 *  就放弃整个窗口（[]），而不是画出一张参差不齐的图。 */
export function usageWindowOf(today: string): string[] {
  const columns: string[] = []
  for (let d = -6; d <= 0; d++) {
    const key = shiftDayKey(today, d)
    if (key === null) return []
    columns.push(key)
  }
  return columns
}

/** 共享的网格线/刻度位置，按各序列峰值的百分比计。 */
const TICKS: readonly number[] = [0, 25, 50, 75, 100]

/** 绑定 `kit`，返回这条双序列的日图；整周都为空时渲染空提示。 */
export function makeOverviewUsage(kit: ViewKit): (props: OverviewUsageProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewUsage(props: OverviewUsageProps): ReactElement {
    const window = usageWindowOf(props.today)
    // 放宽了类型：Record 的下标读取在运行时可能落空。
    const byKey: Record<string, DayTotals | undefined> = props.days
    const columns = window.map(key => ({ key, entry: byKey[key] }))
    const empty = columns.every(c => c.entry === undefined || (c.entry.tokens <= 0 && c.entry.cost === null))
    let maxTokens = 0
    let maxCost = 0
    for (const c of columns) {
      if (c.entry === undefined) continue
      if (c.entry.tokens > maxTokens) maxTokens = c.entry.tokens
      if (c.entry.cost !== null && c.entry.cost > maxCost) maxCost = c.entry.cost
    }
    const heightOf = (value: number, max: number): string => (max <= 0 || value <= 0 ? '0%' : `${Math.max(4, Math.round((value / max) * 100))}%`)
    const tickOf = (percent: number): string => fmt(Math.round((maxTokens * percent) / 100))
    // '—' 表示尚无任何计价（一条全零的轨会被读成免费）；0 那个
    // 刻度则裸着读——formatCost 的 toPrecision 会把下限渲染成古怪的 "¥0.0"。
    const costTickOf = (percent: number): string => {
      if (maxCost <= 0) return '—'
      return percent === 0 ? '0' : formatCost((maxCost * percent) / 100, props.currency)
    }
    return (
      <div className="lc-card lc-ov-usage">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('ov.usage.title')}</span>
        </div>
        {empty || window.length === 0
          ? <div className="lc-empty">{t('ov.usage.empty')}</div>
          : (
            <>
              <div className="lc-ov-usage-plot" role="group" aria-label={t('ov.usage.title')}>
                <div className="lc-ov-usage-rail lc-ov-usage-rail-l" aria-hidden="true">
                  {TICKS.map(p => <span key={p} className="lc-ov-usage-tick" style={{ top: `${100 - p}%` }}>{tickOf(p)}</span>)}
                </div>
                <div className="lc-ov-usage-grid">
                  {TICKS.map(p => (
                    <span
                      key={p}
                      className={'lc-ov-usage-line' + (p === 0 ? ' lc-ov-usage-line-0' : '')}
                      style={{ bottom: `${p}%` }}
                      aria-hidden="true"
                    />
                  ))}
                  <div className="lc-ov-usage-cols">
                    {columns.map((c) => {
                      const tokens = c.entry?.tokens ?? 0
                      const cost = c.entry?.cost ?? null
                      // 提示行读的是「裸」标签；图例里那个限定模型的口径不放进气泡。
                      const label = `${c.key}\n${t('ov.usage.tokens')} ${fmt(tokens)}\n${t('ov.usage.costTip')} ${cost === null ? '—' : formatCost(cost, props.currency)}`
                      return (
                        <div key={c.key} className="lc-ov-usage-col" data-lc-tip={label}>
                          <div className="lc-ov-usage-bars">
                            <span
                              className="lc-ov-usage-bar lc-ov-usage-tokens"
                              style={{ height: heightOf(tokens, maxTokens) }}
                            />
                            <span
                              className="lc-ov-usage-bar lc-ov-usage-cost"
                              style={{ height: cost === null ? '0%' : heightOf(cost, maxCost) }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="lc-ov-usage-rail lc-ov-usage-rail-r" aria-hidden="true">
                  {TICKS.map(p => <span key={p} className="lc-ov-usage-tick" style={{ top: `${100 - p}%` }}>{costTickOf(p)}</span>)}
                </div>
                {/* 日期条是绘图网格在图表自己那一列中的第 2 行，
                    所以每个标签都按构造居中于它所属的列之下——没有任何镜像几何
                    需要保持同步。 */}
                <div className="lc-ov-usage-days" aria-hidden="true">
                  {columns.map(c => <span key={c.key} className="lc-ov-usage-day">{c.key.slice(5)}</span>)}
                </div>
              </div>
            </>
          )}
        <div className="lc-ov-usage-key" aria-hidden="true">
          <span className="lc-ov-usage-swatch lc-ov-usage-tokens" />
          <span className="lc-ov-usage-key-label">{t('ov.usage.tokens')}</span>
          <span className="lc-ov-usage-swatch lc-ov-usage-cost" />
          <span className="lc-ov-usage-key-label">{t('ov.usage.cost')}</span>
        </div>
      </div>
    )
  }
}
