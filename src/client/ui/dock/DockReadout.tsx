/**
 * The composer-row readout: one collapsed line, and a card that expands to the same numbers the
 * statistics page shows.
 *
 * Collapsed, it answers exactly one question — "what is this route costing me, and what is left?" — so
 * it shows the **current** route only, never a list of every platform. Expanded, it embeds the token
 * breakdown, the cost breakdown and the per-platform detail, plus the official rate table for the
 * period in force. One data path feeds both, so the row and the card cannot disagree.
 *
 * Narrow mode is not a breakpoint on the row's total width: the official pills and the context ring
 * already occupy part of that row, so the plugin can have a wide row and still have no room for itself.
 * See `measure.ts` for the arithmetic and why it uses needed (not squashed) sibling widths.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'
import type { DockSeatProps } from '../../shell/contracts'
import { useSnapshot, readingOf, usePeriod, useWallet, countdownPartsOf, balanceTextOf } from './reading'
import type { DockReading, PeriodView } from './reading'
import { usePriceBook } from '../insights/priceBook'
import { moneyRates } from '../../shell/rateTables'
import type { Currency } from '../../data/cost'
import {
  fromCny, formatCost, formatCredits, formatNativeSpend, officialRows, symbolOf, toCurrency,
} from '../../data/cost'
import { formatCountdown, formatCountdownCompact } from '../../i18n/format'
import { peakWindowsText } from '../../../core/clock'
import type { Translate } from '../../i18n/dict'
import { OFFICIAL_TABLE } from '../../../core/clock'
import { GlyphClock, GlyphInsights } from '../glyphs'
import { neededWidthOf, officialOverlayOpen, placeCard, roomForEntry, CARD_MIN_WIDTH } from './measure'
import { StatsCostBlock, StatsPlatformBlock, StatsTokenBlock } from './blocks'

/** The active locale's display currency: Chinese yuan for zh, dollars otherwise. */
function currencyOf(locale: () => string): Currency {
  try {
    return locale() === 'zh' ? 'cny' : 'usd'
  } catch {
    return 'usd'
  }
}

/** The dock seat's props plus the translator and locale reader the entry closure supplies. */
export interface DockProps extends DockSeatProps {
  t: Translate
  locale?: () => string
}

/** The composer-row readout. */
export function DockReadout(props: DockProps): ReactElement | null {
  const t = props.t
  const snapshot = useSnapshot(props)
  const book = usePriceBook()
  const reading = readingOf(snapshot, book, moneyRates())
  const period = usePeriod()
  const wallet = useWallet()
  const currency = currencyOf(props.locale ?? (() => 'en'))
  const [open, setOpen] = useState(false)
  // Cold read in flight: nothing to show yet, and a row of zeroes would be a lie.
  if (reading.snapshot === null) return null
  return (
    <Readout
      t={t}
      reading={reading}
      period={period}
      wallet={wallet}
      currency={currency}
      open={open}
      setOpen={setOpen}
    />
  )
}

/** The stateful body, split out so the hook order above stays flat. */
function Readout(props: {
  t: Translate
  reading: DockReading
  period: PeriodView
  wallet: ReturnType<typeof useWallet>
  currency: Currency
  open: boolean
  setOpen: (value: boolean) => void
}): ReactElement {
  const { t, reading, period, wallet, currency, open, setOpen } = props
  const trigger = useRef<HTMLButtonElement | null>(null)
  const probe = useRef<HTMLSpanElement | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  const ready = reading.snapshot !== null
  const periodLabel = t(period.peak ? 'dock.peak' : 'dock.off')
  const windows = peakWindowsText(t('dock.platform.deepseek') === 'DeepSeek' ? ', ' : '、')
  const countdown = formatCountdown(t, period.remainingMs)
  const countdownText = period.dayOff !== null || countdown === null
    ? null
    : t(period.peak ? 'dock.toOff' : 'dock.toPeak', { countdown })
  const compact = formatCountdownCompact(period.remainingMs)
  const periodTip = [
    t('dock.peakWindows', { windows }),
    period.dayOff === 'weekend' ? t('dock.weekendOff') : null,
    period.dayOff === 'holiday' ? t('dock.holidayOff') : null,
    countdownText,
  ].filter((part): part is string => part !== null).join(' · ')

  // The row verdict: needed width of the probe versus the room left after the siblings' needed widths.
  useLayoutEffect(() => {
    if (!ready) return
    const apply = (): void => {
      const row = trigger.current?.parentElement
      if (row === null || row === undefined) return
      const need = probe.current?.offsetWidth ?? 0
      const style = getComputedStyle(row)
      const siblings = [...row.children].filter(child => child !== trigger.current).map(child => neededWidthOf(child))
      const room = roomForEntry({
        rowWidth: row.clientWidth,
        paddingLeft: parseFloat(style.paddingLeft),
        paddingRight: parseFloat(style.paddingRight),
        siblingWidths: siblings,
        gap: parseFloat(style.columnGap),
      })
      // "Cannot measure" reads as "fits": show the full readout rather than degrading in an environment
      // that has no layout.
      setNarrow(room !== null && need > 0 && need > room)
    }
    apply()
    const row = trigger.current?.parentElement
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null
    if (row !== null && row !== undefined) {
      observer?.observe(row)
    }
    // `childList` only (no subtree): the row changing its own inner content must not re-measure.
    const mutation = typeof MutationObserver === 'function'
      ? new MutationObserver(apply)
      : null
    if (row !== null && row !== undefined) mutation?.observe(row, { childList: true })
    window.addEventListener('resize', apply)
    return () => {
      observer?.disconnect()
      mutation?.disconnect()
      window.removeEventListener('resize', apply)
    }
  }, [ready])

  // Yield to the official overlay at the same layer instead of raising this one.
  useEffect(() => {
    if (!open) return
    const close = (): void => { if (officialOverlayOpen()) setOpen(false) }
    close()
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(close)
      : null
    observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
    return () => { observer?.disconnect() }
  }, [open, setOpen])

  // Dismiss: outside mousedown, or Escape. Escape is handled here (not the shared capture-phase hook),
  // which would steal it from the composer.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (trigger.current?.contains(target) === true) return
      if (card.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  const shown = reading.shown
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`cb-dock${narrow ? ' cb-dock-narrow' : ''}`}
        data-peak={period.peak ? '1' : '0'}
        aria-expanded={open}
        title={periodTip}
        onClick={() => { setOpen(!open) }}
      >
        {shown.length === 0
          ? <span className="cb-dock-cost">—</span>
          : null}
        <GlyphInsights size={14} />
        {narrow
          ? null
          : shown.map((row, index) => (
            <span key={row.provider} className="cb-dock-platform" data-unit={row.unit}>
              {index > 0 ? <span className="cb-dock-sep">·</span> : null}
              <span className="cb-dock-platform-name">{platformLabel(row.provider, t)}</span>
              <span className="cb-dock-spend">
                {row.unit === 'credits'
                  ? t('dock.creditsSpent', { n: formatCredits(row.value) })
                  : t('dock.moneySpent', { n: formatNativeSpend(row.value, row.currency ?? 'USD') })}
              </span>
              <BalanceCell row={row} wallet={wallet} currency={currency} t={t} />
            </span>
          ))}
        {reading.onOfficialRates
          ? (
            <>
              <span className="cb-dock-sep">·</span>
              <span className="cb-dock-period">{periodLabel}</span>
            </>
          )
          : null}
        {/* The probe: always laid out at full width, so the verdict cannot oscillate. Narrow mode also
            shows the compact countdown beside the glyph. */}
        {narrow && compact !== null
          ? (
            <span className="cb-dock-count">
              <GlyphClock size={12} />
              <span>{compact}</span>
            </span>
          )
          : null}
        <span ref={probe} className="cb-dock-probe" aria-hidden="true">
          <GlyphInsights size={14} />
          <span>{probeText(t, reading, period, currency, balanceTextOf)}</span>
        </span>
      </button>
      {open
        ? createPortal(
          <DockCard
            ref={card}
            t={t}
            reading={reading}
            period={period}
            wallet={wallet}
            currency={currency}
            trigger={trigger.current}
            periodTip={periodTip}
            countdownText={countdownText}
            periodLabel={periodLabel}
            windows={windows}
            onClose={() => { setOpen(false) }}
          />,
          document.body,
        )
        : null}
    </>
  )
}

/** The probe's text: what the full readout would say. */
function probeText(t: Translate, reading: DockReading, period: PeriodView, currency: Currency, _balance: unknown): string {
  const parts: string[] = []
  for (const row of reading.shown) {
    parts.push(row.unit === 'credits'
      ? t('dock.creditsSpent', { n: formatCredits(row.value) })
      : t('dock.moneySpent', { n: formatNativeSpend(row.value, row.currency ?? 'USD') }))
  }
  if (reading.onOfficialRates) parts.push(t(period.peak ? 'dock.peak' : 'dock.off'))
  return parts.join(' · ')
}

/** A platform's display name: the two DeepSeek routes share one label, everything else prints its id. */
function platformLabel(provider: string, t: Translate): string {
  return provider === 'deepseek-account' || provider === 'deepseek-official'
    ? t('dock.platform.deepseek')
    : provider
}

/** The remaining-balance cell, or nothing at all when no figure is known. */
function BalanceCell(props: { row: { provider: string; unit: 'money' | 'credits'; currency?: 'CNY' | 'USD' }; wallet: ReturnType<typeof useWallet>; currency: Currency; t: Translate }): ReactElement | null {
  const known = balanceTextOf(props.row, props.wallet, props.currency, symbolOf)
  if (known === null) return null
  return known.credits
    ? <span className="cb-dock-left">{props.t('dock.creditsLeft', { n: known.text })}</span>
    : <span className="cb-dock-balance">{known.text}</span>
}

/** The expanded card. */
function DockCard(props: {
  ref: React.Ref<HTMLDivElement>
  t: Translate
  reading: DockReading
  period: PeriodView
  wallet: ReturnType<typeof useWallet>
  currency: Currency
  trigger: HTMLElement | null
  periodTip: string
  countdownText: string | null
  periodLabel: string
  windows: string
  onClose: () => void
}): ReactElement {
  const { t, reading, period, wallet, currency, trigger, periodLabel } = props
  const node = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const applied = useRef('')

  const place = (): void => {
    const element = node.current
    if (element === null || trigger === null) return
    const rect = trigger.getBoundingClientRect()
    // `scrollHeight` deliberately: once the card is clamped its box height equals `maxHeight`, and
    // re-deriving from it would loop.
    const natural = Math.max(element.offsetHeight, element.scrollHeight) || CARD_MIN_WIDTH + 96
    const cardWidth = element.getBoundingClientRect().width
    const placement = placeCard({
      trigger: { left: rect.left, top: rect.top, bottom: rect.bottom },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      natural,
      cardWidth,
    })
    const key = `${Math.round(placement.left)}|${Math.round(placement.top)}|${Math.round(placement.width)}|${Math.round(placement.maxHeight)}`
    if (key === applied.current) return
    applied.current = key
    setAnchor({ left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight })
  }

  useLayoutEffect(() => {
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [trigger])

  useEffect(() => {
    const element = node.current
    const observer = typeof ResizeObserver === 'function' && element !== null ? new ResizeObserver(place) : null
    if (element !== null) observer?.observe(element)
    return () => { observer?.disconnect() }
  }, [])

  const rows = OFFICIAL_TABLE.map(row => (period.peak ? row.peak : row.offPeak))
  return (
    <div
      ref={node}
      className="cb-dock-card"
      role="dialog"
      aria-label={t('dock.title')}
      style={anchor === null
        ? { left: 0, top: 0, visibility: 'hidden', width: CARD_MIN_WIDTH }
        : { left: anchor.left, top: anchor.top, width: anchor.width, maxHeight: anchor.maxHeight }}
    >
      <div className="cb-dock-head">
        <span>{t('dock.title')}</span>
        <span className={`cb-dock-badge${period.peak ? ' cb-dock-badge-peak' : ''}`}>{periodLabel}</span>
      </div>
      <div className="cb-dock-head-rule" />
      <div className="cb-dock-period-row">
        <span>{t('dock.peakWindows', { windows: props.windows })}</span>
        <span className="cb-dock-period-eta">
          {period.dayOff === 'weekend' ? t('dock.weekendOff') : null}
          {period.dayOff === 'holiday' ? t('dock.holidayOff') : null}
          {props.countdownText}
        </span>
      </div>
      <div className="cb-dock-cards">
        <StatsTokenBlock t={t} reading={reading} />
        {reading.usage !== null
          ? (
            <StatsCostBlock
              t={t}
              reading={reading}
              currency={currency}
            />
          )
          : null}
        <StatsPlatformBlock t={t} reading={reading} wallet={wallet} currency={currency} />
      </div>
      {reading.onOfficialRates
        ? (
          <div className="cb-dock-card-block">
            <div className="cb-dock-block-title">{t('dock.rates')}</div>
            <table className="cb-dock-table">
              <thead>
                <tr>
                  <th>{t('dock.model')}</th>
                  <th>{t('stats.costHit')}</th>
                  <th>{t('stats.costMiss')}</th>
                  <th>{t('stats.costOut')}</th>
                </tr>
              </thead>
              <tbody>
                {OFFICIAL_TABLE.map((row, index) => {
                  const rate = rows[index]
                  return (
                    <tr key={row.id}>
                      <td>{row.label}</td>
                      <td className="cb-dock-rate-hit">{formatRateCell(rate.hit, currency)}</td>
                      <td className="cb-dock-rate-miss">{formatRateCell(rate.miss, currency)}</td>
                      <td className="cb-dock-rate-out">{formatRateCell(rate.out, currency)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
        : null}
      {reading.usage !== null
        ? <div className="cb-dock-note">{t('dock.note')}</div>
        : null}
    </div>
  )
}

/** One official rate cell: the table quotes CNY, so a USD display converts it. */
function formatRateCell(cny: number, currency: Currency): string {
  const value = currency === 'cny' ? cny : fromCny(cny, 'usd')
  return `${currency === 'cny' ? '¥' : '$'}${value.toFixed(2)}`
}

export { officialRows, toCurrency, formatCost }
