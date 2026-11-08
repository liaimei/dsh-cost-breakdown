/**
 * The dock's data read.
 *
 * One pass from the session seat to everything the collapsed row and the expanded card need: the
 * merged cost ledger, the spend rows (one per platform, each in its own unit), the current billing
 * period with its countdown, and the balance/credits readouts.
 *
 * Two decisions worth knowing:
 *   - The **current route** decides the collapsed scope. Once a route is known, only that platform's
 *     row is shown; the full list belongs in the expanded card. Listing every platform in one row
 *     would claim the reader is looking at all of them at once.
 *   - The period ticks once a second, but the hook returns the **same object** when nothing moved, so a
 *     tick that does not change the countdown cannot re-render the row.
 */

import { useEffect, useState } from 'react'
import type { CreditRateTable, PlanQuotaTable, Snapshot } from '../../../wire/model'
import { planFamilyOf, tierAt, type PlanFamily, type PlanTier } from '../../../core/plans'
import { countdownOf, msUntilFlip, offDayReason, periodAt, type Period } from '../../../core/clock'
import { isDeepSeekRoute } from '../../../core/providers'
import { billedTokens, mergeLedgers, unitWordOf, type Currency, type PriceBook } from '../../data/cost'
import type { PlatformSpend } from '../../data/platformSpend'
import type { PlatformBalance, PlatformCredits } from '../../../wire/model'
import { balanceEntryOf, readBalance } from '../../data/balance'
import { readCredits, type CreditsTable } from '../../data/credits'
import { readPlanQuotas } from '../../data/planQuota'
import { creditRates, moneyRates } from '../../shell/rateTables'
import type { SessionSeatProps } from '../../shell/contracts'
import { snapshotOf } from '../../shell/washers'
import { platformSpendsOf } from '../../data/platformSpend'
import { mergeCreditRates } from '../../../core/credits'

/** How often a mounted readout re-reads the balance and the credit wallet. */
export const BALANCE_POLL_MS = 60_000

/** One second of wall clock, for the countdown. */
const TICK_MS = 1_000

/** The live billing period and its countdown, stable across ticks that do not move it. */
export interface PeriodView {
  peak: boolean
  /** Milliseconds until the next flip; `null` when there is none in the scan window. */
  remainingMs: number | null
  /** Why today is off-peak all day, when it is. */
  dayOff: 'weekend' | 'holiday' | null
}

const INITIAL_PERIOD: PeriodView = { peak: periodAt(Date.now()) === 'peak', remainingMs: null, dayOff: offDayReason(Date.now()) }

/** The current period, recomputed once a second; returns the previous object when nothing moved. */
export function usePeriod(now: () => number = Date.now): PeriodView {
  const [view, setView] = useState<PeriodView>(INITIAL_PERIOD)
  useEffect(() => {
    const tick = (): void => {
      const time = now()
      const peak = periodAt(time) === 'peak'
      const remainingMs = msUntilFlip(time)
      const dayOff = offDayReason(time)
      setView((previous) => {
        // An unchanged reading keeps the old object, so the projection re-read below does not run.
        if (previous.peak === peak && previous.remainingMs === remainingMs && previous.dayOff === dayOff) return previous
        return { peak, remainingMs, dayOff }
      })
    }
    const timer = setInterval(tick, TICK_MS)
    return () => { clearInterval(timer) }
  }, [now])
  return view
}

/** The countdown split for display (`6h 38m`), or `null` on an all-off day. */
export function countdownPartsOf(period: PeriodView): { hours: number; minutes: number; seconds: number } | null {
  if (period.dayOff !== null || period.remainingMs === null) return null
  const parts = countdownOf(period.remainingMs)
  return { hours: parts.days * 24 + parts.hours, minutes: parts.minutes, seconds: parts.seconds }
}

/** What the collapsed row renders for one platform. */
export interface DockRow {
  provider: string
  /** `plan` is a subscription: its figure is quota consumed, not a bill. */
  unit: 'money' | 'credits' | 'plan'
  currency?: 'CNY' | 'USD'
  value: number
  calls: number
}

/** Everything the dock needs from the session. */
export interface DockReading {
  snapshot: Snapshot | null
  /** Merged cost ledger for this session, or `null` when nothing was billed. */
  usage: ReturnType<typeof mergeLedgers>
  /** Billed tokens, independent of whether a rate exists. */
  tokens: number
  /** All platform rows, for the expanded card. */
  platforms: PlatformSpend[]
  /** The rows the collapsed trigger shows: the current route only, once it is known. */
  shown: PlatformSpend[]
  /** The session's current route. */
  active?: { provider: string; model?: string }
  /** Whether the current route bills on the official CNY table (or is unknown, which is treated as
   * official because that table is the only source of the peak/off split). */
  onOfficialRates: boolean
  /** Credit rates from the platform's catalogue, for per-request platforms. */
  creditRates: CreditRateTable | null
  /** The plan family the current route bills through, when it is a subscription. */
  plan: { family: PlanFamily; tier: PlanTier | null } | null
}

/** Read the session's snapshot from the seat. */
export function useSnapshot(props: SessionSeatProps): Snapshot | null {
  // The seat is a hook: called unconditionally, once, in stable order.
  return typeof props.useProjection === 'function'
    ? snapshotOf(props.useProjection('contextTimeline'))
    : null
}

/** Derive the dock reading from a snapshot. Pure so the card and the row cannot disagree. */
export function readingOf(snapshot: Snapshot | null, book: PriceBook | null, money: ReturnType<typeof moneyRates>, planTier = 0): DockReading {
  const usage = mergeLedgers(snapshot?.cost ?? null)
  const calls = snapshot?.calls ?? null
  const credits = snapshot?.creditRates ?? mergeCreditRates(null, creditRates())
  const platforms = platformSpendsOf(usage, calls, book, money, credits, planTier)
  const active = snapshot?.provider !== undefined
    ? { provider: snapshot.provider, ...(snapshot.model !== undefined ? { model: snapshot.model } : {}) }
    : undefined
  // The plugin only knows a route once a header has been folded; before that it assumes the official
  // table, because that is the only source of the peak/off split.
  const onOfficialRates = active === undefined || isDeepSeekRoute(active.provider)
  const family = active === undefined ? null : planFamilyOf(active.provider)
  const activeRow = active === undefined ? undefined : platforms.find(row => row.provider === active.provider)
  const shown = active === undefined ? platforms : activeRow === undefined ? [] : [activeRow]
  return {
    snapshot,
    usage,
    tokens: billedTokens(usage),
    platforms,
    shown,
    ...(active !== undefined ? { active } : {}),
    onOfficialRates,
    creditRates: credits,
    plan: family === null ? null : { family, tier: tierAt(family, planTier) },
  }
}

/** The balance, the credit wallet, and every subscription plan's live quota, read on mount and then
 * once a minute. */
export interface WalletState {
  balance: PlatformBalance | null
  credits: CreditsTable | null
  /** Route id → that plan's live quota; a plan the host could not read is absent. */
  planQuotas: PlanQuotaTable | null
}

/** Poll the two wallet channels while mounted. The first frame paints the remembered figure. */
export function useWallet(): WalletState {
  const [state, setState] = useState<WalletState>(() => ({
    balance: readBalance(() => {}),
    credits: readCredits(() => {}),
    planQuotas: readPlanQuotas(() => {}),
  }))
  useEffect(() => {
    let live = true
    const refresh = (): void => {
      const balance = readBalance((value) => {
        if (live) setState(previous => (previous.balance === value ? previous : { ...previous, balance: value }))
      })
      const credits = readCredits((value) => {
        if (live) setState(previous => (previous.credits === value ? previous : { ...previous, credits: value }))
      })
      const planQuotas = readPlanQuotas((value) => {
        if (live) setState(previous => (previous.planQuotas === value ? previous : { ...previous, planQuotas: value }))
      })
      if (live) {
        setState(previous => (previous.balance === balance && previous.credits === credits && previous.planQuotas === planQuotas
          ? previous
          : { balance, credits, planQuotas }))
      }
    }
    refresh()
    const timer = setInterval(refresh, BALANCE_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])
  return state
}

/** The balance figure for one platform row, or `null` when nothing is known — in which case the row
 * renders no balance cell at all rather than an empty one. */
export function balanceTextOf(
  row: Pick<DockRow, 'provider' | 'unit' | 'currency'>,
  wallet: WalletState,
  currency: Currency,
): { text: string; credits: boolean } | null {
  // A subscription reports its own quota on the platform's usage page, not a wallet balance, so the
  // dock shows no balance cell for it rather than a figure from an unrelated account.
  if (row.unit === 'plan') return null
  if (row.unit === 'credits') {
    const credits = wallet.credits?.[row.provider]
    if (credits === undefined) return null
    return { text: credits.unlimited ? '∞' : String(credits.total), credits: true }
  }
  const entry = balanceEntryOf(wallet.balance, currency)
  if (entry === null) return null
  // The unit follows the number here too, for the same reason as `formatNativeSpend`: a balance and a
  // spend read the same way, and a credit figure already puts its unit after its number.
  return { text: `${entry.total.toFixed(2)} ${unitWordOf(entry.currency === 'CNY' ? 'CNY' : 'USD')}`, credits: false }
}

/** The credit wallet for one provider, when the platform reports one. */
export function creditsFor(wallet: WalletState, provider: string): PlatformCredits | null {
  return wallet.credits?.[provider] ?? null
}

/** The official price table rows for the current period, for the expanded card. */
export type { Period }
