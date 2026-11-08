/**
 * The relay's published price table, read from the host's `/relay-prices` route.
 *
 * A relay resells other vendors' models, so the public registry cannot price it. The relay does
 * publish its own table, though, and this module turns that into the plugin's rate vocabulary:
 * `<relay>:<model>` → USD per million tokens, which is the same slot a user-declared rate occupies.
 *
 * Precedence is deliberate: a **user-declared** rate still wins. The relay's published table is a
 * default, and a user who knows their own group multiplier can override it without editing code.
 */

import type { RateQuad } from '../../wire/model'
import { isRelayRoute } from '../../core/providers'
import type { ThirdPartyRates } from './thirdPartyRates'

const RELAY_ROUTE = '/api/dsh-cost-breakdown/relay-prices'

/** A wire-validated relay row, kept local: the client only needs the price fields. */
interface RelayRow {
  model: string
  mode: 'token' | 'image'
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  tiers?: Array<{ minTokens: number; input?: number; output?: number }>
}

/** One relay's rows by model id. */
type RelayTable = Record<string, Record<string, RelayRow>>

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Narrow one row; a malformed row is dropped without touching its siblings. */
function rowOf(value: unknown): RelayRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const model = record.model
  if (typeof model !== 'string' || model === '') return null
  const mode = record.mode === 'image' ? 'image' : 'token'
  const input = numOf(record.input)
  const output = numOf(record.output)
  const cacheRead = numOf(record.cacheRead)
  const cacheWrite = numOf(record.cacheWrite)
  const row: RelayRow = { model, mode }
  if (input !== undefined) row.input = input
  if (output !== undefined) row.output = output
  if (cacheRead !== undefined) row.cacheRead = cacheRead
  if (cacheWrite !== undefined) row.cacheWrite = cacheWrite
  return row
}

/** Narrow the whole table. */
export function relayTableOf(value: unknown): RelayTable | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const relays = (value as Record<string, unknown>).relays
  if (relays === null || typeof relays !== 'object' || Array.isArray(relays)) return null
  const out: RelayTable = {}
  for (const [relay, models] of Object.entries(relays as Record<string, unknown>)) {
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
    const branch: Record<string, RelayRow> = {}
    for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
      const row = rowOf(raw)
      if (row !== null) branch[id] = row
    }
    if (Object.keys(branch).length > 0) out[relay] = branch
  }
  return Object.keys(out).length > 0 ? out : null
}

/**
 * Turn a relay row into a rate quadruple.
 *
 * A cache rate the vendor omits falls back to the input rate, matching how every other rate source in
 * this plugin is narrowed: an absent column means "not separately priced", and charging nothing for a
 * cache read would understate the bill.
 *
 * A row that publishes no token price at all is `null` — an image-billed model has no per-token rate,
 * and pretending it is free would be a wrong number rather than a missing one.
 */
export function quadOfRow(row: RelayRow): RateQuad | null {
  if (row.mode !== 'token') return null
  const miss = row.input
  const out = row.output
  if (miss === undefined && out === undefined) return null
  const input = miss ?? out ?? 0
  const output = out ?? input
  return {
    hit: row.cacheRead ?? input,
    miss: input,
    write: row.cacheWrite ?? input,
    out: output,
  }
}

/**
 * Merge the relay's published rates **under** the user's own table.
 *
 * The result keeps the `ThirdPartyRates` shape so `estimateByBucket` needs no change: a relay route
 * simply has a rate configured for it, exactly as if the user had typed one.
 */
export function relayRatesOf(
  table: RelayTable | null,
  declared: ThirdPartyRates | null,
  /** The route ids this build has seen bill through a relay. A relay's price list is published under
   * one name (`woyao`) but the ledger bills per **account row** (`woyao-pro-1`, `woyao-pro-2`), and a
   * rate lookup is an exact match — so the table has to be published under every row id, or the relay
   * keeps reporting "no rate". */
  routes: readonly string[] = [],
): ThirdPartyRates | null {
  if (table === null) return declared
  const out: ThirdPartyRates = {}
  for (const [relay, models] of Object.entries(table)) {
    const branch: Record<string, RateQuad> = {}
    for (const [id, row] of Object.entries(models)) {
      const quad = quadOfRow(row)
      if (quad !== null) branch[id.toLowerCase()] = quad
    }
    if (Object.keys(branch).length === 0) continue
    const key = relay.toLowerCase()
    out[key] = branch
    // Publish the same branch under each account row of this relay, so an exact-match lookup on
    // `woyao-pro-2` finds it.
    for (const route of routes) {
      const id = route.trim().toLowerCase()
      if (id === key) continue
      if (id.startsWith(`${key}-`) || id.startsWith(`${key}:`)) out[id] = branch
    }
  }
  // A declared rate wins per model: the user's group multiplier is authoritative over the default.
  if (declared !== null) {
    for (const [provider, models] of Object.entries(declared)) {
      const branch = out[provider] ?? (out[provider] = {})
      for (const [model, quad] of Object.entries(models)) branch[model.toLowerCase()] = quad
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

let cached: RelayTable | null = null
let refreshing: Promise<void> | null = null
const landingCallbacks = new Set<(value: RelayTable) => void>()

/** One route POST, narrowed. Never rejects. */
async function readRoute(): Promise<RelayTable | null> {
  try {
    const response = await fetch(RELAY_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' } })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') return null
    const envelope = body as { ok?: unknown; value?: unknown }
    if (envelope.ok !== true) return null
    return relayTableOf(envelope.value)
  } catch {
    return null
  }
}

/** Read once and correct through `onRefresh`. Returns the remembered table for the first frame. */
export function readRelayTable(onRefresh: (value: RelayTable) => void): RelayTable | null {
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

/** The remembered table, without triggering a read (the pricing path reads synchronously). */
export function relayTable(): RelayTable | null {
  return cached
}

/** Route ids this session has seen bill through a relay. A relay's price list is one document but the
 * ledger addresses it per account row, so the ids have to be collected before the table can be
 * published under them. */
const seenRoutes = new Set<string>()

/** Remember a relay route id so its prices resolve under that exact id. */
export function noteRelayRoute(provider: string): void {
  if (isRelayRoute(provider)) seenRoutes.add(provider.trim().toLowerCase())
}

/** The relay route ids seen so far, sorted for a stable iteration order. */
export function relayRoutes(): string[] {
  return [...seenRoutes].sort()
}

/** Drop the remembered route ids (tests). */
export function resetRelayRoutes(): void {
  seenRoutes.clear()
}

/** Publish a freshly-read table. Separate from {@link readRelayTable} so a component that is not part
 * of the pricing path can hand the result to the module that is: pricing runs synchronously on every
 * render, so it cannot await a read of its own. */
export function setRelayTableReady(value: RelayTable | null): void {
  if (value === null) return
  cached = value
}

/** Whether a route is served by the relay whose table this module holds. */
export function relayServes(provider: string): boolean {
  return isRelayRoute(provider)
}

/** Drop module state (tests). */
export function resetRelayPrices(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
  seenRoutes.clear()
}
