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

import { useState, type ReactElement } from 'react'
import type { Translate } from '../../i18n/dict'
import { formatCount, formatShare } from '../../i18n/format'
import { formatCost, formatCredits, formatNativeSpend, type Currency, type SpendCurrency } from '../../data/cost'
import { modelSpendRowsOf, type PlatformSpend } from '../../data/platformSpend'
import { isDeepSeekRoute } from '../../../core/providers'
import { PLATFORM_COLORS, Donut, SliceList, type SliceRow } from './donut'

/** The spend figure a platform card shows. Money uses the **platform's own** billing currency, not
 * the UI's: an account billed in CNY but displayed in USD no longer reads as its own bill. */
export function platformSpendText(row: PlatformSpend, t: Translate): string {
  if (row.unit === 'credits') return `${formatCredits(row.value)} ${t('costStat.unit.credits')}`
  return formatNativeSpend(row.value, row.currency ?? 'USD')
}

/** A platform's display name: the two official DeepSeek routes read as the familiar product name;
 * every other provider id is printed verbatim, because the id is the factual identity. */
export function platformDisplayName(provider: string, t: Translate): string {
  return isDeepSeekRoute(provider) ? t('dock.platform.deepseek') : provider
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
  const money = (usd: number): string => formatNativeSpend(usd, (row.currency ?? 'USD') as SpendCurrency)
  const valueText = isCredit ? formatCredits(row.value) : money(row.value)
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
    count: isCredit ? formatCredits(segment.value) : money(segment.value),
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
                  ? t('spendDetail.unpriced')
                  : isCredit ? formatCredits(line.value) : money(line.value)}
              </td>
              <td className="cb-ov-pf-model-calls">{formatCount(line.calls)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
