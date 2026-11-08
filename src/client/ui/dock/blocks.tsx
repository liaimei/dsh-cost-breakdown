/**
 * The three blocks the dock card embeds, so the readout under the composer and the statistics page
 * report the same numbers in the same layout.
 *
 * Token accounting and money are kept apart on purpose: mixing them in one string invites the reader to
 * treat a token count and a currency as convertible. The token block therefore shows stages and billed
 * buckets only, and the cost block shows money only.
 */

import { createElement as h, useState, type ReactElement } from 'react'
import type { Translate } from '../../i18n/dict'
import { formatCount, formatShare, cacheHitPercent } from '../../i18n/format'
import { formatCost, formatCredits, formatNativeSpend, officialRows } from '../../data/cost'
import { STAGE_ORDER } from '../../data/aggregate'
import type { DockReading } from './reading'
import type { WalletState } from './reading'
import { modelSpendRowsOf } from '../../data/platformSpend'
import { Donut, SliceList, STAGE_COLORS, platformTintOf } from '../insights/donut'

/** The token block: stage composition of the live context plus the billed bucket split. */
export function StatsTokenBlock(props: { t: Translate; reading: DockReading }): ReactElement {
  const { t, reading } = props
  const current = reading.snapshot?.current
  const total = current?.total ?? 0
  const items = current === undefined
    ? []
    : STAGE_ORDER
      .map(key => ({ key, label: t(`cat.${key}`), value: current[key], color: STAGE_COLORS[key] }))
      .filter(item => item.value > 0)
  const [hover, setHover] = useState<string | null>(null)
  // The ring and the legend are the same data in two readings, so they share one hover state: pointing
  // at a legend row lights that arc, which is how a seven-category ring stays readable at 96px.
  return (
    <div className="cb-dock-card-block cb-dock-tokens">
      <div className="cb-dock-block-title">{t('tokens.title')}</div>
      <div className="cb-dock-donut-row">
        <Donut
          segments={items.map(item => ({ key: item.key, color: item.color, value: item.value }))}
          size={96}
          centerTop={formatCount(total)}
          centerSub={t('tokens.total')}
          hoverKey={hover}
          onHoverKey={setHover}
        />
        <SliceList
          rows={items.map(item => ({
            key: item.key,
            color: item.color,
            label: item.label,
            pct: formatShare(item.value, total),
            count: '≈' + formatCount(item.value),
          }))}
          hoverKey={hover}
          onHoverKey={setHover}
        />
      </div>
      <div className="cb-dock-sub cb-dock-tokens-note">{t('overview.estimate')}</div>
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
  const tint = platformTintOf(row.provider)
  if (row.unit === 'credits') {
    return (
      <div className="cb-dock-card-block">
        <div className="cb-dock-block-title">
          {t('costStat.title')}
          <i className="cb-dock-block-dot" style={{ background: tint }} />
          <span className="cb-dock-block-scope">{platformNameOf(row.provider, t)}</span>
        </div>
        <div className="cb-dock-token-total">
          <span className="cb-dock-figure">{formatCredits(row.value)}</span>
          <span className="cb-dock-sub">{t('costStat.unit.credits')}</span>
        </div>
      </div>
    )
  }
  // A subscription is billed in quota credits, never in money: printing the figure with a currency
  // symbol would claim a bill the plan already covers.
  if (row.unit === 'plan') {
    return (
      <div className="cb-dock-card-block">
        <div className="cb-dock-block-title">
          {t('costStat.title')}
          <i className="cb-dock-block-dot" style={{ background: tint }} />
          <span className="cb-dock-block-scope">{platformNameOf(row.provider, t)}</span>
        </div>
        <div className="cb-dock-token-total">
          <span className="cb-dock-figure">{formatCredits(row.value)}</span>
          <span className="cb-dock-sub">{t('costStat.unit.plan')}</span>
        </div>
        <div className="cb-dock-note">{t('costStat.planNote')}</div>
      </div>
    )
  }
  return (
    <div className="cb-dock-card-block">
      <div className="cb-dock-block-title">
        {t('costStat.title')}
        <i className="cb-dock-block-dot" style={{ background: tint }} />
        <span className="cb-dock-block-scope">{platformNameOf(row.provider, t)}</span>
      </div>
      <div className="cb-dock-token-total">
        <span className="cb-dock-figure">{formatNativeSpend(row.value, row.currency ?? 'USD')}</span>
        <span className="cb-dock-sub">{t('costStat.total')}</span>
      </div>
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
              const plan = row.unit === 'plan'
              const quota = wallet.credits?.[row.provider]
              return (
                <div key={row.provider} className="cb-dock-platform-line">
                  {/* The dot is the platform's stable tint: the same colour it carries in the cost
                      card and the dock row, so two lines are told apart without reading the ids. */}
                  <i className="cb-dock-platform-dot" style={{ background: platformTintOf(row.provider) }} />
                  <span className="cb-dock-platform-name">
                    {row.provider === 'deepseek-account' || row.provider === 'deepseek-official'
                      ? t('dock.platform.deepseek')
                      : row.provider}
                  </span>
                  <span className="cb-dock-spend">
                    {plan
                      // A subscription's figure is quota consumed, not money: pricing it would claim
                      // a bill the plan already covers.
                      ? t('dock.planSpent', { n: formatCredits(row.value) })
                      : credits
                        ? t('dock.creditsSpent', { n: formatCredits(row.value) })
                        : t('dock.moneySpent', { n: formatNativeSpend(row.value, row.currency ?? 'USD') })}
                  </span>
                  {/* Only a credit platform has a second figure worth printing (its remaining
                      balance). A call count was noise beside the amount: the amount is the answer,
                      and the count is already available in the statistics page. */}
                  {credits && quota !== undefined
                    ? <span className="cb-dock-sub">{t('dock.creditsLeft', { n: String(quota.total) })}</span>
                    : null}
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}

/** A platform's display name, shared so the block and the dock row cannot label one route differently. */
function platformNameOf(provider: string, t: Translate): string {
  return provider === 'deepseek-account' || provider === 'deepseek-official'
    ? t('dock.platform.deepseek')
    : provider
}

/** The official table's rows for a period, exposed for the card's rate table. */
export function officialRowsFor(peak: boolean): ReturnType<typeof officialRows> {
  void peak
  return officialRows()
}

/** A cost with its symbol, for callers that already converted. */
export { formatCost, cacheHitPercent }

/**
 * The subscription block: the plan in force, the tier the user selected, and — when the host could
 * read it — the live remaining quota per window, straight from the vendor's own usage API.
 *
 * The three states are deliberately distinct, because they mean opposite things:
 *   - **read** (`windows.length > 0`): a real figure with a freshness stamp;
 *   - **not readable** (no entry, or the host is unconfigured): "quota unavailable", never "0 left";
 *   - **no plan** (a metered route): the block is not rendered at all.
 */
export function PlanQuotaBlock(props: {
  t: Translate
  reading: DockReading
  wallet: WalletState
}): ReactElement {
  const { t, reading, wallet } = props
  const plan = reading.plan
  if (plan === null) {
    return (
      <div className="cb-dock-card-block">
        <div className="cb-dock-block-title">{t('plan.title')}</div>
        <div className="cb-dock-empty">{t('plan.none')}</div>
      </div>
    )
  }
  const quota = wallet.planQuotas?.[reading.active?.provider ?? ''] ?? null
  const tier = plan.tier
  return (
    <div className="cb-dock-card-block cb-dock-plan">
      <div className="cb-dock-block-title">{t('plan.title')}</div>
      <div className="cb-dock-plan-head">
        <i className="cb-dock-block-dot" style={{ background: platformTintOf(reading.active?.provider ?? '') }} />
        <span className="cb-dock-plan-name">{plan.family.label}</span>
        {tier !== null ? <span className="cb-dock-plan-tier">{tier.label}</span> : null}
      </div>
      {quota !== null
        ? (
          <div className="cb-dock-plan-windows">
            {quota.windows.map(window => {
              const left = Math.max(window.total - window.used, 0)
              const share = window.total > 0 ? left / window.total : 0
              return (
                <div key={window.label} className="cb-dock-plan-window">
                  <span className="cb-dock-plan-window-label">{windowLabel(t, window.label)}</span>
                  <span className="cb-dock-plan-bar" role="img" aria-label={`${Math.round(share * 100)}%`}>
                    <span className="cb-dock-plan-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
                  </span>
                  <span className="cb-dock-plan-window-value">
                    {formatCount(left)} / {formatCount(window.total)}
                  </span>
                </div>
              )
            })}
            <div className="cb-dock-plan-fresh">{t('plan.fresh', { time: clockOf(quota.at) })}</div>
          </div>
        )
        : <div className="cb-dock-plan-unreadable">{t('plan.unreadable')}</div>}
      {tier !== null && (tier.creditsWeek !== null || typeof tier.creditsMonth === 'number')
        ? (
          <div className="cb-dock-plan-quota">
            {tier.creditsWeek !== null
              ? h('span', null, `${t('plan.quotaWeek')} ${formatCount(tier.creditsWeek)}`)
              : null}
            {typeof tier.creditsMonth === 'number'
              ? h('span', null, `${t('plan.quotaMonth')} ${formatCount(tier.creditsMonth)}`)
              : null}
            {tier.monthlyCny !== null
              ? h('span', null, `${t('plan.monthly')} ${tier.monthlyCny} ¥`)
              : null}
          </div>
        )
        : null}
      <div className="cb-dock-plan-src">
        {t('plan.source')}{' '}
        <a href={plan.family.source} target="_blank" rel="noreferrer">
          {plan.family.source.replace(/^https?:\/\//, '')}
        </a>
      </div>
    </div>
  )
}

/** The vendor's own window label, translated when this build knows it. */
function windowLabel(t: Translate, label: string): string {
  const key = `plan.window.${label.toLowerCase()}`
  const translated = t(key)
  // A key neither dictionary carries comes back as the key itself; printing that would leak a
  // placeholder, so the vendor's label is used instead.
  return translated === key ? label : translated
}

/** `HH:MM` of an instant, in the reader's own zone. */
function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}
