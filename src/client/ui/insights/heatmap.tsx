/**
 * The activity heatmap: a GitHub-style contribution grid over the merged daily ledger, one column per
 * week (Sunday-first rows), with a month caption above the columns that open a month and a
 * Less → More legend.
 *
 * A cell's depth is the chosen metric relative to **its own** window peak. The two metrics cannot
 * share a scale: one long session drops a single step on each of many days, while another day piles
 * up a whole run of them, so `sessions` and `steps` are each scaled against themselves.
 *
 * Only a day with **real activity** becomes a button: a ledger entry that exists but carries neither
 * tokens nor requests is not an active day, and pinning it would filter the list down to nothing.
 */

import type { ReactElement } from 'react'
import { shiftDayKey, weekStartOf } from '../../../core/day'
import type { DayTotals } from '../../data/aggregate'
import type { Translate } from '../../i18n/dict'

/** The depth metric: distinct active sessions that day, or the day's completed steps. */
export type HeatMetric = 'sessions' | 'steps'

/** Default window: eight Sunday-first columns (about two months). */
const DEFAULT_WEEKS = 8
/** The same window in days, exported so the daily aggregate can cover exactly what this grid draws. */
export const HEATMAP_DAYS = DEFAULT_WEEKS * 7

export interface HeatmapProps {
  /** Merged daily ledger, keyed by `YYYY-MM-DD`. */
  days: ReadonlyMap<string, DayTotals>
  /** Column count; today's week is the last one. */
  weeks?: number
  /** Depth metric (default `steps`). */
  metric?: HeatMetric
  /** The day the list is currently pinned to, when any. */
  selected?: string | null
  /** Pin toggle: a day key, or `null` to release. Never called for a day without activity. */
  onSelect?: (day: string | null) => void
  /** Local today as `YYYY-MM-DD`, injected so tests pin the calendar. */
  today: string
  t: Translate
}

/** One grid cell: its key, its ledger entry (absent = no activity), and whether it lies in the future. */
interface HeatCell {
  key: string
  entry?: DayTotals
  future: boolean
}

/** Lay the grid out as `weeks` columns ending in today's week. A broken injected day (or an
 * impossible week shift) returns `null`, and the card degrades to its empty state rather than
 * drawing a skewed calendar. */
function gridOf(today: string, weeks: number): HeatCell[][] | null {
  const lastSunday = weekStartOf(today)
  if (lastSunday === null || weeks < 1) return null
  const firstSunday = shiftDayKey(lastSunday, -7 * (weeks - 1))
  if (firstSunday === null) return null
  const columns: HeatCell[][] = []
  for (let week = 0; week < weeks; week++) {
    const sunday = shiftDayKey(firstSunday, 7 * week)
    // `sunday` is bracketed by two proven keys, so it cannot leave the representable range; the guard
    // stays so a future change to `shiftDayKey` cannot leak a null into the grid.
    if (sunday === null) return null
    const column: HeatCell[] = []
    for (let day = 0; day < 7; day++) {
      const key = shiftDayKey(sunday, day)
      if (key === null) return null
      column.push({ key, future: key > today })
    }
    columns.push(column)
  }
  return columns
}

/** Depth bracket as a fraction of the metric's own peak: empty, then four ascending levels. */
function levelOf(value: number, peak: number): number {
  if (value <= 0 || peak <= 0) return 0
  const ratio = value / peak
  if (ratio <= 0.25) return 1
  if (ratio <= 0.5) return 2
  if (ratio <= 0.75) return 3
  return 4
}

/** Whether a ledger entry describes a day something actually happened on. */
function active(entry: DayTotals | undefined): entry is DayTotals {
  return entry !== undefined && (entry.tokens > 0 || entry.requests > 0)
}

/** The grid, its month rail, its weekday rail and the Less → More key. */
export function Heatmap(props: HeatmapProps): ReactElement {
  const { t } = props
  const metric = props.metric ?? 'steps'
  const columns = gridOf(props.today, props.weeks ?? DEFAULT_WEEKS)
  if (columns === null) return <div className="cb-ov-empty">{t('ov.heat.empty')}</div>
  let peakSessions = 0
  let peakSteps = 0
  let any = false
  for (const column of columns) {
    for (const cell of column) {
      const entry = props.days.get(cell.key)
      if (!active(entry)) continue
      cell.entry = entry
      any = true
      if (entry.sessions > peakSessions) peakSessions = entry.sessions
      if (entry.requests > peakSteps) peakSteps = entry.requests
    }
  }
  if (!any) return <div className="cb-ov-empty">{t('ov.heat.empty')}</div>
  const peak = metric === 'sessions' ? peakSessions : peakSteps
  const valueOf = (entry: DayTotals): number => (metric === 'sessions' ? entry.sessions : entry.requests)
  // Rows are keyed by weekday, so a label always sits on the row it names: any row arithmetic that
  // shifted the labels would be caught by the grid itself.
  const weekdayLabels: Record<number, string> = {
    1: t('ov.heat.wd.1'),
    3: t('ov.heat.wd.3'),
    5: t('ov.heat.wd.5'),
  }
  return (
    <div className="cb-ov-heat-wrap">
      <div className="cb-ov-heat" role="group" aria-label={t('ov.heat.title')}>
        <div className="cb-ov-heat-wds" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5, 6].map(row => (
            <span key={row} className="cb-ov-heat-wd">{weekdayLabels[row] ?? ''}</span>
          ))}
        </div>
        <div className="cb-ov-heat-cols">
          {columns.map((column, index) => {
            // The caption belongs to the column where a month *opens*: a month change inside the
            // column, a Sunday that is the first of a month, or the window's first column (so a
            // month already under way at the left edge is still named).
            const opens = index === 0
              || column[0].key.slice(0, 7) !== column[6].key.slice(0, 7)
              || column[0].key.slice(8, 10) === '01'
            return (
              <div key={column[0].key} className="cb-ov-heat-col">
                {opens && (
                  <span className="cb-ov-heat-mon" aria-hidden="true">
                    {t('ov.heat.mon.' + column[6].key.slice(5, 7))}
                  </span>
                )}
                {column.map((cell) => {
                  if (cell.future) {
                    return <span key={cell.key} className="cb-ov-heat-cell cb-ov-heat-future" aria-hidden="true" />
                  }
                  const entry = cell.entry
                  if (entry === undefined) {
                    return <span key={cell.key} className="cb-ov-heat-cell cb-ov-heat-0" data-tip={cell.key} />
                  }
                  const level = levelOf(valueOf(entry), peak)
                  const picked = props.selected === cell.key
                  const label = `${cell.key}\n${t('ov.heat.sessions', { n: entry.sessions })}\n${t('ov.heat.steps', { n: entry.requests })}`
                  return (
                    <button
                      key={cell.key}
                      type="button"
                      className={`cb-ov-heat-cell cb-ov-heat-${String(level)}${picked ? ' cb-ov-heat-on' : ''}`}
                      data-tip={label}
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
      {/* The legend reuses the cell's own level classes, so it can never drift from what it explains. */}
      <div className="cb-ov-heat-legend" aria-hidden="true">
        <span className="cb-ov-heat-key">{t('ov.heat.less')}</span>
        {[0, 1, 2, 3, 4].map(level => (
          <span key={level} className={`cb-ov-heat-cell cb-ov-heat-${String(level)}`} />
        ))}
        <span className="cb-ov-heat-key">{t('ov.heat.more')}</span>
      </div>
    </div>
  )
}
