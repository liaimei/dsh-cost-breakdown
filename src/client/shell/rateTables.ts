/**
 * The runtime slot holding the user's own rate tables.
 *
 * Two tables with different meanings, neither overriding the other:
 *   - `money`: `<provider>:<model>` → USD per **million tokens**;
 *   - `credits`: `<provider>:<model>` → credits per **request**.
 *
 * Deliberately a replaceable runtime slot rather than a settings read: the settings can change
 * mid-session, and every component reads this on the frame it renders, so an edit lands immediately.
 * The settings wiring only has to call {@link setRateTables}; consumers and the pricing logic never
 * change.
 */

import { thirdPartyRatesOf, type ThirdPartyRates } from '../data/thirdPartyRates'
import { creditRatesOf } from '../../core/credits'
import type { CreditRateTable } from '../../wire/model'
import { relayRatesOf, relayRoutes, relayTable } from '../data/relayPrices'

let money: ThirdPartyRates | null = null
let credits: CreditRateTable | null = null

/** Set or clear both tables. `null`/absent means "not declared", which pricing reads as unpriceable. */
export function setRateTables(next: { money?: unknown; credits?: unknown } | null): void {
  money = next === null ? null : thirdPartyRatesOf(next.money)
  credits = next === null ? null : creditRatesOf(next.credits)
}

/**
 * The per-million-token rates in force: the user's own table **over** the relay's published one.
 *
 * A relay publishes its own price list, so its models are priceable without the user typing every
 * rate; a declared rate still wins per model, because the user's group multiplier is authoritative.
 * This is the one place the two sources are combined, so every surface that prices money sees the
 * same table.
 */
export function moneyRates(): ThirdPartyRates | null {
  return relayRatesOf(relayTable(), money, relayRoutes())
}

/** The user's per-request credit rates. */
export function creditRates(): CreditRateTable | null {
  return credits
}

/** Back to the undeclared state (tests). */
export function resetRateTables(): void {
  setRateTables(null)
}
