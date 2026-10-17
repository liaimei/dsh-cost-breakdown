/**
 * Platform credit readout, client side.
 *
 * The numbers are relayed by the host's `/api/dsh-cost-breakdown/credits` route, because only the host
 * can reach a platform's own status route (it accepts loopback requests only and reads that platform's
 * login credentials).
 *
 * When nothing can be read, nothing is returned and the surfaces render no quota line: a missing
 * slice beats a stale or invented figure.
 */

import type { PlatformCredits } from '../../wire/model'

const CREDITS_ROUTE = '/api/dsh-cost-breakdown/credits'

/** One edition's remaining credits. */
export type CreditsTable = Record<string, PlatformCredits>

/** Shape-only narrowing of one edition (untrusted wire): `total` must be a finite non-negative
 * number, or the entry counts as absent. */
export function creditsOf(value: unknown): PlatformCredits | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const total = record.total
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null
  return {
    total,
    unlimited: record.unlimited === true,
    ...(typeof record.cycleResetTime === 'string' && record.cycleResetTime !== ''
      ? { cycleResetTime: record.cycleResetTime }
      : {}),
  }
}

let cached: CreditsTable | null = null
let refreshing: Promise<void> | null = null
const landingCallbacks = new Set<(value: CreditsTable) => void>()

/** One route POST, narrowed per entry. Never rejects. */
async function readRoute(): Promise<CreditsTable | null> {
  try {
    const response = await fetch(CREDITS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') return null
    const envelope = body as { ok?: unknown; value?: unknown }
    if (envelope.ok !== true) return null
    // The wire carries provider → credits; narrow each entry, dropping a bad one without touching the
    // other edition.
    if (envelope.value === null || typeof envelope.value !== 'object' || Array.isArray(envelope.value)) return null
    const out: CreditsTable = {}
    for (const [provider, raw] of Object.entries(envelope.value as Record<string, unknown>)) {
      const one = creditsOf(raw)
      if (one !== null) out[provider] = one
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/** Read once and correct through `onRefresh`, with the same ride-along semantics as the balance
 * reader: an in-flight read is not restarted, and a failed read notifies nobody (the previous figure
 * stands). Returns the remembered value so the first frame can paint. */
export function readCredits(onRefresh: (value: CreditsTable) => void): CreditsTable | null {
  landingCallbacks.add(onRefresh)
  if (refreshing === null) {
    refreshing = (async () => {
      const value = await readRoute()
      if (value === null) return
      cached = value
      for (const waiter of landingCallbacks) waiter(value)
    })().finally(() => {
      refreshing = null
      landingCallbacks.clear()
    })
  }
  return cached
}

/** Drop module state (tests). */
export function resetCredits(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
}
