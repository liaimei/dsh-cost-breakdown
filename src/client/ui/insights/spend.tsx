/**
 * Per-platform spend cards — **one card per platform**, never a grand total.
 *
 * Why the split is mandatory: DeepSeek bills CNY per token (with peak/off-peak windows), a third-party
 * route bills USD per token, and a credit platform bills per request. Adding those into one number
 * adds two currencies and a request count together, and the result means nothing. Each card therefore
 * speaks only its own unit, and the section head says so.
 *
 * The per-model table lives **inside** each card: starting a separate table would only copy the same
 * numbers onto a second surface. An unpriced model reads "no rate configured" — never a `0` that
 * claims those calls were free.
 */

import { createElement as h, useState, type ReactElement } from 'react'
import type { Translate } from '../../i18n/dict'
import { formatCount, formatShare } from '../../i18n/format'
import { formatCost, formatCredits, formatNativeSpend, type Currency, type SpendCurrency } from '../../data/cost'
import { modelSpendRowsOf, type PlatformSpend, type PlanSpend } from '../../data/platformSpend'
import { isDeepSeekRoute, isRelayRoute } from '../../../core/providers'
import { WEEKS_PER_MONTH, tierValueOf } from '../../../core/plans'
import { PLATFORM_COLORS, Donut, SliceList, type SliceRow } from './donut'

/** The spend figure a platform card shows. Money uses the **platform's own** billing currency, not
 * the UI's: an account billed in CNY but displayed in USD no longer reads as its own bill. */
export function platformSpendText(row: PlatformSpend, t: Translate): string {
  if (row.unit === 'plan') {
    // A subscription's figure is quota consumed, in the plan's own credit unit — never a currency.
    const plan = row.plan
    if (plan === undefined) return '—'
    const quota = plan.tier === null || plan.tier === undefined
      ? null
      : plan.tier.creditsWeek ?? plan.tier.creditsMonth ?? null
    if (quota === null) return t('plan.unmetered')
    return `${formatCredits(row.value)} ${t('plan.unit')}`
  }
  if (row.unit === 'credits') return `${formatCredits(row.value)} ${t('costStat.unit.credits')}`
  return formatNativeSpend(row.value, row.currency ?? 'USD')
}

/** A platform's display name: the two official DeepSeek routes read as the familiar product name;
 * every other provider id is printed verbatim, because the id is the factual identity. */
export function platformDisplayName(provider: string, t: Translate): string {
  if (isDeepSeekRoute(provider)) return t('dock.platform.deepseek')
  // A relay's account rows (`woyao-pro-1`, `woyao-pro-2`) are one platform with several credential
  // slots; printing the row id would read as two unrelated platforms on the summary.
  if (isRelayRoute(provider)) return t('platform.relay')
  return provider
}

/** A platform's remaining quota, already formatted, keyed by provider id. */
export type PlatformBalanceTexts = Readonly<Record<string, { text: string } | undefined>>

export interface PlatformCardsProps {
  rows: readonly PlatformSpend[]
  /** Display currency (language-dependent) — kept for layout parity with the other cards; the money
   * cells themselves always use each platform's own currency. */
  currency: Currency
  /** Remaining balance/quota per platform; a missing entry renders no footer cell at all. */
  balances?: PlatformBalanceTexts
  t: Translate
}

/** One card per platform, in the order the aggregation already sorted (value desc, then name). */
export function PlatformCards(props: PlatformCardsProps): ReactElement | null {
  const { t } = props
  if (props.rows.length === 0) return null
  return (
    <>
      {props.rows.map(row => (
        <PlatformCard
          key={row.provider}
          row={row}
          balances={props.balances}
          t={t}
        />
      ))}
    </>
  )
}

/** One platform's card. Hover state is per card so one card's legend never lights another's arcs. */
function PlatformCard(props: { row: PlatformSpend; balances?: PlatformBalanceTexts; t: Translate }): ReactElement {
  const { t, row } = props
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const isCredit = row.unit === 'credits'
  const isPlan = row.unit === 'plan'
  // A relay card explains itself: its models are unpriceable until the user declares the relay's own
  // rate, and "no rate configured" alone would leave the reader without the next step.
  const isRelay = isRelayRoute(row.provider)
  const money = (usd: number): string => formatNativeSpend(usd, (row.currency ?? 'USD') as SpendCurrency)
  const valueText = isPlan
    ? `${formatCredits(row.value)} ${t('plan.unit')}`
    : isCredit ? formatCredits(row.value) : money(row.value)
  // Segments come from the same `byModel` the total came from, so their sum always equals it. Only
  // models that actually spent something become arcs; a zero arc draws a zero-length band.
  const segments = row.models
    .map((model, index) => ({
      key: model,
      color: PLATFORM_COLORS[index % PLATFORM_COLORS.length],
      value: row.byModel?.[model] ?? 0,
    }))
    .filter(segment => segment.value > 0)
  const segmentTotal = segments.reduce((sum, segment) => sum + segment.value, 0)
  const legend: SliceRow[] = segments.map(segment => ({
    key: segment.key,
    color: segment.color,
    label: segment.key,
    pct: formatShare(segment.value, segmentTotal),
    count: isPlan || isCredit ? formatCredits(segment.value) : money(segment.value),
  }))
  const balance = props.balances?.[row.provider]
  return (
    <div className="cb-ov-card cb-ov-card-donut cb-ov-pf-card" data-unit={row.unit}>
      <div className="cb-ov-card-title">
        <span className="cb-ov-card-title-text">{platformDisplayName(row.provider, t)}</span>
        {/* The unit has to be spelled out: the same digits mean completely different things under
            credits and under a currency. */}
        <span className="cb-ov-card-rate" title={t('costStat.balanceTip')}>
          {valueText}
          {isCredit ? ' ' + t('costStat.unit.credits') : ''}
        </span>
      </div>
      {segments.length > 0
        ? (
          <div className="cb-ov-donut-row">
            <Donut
              segments={segments}
              size={96}
              centerTop={valueText}
              centerSub={t('costStat.total')}
              hoverKey={hoverKey}
              onHoverKey={setHoverKey}
            />
            <SliceList rows={legend} hoverKey={hoverKey} onHoverKey={setHoverKey} />
          </div>
        )
        : null}
      {/* Per-model detail: model / spend / calls. The header cells are not optional — two
          right-aligned number columns without them read `198.11` and `1.8k` as the same number. */}
      <table className="cb-ov-pf-models">
        <thead>
          <tr>
            <th className="cb-ov-pf-model-name">{t('dock.model')}</th>
            <th className="cb-ov-pf-model-spend">{t('costStat.spendLabel')}</th>
            <th className="cb-ov-pf-model-calls">{t('costStat.callsLabel')}</th>
          </tr>
        </thead>
        <tbody>
          {modelSpendRowsOf(row).map(line => (
            <tr key={line.model} className={line.value === null ? 'cb-ov-pf-model-unpriced' : undefined}>
              <td className="cb-ov-pf-model-name" title={line.model}>{line.model}</td>
              <td className="cb-ov-pf-model-spend">
                {line.value === null
                  ? t(isPlan ? 'plan.noRate' : isRelay ? 'spendDetail.relayUnpriced' : 'spendDetail.unpriced')
                  : isPlan || isCredit ? formatCredits(line.value) : money(line.value)}
              </td>
              <td className="cb-ov-pf-model-calls">{formatCount(line.calls)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* A subscription speaks in quota, not in a bill: the tier in force, how much of the monthly
          quota this usage ate, and what that share of the fee amounts to. The metered equivalent is
          printed beside it so the saving is a number rather than a claim. */}
      {isPlan && row.plan !== undefined
        ? h(PlanPanel, { plan: row.plan, metered: row.planMetered ?? null, t })
        : null}
      {isRelay && modelSpendRowsOf(row).some(line => line.value === null)
        ? h('div', { className: 'cb-ov-pf-relay-note' }, t('spendDetail.relayTip'))
        : null}
      {/* The platform's own call total and remaining quota. */}
      <div className="cb-ov-sc-periods">
        <span className="cb-ov-sc-period">
          <span className="cb-ov-sc-period-label">{t('costStat.callsLabel')}</span>
          <b>{formatCount(row.calls)}</b>
        </span>
        {balance !== undefined
          ? (
            <span className="cb-ov-sc-period" title={t('costStat.balanceTip')}>
              <span className="cb-ov-sc-period-label">{t('costStat.balanceLabel')}</span>
              <b>{balance.text}</b>
            </span>
          )
          : null}
      </div>
    </div>
  )
}

/** The subscription block inside a plan-billed platform card.
 *
 * Every field is conditional: a plan whose price or credit rule the vendor does not publish shows the
 * published half and says so, instead of a zero that would read as "free". */
function PlanPanel(props: { plan: PlanSpend; metered: number | null; t: Translate }): ReactElement {
  const { plan, metered, t } = props
  const { family, tier } = plan
  // The plan's own prices are quoted in yuan; the symbol follows the number like every other money
  // figure on these surfaces.
  const money = (value: number): string => `${value.toFixed(2)} ¥`
  const sharePct = plan.share === null ? null : Math.min(plan.share * 100, 9999)
  const saving = metered !== null && plan.feeCny !== null ? metered - plan.feeCny : null
  return (
    <div className="cb-ov-plan" data-plan={family.id}>
      <div className="cb-ov-plan-head">
        <span className="cb-ov-plan-name">{family.label}</span>
        {tier !== null
          ? <span className="cb-ov-plan-tier" title={`${t('plan.tierTip')} · ${family.tiers.map(row => row.label).join(' / ')}`}>{tier.label}</span>
          : null}
      </div>
      <div className="cb-ov-sc-periods">
        <span className="cb-ov-sc-period">
          <span className="cb-ov-sc-period-label">{t('plan.creditsLabel')}</span>
          <b>{formatCredits(plan.credits)}</b>
        </span>
        {sharePct !== null
          ? (
            <span className="cb-ov-sc-period" title={t('plan.shareLabel')}>
              <span className="cb-ov-sc-period-label">{t('plan.shareLabel')}</span>
              <b>{sharePct < 0.1 ? '<0.1' : sharePct.toFixed(1)}%</b>
            </span>
          )
          : null}
        {plan.feeCny !== null
          ? (
            <span className="cb-ov-sc-period">
              <span className="cb-ov-sc-period-label">{t('plan.feeLabel')}</span>
              <b>{money(plan.feeCny)}</b>
            </span>
          )
          : null}
        {tier !== null && tier.monthlyCny !== null
          ? (
            <span className="cb-ov-sc-period">
              <span className="cb-ov-sc-period-label">{t('plan.monthly')}</span>
              <b>{money(tier.monthlyCny)}</b>
            </span>
          )
          : null}
        {tier !== null && tier.credits5h !== null
          ? (
            <span className="cb-ov-sc-period">
              <span className="cb-ov-sc-period-label">{t('plan.quota5h')}</span>
              <b>{formatCount(tier.credits5h)}</b>
            </span>
          )
          : null}
        {tier !== null && tier.creditsWeek !== null
          ? (
            <span className="cb-ov-sc-period">
              <span className="cb-ov-sc-period-label">{t('plan.quotaWeek')}</span>
              <b>{formatCount(tier.creditsWeek)}</b>
            </span>
          )
          : null}
        {tier !== null && typeof tier.creditsMonth === 'number' && tier.creditsMonth > 0
          ? (
            <span className="cb-ov-sc-period">
              <span className="cb-ov-sc-period-label">{t('plan.quotaMonth')}</span>
              <b>{formatCount(tier.creditsMonth)}</b>
            </span>
          )
          : null}
      </div>
      {metered !== null
        ? (
          <div className="cb-ov-plan-note" title={t('plan.meteredTip')}>
            <span>{t('plan.meteredLabel')}</span>
            <b>{money(metered)}</b>
            {saving !== null
              ? <span className="cb-ov-plan-saving">{t('plan.saving')} {money(Math.max(saving, 0))}</span>
              : null}
          </div>
        )
        : null}
      {family.peak !== undefined
        ? (
          <div className="cb-ov-plan-note">
            {t('plan.peak', { from: family.peak.fromHour, to: family.peak.toHour, factor: family.peak.offPeakFactor })}
          </div>
        )
        : null}
      {tier === null || tier.monthlyCny === null || (tier.creditsWeek === null && typeof tier.creditsMonth !== 'number')
        ? (
          <div className="cb-ov-plan-note">
            {tier !== null && tier.creditsWeek === null && typeof tier.creditsMonth !== 'number'
              ? t('plan.unmetered')
              : t('plan.unpriced')}
          </div>
        )
        : null}
      <div className="cb-ov-plan-src">
        {t('plan.source')} <a href={family.source} target="_blank" rel="noreferrer">{family.source.replace(/^https?:\/\//, '')}</a>
      </div>
    </div>
  )
}

/** The section's opening line: the title, the "each in its own unit" note, and — when there is
 * anything to show — the platform count. Deliberately **no** sum: see the module comment. */
export function SpendHead(props: { t: Translate }): ReactElement {
  return (
    <div className="cb-ov-spend-head">
      <span className="cb-ov-spend-title">{props.t('ov.spend.title')}</span>
      <span className="cb-ov-spend-sub">{props.t('ov.spend.sub')}</span>
    </div>
  )
}

/** A money cell in the UI's display currency, used by the session card's cost label (where the figure
 * is a *whole-run* estimate rather than one platform's bill). */
export function displayCost(usd: number | null, currency: Currency): string {
  if (usd === null) return '—'
  return formatCost(usd, currency)
}
