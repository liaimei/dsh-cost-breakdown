/**
 * The DeepSeek balance readout, client side.
 *
 * Two sources, in order: the remembered figure paints the first frame, then a background read of the
 * plugin's `/api/dsh-cost-breakdown/balance` route corrects it. With neither, nothing renders — this
 * column never shows a spinner or an error.
 *
 * The reader is the balance row on the cost card, the remaining-quota line on a platform card, and the
 * dock readout; this module only **reads**, it never decides where the number appears.
 */

import type { PlatformBalance } from '../../wire/model'

/** The host balance route. Re-declared here: the bundle inlines every import and must not reach into
 * a host module. */
const BALANCE_ROUTE = '/api/dsh-cost-breakdown/balance'

/** The single localStorage key this bundle writes: the last known balance. */
const STORAGE_KEY = 'dsh-cost-breakdown:platform-balance'

/** The web-storage subset this module needs; tests substitute a plain object. */
export interface StorageFace {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

let storage: StorageFace | null | undefined

function storageOf(): StorageFace | null {
  if (storage !== undefined) return storage
  try {
    const found: unknown = globalThis.localStorage
    storage = found === null || found === undefined ? null : found as StorageFace
  } catch {
    // Some privacy modes throw merely on reading the property; then there is no remembered figure.
    storage = null
  }
  return storage
}

/** Test seam: replace the store behind the remembered figure (`undefined` re-probes). */
export function setBalanceStorage(next: StorageFace | null | undefined): void {
  storage = next
}

/** The localStorage key the remembered figure is written under. A schema change discards rather than
 * migrates. */
export const BALANCE_STORAGE_KEY = STORAGE_KEY

/** The API reports amounts as decimal strings to keep precision; numeric wire values are accepted too.
 * A negative or non-finite value reads as `null`, so a fabricated entry is dropped rather than priced. */
function amountOf(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : null
}

/** Validate a balance response. Returns `null` when no entry survives, which the surfaces read as
 * "nothing to display" — deliberately distinct from a valid-but-empty response, and exactly why a
 * remembered figure beats a blank line. */
export function balanceOf(value: unknown): PlatformBalance | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const entries = Array.isArray(data.balances) ? data.balances : []
  const balances: PlatformBalance['balances'] = []
  for (const raw of entries) {
    try {
      if (raw === null || typeof raw !== 'object') continue
      const entry = raw as Record<string, unknown>
      const currency = entry.currency
      const total = amountOf(entry.total)
      const granted = amountOf(entry.granted)
      const toppedUp = amountOf(entry.toppedUp)
      if (typeof currency !== 'string' || currency === '') continue
      if (total === null || granted === null || toppedUp === null) continue
      balances.push({ currency, total, granted, toppedUp })
    } catch {
      // A hostile entry may throw on property access; drop it and keep the rest.
    }
  }
  return balances.length > 0 ? { isAvailable: data.isAvailable === true, balances } : null
}

/** The entry matching the display currency, falling back to the account's first entry — a figure in
 * another currency beats no figure. */
export function balanceEntryOf(
  balance: PlatformBalance | null | undefined,
  currency: 'cny' | 'usd',
): PlatformBalance['balances'][number] | null {
  if (balance === null || balance === undefined || balance.balances.length === 0) return null
  const wanted = currency === 'cny' ? 'CNY' : 'USD'
  return balance.balances.find(entry => entry.currency === wanted) ?? balance.balances[0]
}

let cached: PlatformBalance | null = null
/** The in-flight route read; a second opener joins it instead of starting another. */
let refreshing: Promise<void> | null = null
/** Every opener riding this read; cleared once it settles, so the next open starts a fresh read and a
 * fresh callback set. */
const landingCallbacks = new Set<(value: PlatformBalance) => void>()

function remembered(): PlatformBalance | null {
  try {
    const raw = storageOf()?.getItem(STORAGE_KEY)
    return raw === null || raw === undefined ? null : balanceOf(JSON.parse(raw))
  } catch {
    return null
  }
}

function remember(value: PlatformBalance | null): void {
  try {
    storageOf()?.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // A rejected write (quota, privacy mode) only costs the next open's head start; live numbers still
    // render.
  }
}

/** One route POST, narrowed by {@link balanceOf}. Never rejects. */
async function readRoute(): Promise<PlatformBalance | null> {
  try {
    const response = await fetch(BALANCE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') return null
    const envelope = body as { ok?: unknown; value?: unknown }
    if (envelope.ok !== true || envelope.value === null || envelope.value === undefined) return null
    return balanceOf(envelope.value)
  } catch {
    return null
  }
}

/**
 * Read on open, then correct through `onRefresh`.
 *
 * `refreshing` is assigned before any await, so an opener arriving mid-read joins it rather than
 * starting a second. A failed or empty read notifies nobody, leaving the remembered figure in place.
 * Returns `null` when there is nothing to show yet.
 */
export function readBalance(onRefresh: (value: PlatformBalance) => void): PlatformBalance | null {
  landingCallbacks.add(onRefresh)
  if (refreshing === null) {
    // The cache is written before the callbacks run, so a reopen triggered by a callback sees the new
    // figure rather than the old one.
    refreshing = (async () => {
      const value = await readRoute()
      if (value === null) return
      cached = value
      remember(value)
      for (const waiter of landingCallbacks) waiter(value)
    })().finally(() => {
      // Both the flag and the riders are cleared in `finally`, so a rejected read cannot leave the flag
      // stuck; both complete before the next open can start a read.
      refreshing = null
      landingCallbacks.clear()
    })
  }
  // The in-memory value is this session's truth; storage only seeds the next open, and only a figure
  // that passed the shape check is restored.
  return cached ?? remembered()
}

/** Drop every piece of module state, including the storage probe and the remembered figure — for
 * tests, and for "after a settings change, no stale account may be shown". */
export function resetBalance(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
  try {
    storageOf()?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to discard.
  }
  storage = undefined
}
