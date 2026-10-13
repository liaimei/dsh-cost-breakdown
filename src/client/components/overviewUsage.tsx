/**
 * 统计页第一行的**纯 token** 用量图——七个日列，以今天收尾。
 *
 * 只画计费 token：费用有它自己的那一段（平台卡 + 明细表），把两条序列塞进同一张图
 * 会让读者以为可以跨界比较，而 token 与金额本来就不是一个量纲。
 *
 * 每根柱子按窗口内 token 峰值缩放；提示（portal 出去的悬停气泡，挂在列的
 * `data-lc-tip` 上）给出精确数字。窗口固定为最近 7 天——上方的区间选择器约束的是
 * 左侧统计页那些汇总数字，而不是这个日历。
 *
 * 网格线画在峰值的 0/25/50/75/100% 处，0 处一条实底基线，左侧一条刻度轨。
 */

import type { ReactElement } from 'react'
import { type DayTotals } from '../overview'
import { shiftDayKey } from '../../shared/days'
import type { ViewKit } from '../viewkit'

/** 用量图的输入；窗口由 `today` 算出，而不是由区间选择器决定。 */
export interface OverviewUsageProps {
  /** 合并后的每日台账（日 key → 当天的数字）。 */
  days: Record<string, DayTotals>
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

/** 绑定 `kit`，返回这条 token 日图；整周都为空时渲染空提示。 */
export function makeOverviewUsage(kit: ViewKit): (props: OverviewUsageProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewUsage(props: OverviewUsageProps): ReactElement {
    const window = usageWindowOf(props.today)
    // 放宽了类型：Record 的下标读取在运行时可能落空。
    const byKey: Record<string, DayTotals | undefined> = props.days
    const columns = window.map(key => ({ key, entry: byKey[key] }))
    const empty = columns.every(c => c.entry === undefined || c.entry.tokens <= 0)
    let maxTokens = 0
    for (const c of columns) {
      if (c.entry === undefined) continue
      if (c.entry.tokens > maxTokens) maxTokens = c.entry.tokens
    }
    const heightOf = (value: number, max: number): string => (max <= 0 || value <= 0 ? '0%' : `${Math.max(4, Math.round((value / max) * 100))}%`)
    const tickOf = (percent: number): string => fmt(Math.round((maxTokens * percent) / 100))
    return (
      <div className="lc-card lc-ov-usage">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('ov.usage.title')}</span>
        </div>
        {empty || window.length === 0
          ? <div className="lc-empty">{t('ov.usage.empty')}</div>
          : (
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
                    const label = `${c.key}\n${t('ov.usage.tokens')} ${fmt(tokens)}`
                    return (
                      <div key={c.key} className="lc-ov-usage-col" data-lc-tip={label}>
                        <div className="lc-ov-usage-bars">
                          <span
                            className="lc-ov-usage-bar lc-ov-usage-tokens"
                            style={{ height: heightOf(tokens, maxTokens) }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
              {/* 日期条是绘图网格在图表自己那一列中的第 2 行，
                  所以每个标签都按构造居中于它所属的列之下——没有任何镜像几何
                  需要保持同步。 */}
              <div className="lc-ov-usage-days" aria-hidden="true">
                {columns.map(c => <span key={c.key} className="lc-ov-usage-day">{c.key.slice(5)}</span>)}
              </div>
            </div>
          )}
        <div className="lc-ov-usage-key" aria-hidden="true">
          <span className="lc-ov-usage-swatch lc-ov-usage-tokens" />
          <span className="lc-ov-usage-key-label">{t('ov.usage.tokens')}</span>
        </div>
      </div>
    )
  }
}
