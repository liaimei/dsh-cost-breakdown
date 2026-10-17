/**
 * The seven-day token columns — the only chart on the page that is **purely** token-denominated.
 *
 * Why no cost series: money has its own section (platform cards, each in its own unit), and putting
 * a second series on this plot would invite the reader to compare two quantities that share neither
 * a unit nor a scale.
 *
 * The plot is a three-column grid (rail · chart · rail) so the day strip is row two of the chart
 * column and every label is centred under its own bar by construction. The window is fixed at seven
 * days (today last); the range selector above governs the page's aggregates, not this calendar.
 */

import type { ReactElement } from 'react'
import type { DayTotals } from '../../data/aggregate'
import { formatCount } from '../../i18n/format'
import type { Translate } from '../../i18n/dict'

/** Grid lines and rail ticks at these percentages of the window peak. */
const TICKS: readonly number[] = [0, 25, 50, 75, 100]

export interface UsageBarsProps {
  /** One entry per day in the window, oldest first. */
  days: readonly DayTotals[]
  /** Local `YYYY-MM-DD` of today; injected so the layout is deterministic under test. */
  today: string
  t: Translate
}

/** Bar height as a percentage of the peak. Every non-zero bar keeps a 4% floor: a day with a single
 * call must stay visible, or the chart silently reads as an empty one. */
function heightOf(tokens: number, peak: number): string {
  if (peak <= 0 || tokens <= 0) return '0%'
  return `${Math.max(4, Math.round((tokens / peak) * 100))}%`
}

/** The seven columns. An empty or broken window renders the card's empty state rather than a plot
 * with a meaningless scale. */
export function UsageBars(props: UsageBarsProps): ReactElement {
  const { t } = props
  const days = props.days
  // `every` is true for an empty array, which is exactly the "nothing to draw" case.
  const empty = days.every(day => day.tokens <= 0)
  let peak = 0
  for (const day of days) if (day.tokens > peak) peak = day.tokens
  return (
    <div className="cb-ov-usage">
      {empty
        ? <div className="cb-ov-empty">{t('ov.usage.empty')}</div>
        : (
          <>
            <div className="cb-ov-usage-plot" role="group" aria-label={t('ov.usage.title')}>
              <div className="cb-ov-usage-rail" aria-hidden="true">
                {TICKS.map(percent => (
                  <span
                    key={percent}
                    className="cb-ov-usage-tick"
                    style={{ top: `${100 - percent}%` }}
                  >{formatCount(Math.round((peak * percent) / 100))}</span>
                ))}
              </div>
              <div className="cb-ov-usage-grid">
                {TICKS.map(percent => (
                  <span
                    key={percent}
                    className={'cb-ov-usage-line' + (percent === 0 ? ' cb-ov-usage-line-0' : '')}
                    style={{ bottom: `${percent}%` }}
                    aria-hidden="true"
                  />
                ))}
                <div className="cb-ov-usage-cols">
                  {days.map(day => (
                    <div
                      key={day.day}
                      className="cb-ov-usage-col"
                      data-tip={`${day.day}\n${t('ov.usage.tokens')} ${formatCount(day.tokens)}`}
                    >
                      <div className="cb-ov-usage-bars">
                        <span
                          className="cb-ov-usage-bar"
                          style={{ height: heightOf(day.tokens, peak) }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="cb-ov-usage-days" aria-hidden="true">
                {days.map(day => (
                  <span key={day.day} className="cb-ov-usage-day">{day.day.slice(5)}</span>
                ))}
              </div>
            </div>
            <div className="cb-ov-usage-key" aria-hidden="true">
              <span className="cb-ov-usage-swatch" />
              <span className="cb-ov-usage-key-label">{t('ov.usage.tokens')}</span>
            </div>
          </>
        )}
    </div>
  )
}
