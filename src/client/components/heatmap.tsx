/** Context Insights 页面的活动热力图：一张 GitHub 风格的贡献网格
 * （周为列，以周日开头的星期为行，每个月开始的那一列上方有一个月份标签——
 * 窗口的第一列永远带标签——
 * 外加一个 Less→More 的深浅图例），画在合并后的每日
 * 台账（overview.ts）之上。单元格的深浅是所选指标相对窗口峰值的占比——
 * 即当日去重活动会话数或结算步骤数；一个会话
 * 可以把它的步骤稀稀落落铺在很多天，而另一天则堆上一整串，
 * 所以两个指标各自按「自己」的峰值缩放——共四档；有数据的那天是一个按钮，点击
 * 会把会话列表钉到那一天（再点一次释放）。单元格把
 * 自己的提示（日期、当天活动会话数与步骤数）放在
 * `data-lc-tip` 里，由页面 portal 出去的悬停提示（hoverTip.tsx）呈现——
 * 悬停即时响应，而原生 `title` 要慢上一秒。网格由注入的 `today` key 算出，所以
 * 测试里布局是确定的，运行时则跟随浏览器的本地日历。 */

import type { ReactElement } from 'react'
import { dayKeyOf, shiftDayKey, sundayOfWeek } from '../../shared/days'
import { type DayTotals } from '../overview'
import type { ViewKit } from '../viewkit'

/** 热力图的深浅指标：当日的去重活动会话数，或它的结算步骤数。 */
export type HeatMetric = 'sessions' | 'steps'

/** 热力图的输入；`today` 注入进来以便测试中网格是确定的，
 *  `selected`/`onSelect` 则把日期钉选沿页面往下传。 */
export interface HeatmapProps {
  /** 合并后的台账（日 key → 当天的数字）。 */
  days: Record<string, DayTotals>
  /** 要画的列数（默认 8——两个月）。 */
  weeks?: number
  /** 为单元格深浅定价的指标（默认 steps）。 */
  metric?: HeatMetric
  /** 列表被过滤到某一天时，那个被钉住的日 key。 */
  selected?: string | null
  /** 日期钉选中继；没有数据的日子不响应。 */
  onSelect?: (day: string | null) => void
  /** 本地今天的 key（注入进来以便测试固定日历）。 */
  today: string
}

/** 一个网格单元格：它的 key、它的台账条目（undefined = 无活动），以及它是否在未来。 */
interface HeatCell {
  key: string
  entry?: DayTotals
  future: boolean
}

/** 铺排网格：`weeks` 列，以今天所在的那一周收尾，每列七个
 * 以周日开头的单元格（第 0 行 = 周日）。`today`（或它的
 * 周运算）失败时返回 null——一个损坏的注入 key 让卡片降级为它的空提示。 */
export function gridOf(today: string, weeks: number): HeatCell[][] | null {
  const lastSunday = sundayOfWeek(today)
  if (lastSunday === null || weeks < 1) return null
  const firstSunday = shiftDayKey(lastSunday, -7 * (weeks - 1))
  if (firstSunday === null) return null
  const columns: HeatCell[][] = []
  for (let w = 0; w < weeks; w++) {
    const sunday = shiftDayKey(firstSunday, 7 * w)
    /* sunday 受 firstSunday 与 lastSunday 夹住（两者都
     * 已证明有效），所以它永远不会离开可表示范围；留着这个守卫是为了让
     * 将来 shiftDayKey 的改动无法把 null 漏进网格。 */
    if (sunday === null) return null
    const column: HeatCell[] = []
    for (let d = 0; d < 7; d++) {
      const key = shiftDayKey(sunday, d)
      if (key === null) return null
      column.push({ key, future: key > today, entry: undefined })
    }
    columns.push(column)
  }
  return columns
}

/** 单元格的深浅档位：空，然后四档一直升到窗口的峰值。这些档位是
 *  该指标自身峰值的四分位，所以任何窗口都能填满整个 0–4 刻度。 */
function levelOf(tokens: number, max: number): number {
  if (tokens <= 0 || max <= 0) return 0
  const ratio = tokens / max
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/** 绑定 `kit`，返回贡献网格；`today` 损坏时降级为空提示。 */
export function makeHeatmap(kit: ViewKit): (props: HeatmapProps) => ReactElement {
  const { t } = kit
  return function Heatmap(props: HeatmapProps): ReactElement {
    const weeks = props.weeks ?? 8
    const metric = props.metric ?? 'steps'
    const columns = gridOf(props.today, weeks)
    if (columns === null) return <div className="lc-empty">{t('ov.heat.empty')}</div>
    // 把台账并到网格上并给深浅刻度定价。这里放宽了类型：日 key 的读取在运行时可能落空。
    const byKey: Record<string, DayTotals | undefined> = props.days
    let maxSessions = 0
    let maxSteps = 0
    let any = false
    for (const column of columns) {
      for (const cell of column) {
        const entry = byKey[cell.key]
        if (entry === undefined || (entry.tokens <= 0 && entry.requests <= 0)) continue
        cell.entry = entry
        any = true
        // 两个峰值彼此独立：会话数与步骤数对窗口内各天的
        // 刻画方式不同（一个长会话每天只丢下一个步骤；而另一天
        // 堆上一整串），所以两个指标都不按对方的峰值缩放。
        if (entry.sessions > maxSessions) maxSessions = entry.sessions
        if (entry.requests > maxSteps) maxSteps = entry.requests
      }
    }
    if (!any) return <div className="lc-empty">{t('ov.heat.empty')}</div>
    const max = metric === 'sessions' ? maxSessions : maxSteps
    const metricValueOf = (entry: DayTotals): number => (metric === 'sessions' ? entry.sessions : entry.requests)
    // 以周日开头的行下标为 key（0=周日..6=周六）——标签就落在
    // 它所命名的行上，任何行运算都无法让它移位。
    const weekdayLabels: Record<number, string> = { 1: t('ov.heat.wd.1'), 3: t('ov.heat.wd.3'), 5: t('ov.heat.wd.5') }
    return (
      <div className="lc-heat-wrap">
        <div className="lc-heat" role="group" aria-label={t('ov.heat.title')}>
          <div className="lc-heat-wds" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5, 6].map(row => (
              <span key={row} className="lc-heat-wd">{weekdayLabels[row] ?? ''}</span>
            ))}
          </div>
          <div className="lc-heat-cols">
            {columns.map((column, wi) => {
              // 当某个月在列内「开始」时该列才带标签：月份
              // 在它的周日与周六之间变化，或者它的周日就是
              // 1 号。标签写的是周六所属的月份——两种情形下都是新月份。
              // 窗口的第一列永远带标签，所以一个在窗口边缘
              // 已经开始的月份也会被点名。
              const opens = wi === 0 || column[0].key.slice(0, 7) !== column[6].key.slice(0, 7) || column[0].key.slice(8, 10) === '01'
              return (
                <div key={wi} className="lc-heat-col">
                  {opens && <span className="lc-heat-mon" aria-hidden="true">{t('ov.heat.mon.' + column[6].key.slice(5, 7))}</span>}
                  {column.map((cell) => {
                    if (cell.future) return <span key={cell.key} className="lc-heat-cell lc-heat-future" aria-hidden="true" />
                    const level = cell.entry === undefined ? 0 : levelOf(metricValueOf(cell.entry), max)
                    if (cell.entry === undefined) {
                      return <span key={cell.key} className="lc-heat-cell lc-heat-0" data-lc-tip={cell.key} />
                    }
                    const picked = props.selected === cell.key
                    const label = `${cell.key}\n${t('ov.heat.sessions', { n: cell.entry.sessions })}\n${t('ov.heat.steps', { n: cell.entry.requests })}`
                    return (
                      <button
                        key={cell.key}
                        type="button"
                        className={`lc-heat-cell lc-heat-${String(level)}${picked ? ' lc-heat-on' : ''}`}
                        data-lc-tip={label}
                        aria-label={label}
                        aria-pressed={picked}
                        onClick={() => { if (props.onSelect !== undefined) props.onSelect(picked ? null : cell.key) }}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
        {/* GitHub 的 Less→More 图例：色块复用网格自己的深浅
            类，所以图例永远不会与它所解释的单元格脱节。 */}
        <div className="lc-heat-legend" aria-hidden="true">
          <span className="lc-heat-key">{t('ov.heat.less')}</span>
          {[0, 1, 2, 3, 4].map(level => (
            <span key={level} className={`lc-heat-cell lc-heat-${String(level)}`} />
          ))}
          <span className="lc-heat-key">{t('ov.heat.more')}</span>
        </div>
      </div>
    )
  }
}

/** 为面板重新导出：渲染时刻的今天 key（null 安全）。 */
export function todayKey(): string {
  /* Date.now() 永远是合法的本地日期，所以 dayKeyOf 的 null 分支
   * 在这里不可达；'' 兜底只是为这道接缝补类型。 */
  return dayKeyOf(Date.now()) ?? ''
}
