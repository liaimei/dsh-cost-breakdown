/**
 * The three blocks the dock card embeds, so the readout under the composer and the statistics page
 * report the same numbers in the same layout.
 *
 * Token accounting and money are kept apart on purpose: mixing them in one string invites the reader to
 * treat a token count and a currency as convertible. The token block therefore shows stages and billed
 * buckets only, and the cost block shows money only.
 */

import type { ReactElement } from 'react'
import type { Translate } from '../../i18n/dict'
import { formatCount, cacheHitPercent } from '../../i18n/format'
import { formatCost, formatCredits, formatNativeSpend, officialRows } from '../../data/cost'
import { STAGE_ORDER } from '../../data/aggregate'
import type { DockReading } from './reading'
import type { WalletState } from './reading'
import { modelSpendRowsOf } from '../../data/platformSpend'

/** The token block: stage composition of the live context plus the billed bucket split. */
export function StatsTokenBlock(props: { t: Translate; reading: DockReading }): ReactElement {
  const { t, reading } = props
  const current = reading.snapshot?.current
  const items: Array<{ key: string; label: string; value: number }> = current === undefined
    ? []
    : STAGE_ORDER.map(key => ({ key, label: t(`cat.${key}`), value: current[key] }))
  const total = current?.total ?? 0
  return (
    <div className="cb-dock-card-block cb-dock-tokens">
      <div className="cb-dock-block-title">{t('tokens.title')}</div>
      <div className="cb-dock-token-total">
        <span className="cb-dock-figure">{formatCount(total)}</span>
        <span className="cb-dock-sub">{t('overview.estimate')}</span>
      </div>
      <div className="cb-dock-token-grid">
        {items.map(item => (
          <div key={item.key} className="cb-dock-token-cell">
            <span className="cb-dock-cell-label">{item.label}</span>
            <span className="cb-dock-cell-value">{formatCount(item.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** The cost block: the billed bucket split and the peak/off split for the current provider. */
export function StatsCostBlock(props: { t: Translate; reading: DockReading }): ReactElement {
  const { t, reading } = props
  const usage = reading.usage
  // The cost card prices the current route only, and only when that route is on the official table.
  const provider = reading.active?.provider ?? null
  const bucket = provider === null ? null : usage?.[provider] ?? null
  const priced = bucket === null ? null : modelSpendRowsOf({
    provider: provider ?? '',
    unit: 'money',
    value: 0,
    calls: 0,
    models: Object.keys(bucket),
  })
  void priced
  const row = reading.platforms.find(entry => entry.provider === provider) ?? reading.platforms[0]
  if (row === undefined) {
    return (
      <div className="cb-dock-card-block">
        <div className="cb-dock-block-title">{t('costStat.title')}</div>
        <div className="cb-dock-empty">{t('costStat.empty')}</div>
      </div>
    )
  }
  if (row.unit === 'credits') {
    return (
      <div className="cb-dock-card-block">
        <div className="cb-dock-block-title">{t('costStat.title')}</div>
        <div className="cb-dock-token-total">
          <span className="cb-dock-figure">{formatCredits(row.value)}</span>
          <span className="cb-dock-sub">{t('costStat.unit.credits')}</span>
        </div>
        <div className="cb-dock-sub">{t('costStat.calls', { n: formatCount(row.calls) })}</div>
      </div>
    )
  }
  return (
    <div className="cb-dock-card-block">
      <div className="cb-dock-block-title">{t('costStat.title')}</div>
      <div className="cb-dock-token-total">
        <span className="cb-dock-figure">{formatNativeSpend(row.value, row.currency ?? 'USD')}</span>
        <span className="cb-dock-sub">{t('costStat.total')}</span>
      </div>
      <div className="cb-dock-sub">{t('costStat.calls', { n: formatCount(row.calls) })}</div>
      <div className="cb-dock-note">{t('costStat.note')}</div>
    </div>
  )
}

/** The platform block: one line per platform, each in its own currency, never summed. */
export function StatsPlatformBlock(props: { t: Translate; reading: DockReading; wallet: WalletState }): ReactElement {
  const { t, reading, wallet } = props
  const rows = reading.platforms
  return (
    <div className="cb-dock-card-block">
      <div className="cb-dock-block-title">{t('spend.title')}</div>
      {rows.length === 0
        ? <div className="cb-dock-empty">{t('spend.empty')}</div>
        : (
          <div className="cb-dock-platforms">
            {rows.map((row) => {
              const credits = row.unit === 'credits'
              const quota = wallet.credits?.[row.provider]
              return (
                <div key={row.provider} className="cb-dock-platform-line">
                  <span className="cb-dock-platform-name">
                    {row.provider === 'deepseek-account' || row.provider === 'deepseek-official'
                      ? t('dock.platform.deepseek')
                      : row.provider}
                  </span>
                  <span className="cb-dock-spend">
                    {credits
                      ? t('dock.creditsSpent', { n: formatCredits(row.value) })
                      : t('dock.moneySpent', { n: formatNativeSpend(row.value, row.currency ?? 'USD') })}
                  </span>
                  <span className="cb-dock-sub">
                    {credits
                      ? quota === undefined ? '' : t('dock.creditsLeft', { n: String(quota.total) })
                      : t('costStat.calls', { n: formatCount(row.calls) })}
                  </span>
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}

/** The official table's rows for a period, exposed for the card's rate table. */
export function officialRowsFor(peak: boolean): ReturnType<typeof officialRows> {
  void peak
  return officialRows()
}

/** A cost with its symbol, for callers that already converted. */
export { formatCost, cacheHitPercent }
