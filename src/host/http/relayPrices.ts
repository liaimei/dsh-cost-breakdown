/// <reference types="node" />
/**
 * `POST /api/dsh-cost-breakdown/relay-prices` — a relay's own public price list.
 *
 * A relay (woyao.pro and its `woyao-pro-*` account rows are the observed case) resells other vendors'
 * models, so the public registry has no branch for it: pricing from that book would quote the model's
 * *original vendor* list price, which the relay never charges. But the relay does publish its own
 * table — per model, billed in its own unit (per token or per image) at its own multiplier.
 *
 * This route fetches that table and normalises it into the plugin's rate vocabulary. The table is
 * public (no credential), so the browser could call it directly; it goes through the host anyway so
 * the browser keeps a single origin, the payload is validated once, and a CORS or offline failure
 * degrades in one place.
 *
 * Everything the vendor states is kept: the per-token rates, the per-image rates, and the multiplier
 * that produced them. Nothing is inferred — a model the vendor does not list stays unpriced.
 *
 * **The published prices already include the multiplier.** This was verified against the vendor's own
 * pricing page: `gpt-5.6-sol` reports `rate_multiplier: 0.3` with `input_price: 5e-06` ($5/M), and the
 * page shows `0.3x … 输入 $5/M` — the same $5, not $1.50. So the multiplier is carried **for display
 * only** and must never be applied again; multiplying would under-report every relay cost by 3.3x.
 */

import type { Context } from '@deepseek-ai/cordis'
import { type ConnectionFace, registerPostRoute, replyValue, routePath } from './router'

/** The relay price route, inside the authenticated `/api` fence. */
export const RELAY_PRICES_ROUTE = routePath('relay-prices')

/** The vendor's public catalogue. Public by design: it is the same table the pricing page renders. */
const RELAY_MODELS_URL = 'https://woyao.pro/api/public/models'

/** A price table changes when the operator edits it, not per request; ten minutes is plenty and keeps
 * the panel from re-fetching on every open. */
const CACHE_MS = 10 * 60_000

/** One relay price row, normalised. */
export interface RelayPrice {
  /** Model id exactly as the relay spells it (the join key against the ledger). */
  model: string
  /** Upstream vendor the relay attributes the model to (`openai`, `anthropic`, …). */
  platform: string
  /** The relay's own group/channel name (`GPT Pro`, `Claude Max`, …). */
  group: string
  /** `token` bills per million tokens; `image` bills per generated image. */
  mode: 'token' | 'image'
  /**
   * USD per million tokens. The vendor publishes per-token decimals (`5e-06`), which are scaled here
   * so the rest of the plugin never has to remember the difference.
   */
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  /** USD per image, for `mode: 'image'`. */
  perImage?: number
  /** The relay's discount multiplier versus its upstream list price. **Display only**: the prices in
   * this row are already the post-multiplier figures the vendor publishes, so applying this again
   * would under-report the cost. */
  multiplier?: number
  /** Context-length tiers the vendor prices separately (input/output above a threshold). */
  tiers?: Array<{ minTokens: number; input?: number; output?: number }>
}

/** The normalised table plus when it was read. */
export interface RelayPriceTable {
  /** Relay key (`woyao`) → its models by id. */
  relays: Record<string, Record<string, RelayPrice>>
  at: number
}

/** A finite non-negative number, or `undefined`. Accepts the vendor's decimal strings too. */
function numOf(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Plain-object view of an untrusted payload. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** Per-token decimals → USD per million tokens. `undefined` stays `undefined` (not zero: a vendor that
 * omits a column is not charging nothing).
 *
 * Rounded to six decimals to strip binary noise: `1e-07 * 1e6` lands on `0.09999999999999999`, which
 * would print as that instead of `0.1`. A relay price has at most a few significant digits, so the
 * rounding cannot change a real figure. */
function perMillion(value: unknown): number | undefined {
  const n = numOf(value)
  if (n === undefined) return undefined
  return Math.round(n * 1_000_000 * 1e6) / 1e6
}

/** Narrow one vendor row. A row without a model id, or without any usable price, is dropped — a row
 * that cannot be priced is worse than no row. */
export function relayPriceOf(value: unknown): RelayPrice | null {
  const root = recordOf(value)
  if (root === null) return null
  const model = typeof root.model === 'string' ? root.model.trim() : ''
  if (model === '') return null
  const mode = root.billing_mode === 'image' ? 'image' : 'token'
  const platform = typeof root.platform === 'string' ? root.platform : ''
  const group = typeof root.group === 'string' ? root.group : ''
  const multiplier = numOf(root.rate_multiplier)
  const out: RelayPrice = { model, platform, group, mode }
  if (multiplier !== undefined) out.multiplier = multiplier
  if (mode === 'image') {
    const perImage = numOf(root.per_request_price) ?? numOf(root.image_output_price)
    // An image row with no per-image figure is not priceable: the ring and the totals would claim
    // these renders were free.
    if (perImage === undefined || perImage <= 0) return null
    out.perImage = perImage
    return out
  }
  const input = perMillion(root.input_price)
  const output = perMillion(root.output_price)
  if (input === undefined && output === undefined) return null
  if (input !== undefined) out.input = input
  if (output !== undefined) out.output = output
  const cacheRead = perMillion(root.cache_read_price)
  const cacheWrite = perMillion(root.cache_write_price)
  if (cacheRead !== undefined) out.cacheRead = cacheRead
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite
  // Long-context tiers: the vendor charges a different rate above a threshold, so the row must carry
  // it or a 300k-token request would be billed at the short-context rate.
  const intervals = Array.isArray(root.intervals) ? root.intervals : []
  const tiers: NonNullable<RelayPrice['tiers']> = []
  for (const raw of intervals) {
    const tier = recordOf(raw)
    if (tier === null) continue
    const minTokens = numOf(tier.min_tokens)
    if (minTokens === undefined || minTokens <= 0) continue
    const tierInput = perMillion(tier.input_price)
    const tierOutput = perMillion(tier.output_price)
    if (tierInput === undefined && tierOutput === undefined) continue
    tiers.push({
      minTokens,
      ...(tierInput !== undefined ? { input: tierInput } : {}),
      ...(tierOutput !== undefined ? { output: tierOutput } : {}),
    })
  }
  if (tiers.length > 0) {
    tiers.sort((left, right) => left.minTokens - right.minTokens)
    out.tiers = tiers
  }
  return out
}

/** Narrow the whole payload into a relay table. A bad row is skipped without invalidating the rest. */
export function relayPriceTableOf(value: unknown, relay = 'woyao', at = Date.now()): RelayPriceTable | null {
  const root = recordOf(value)
  if (root === null) return null
  const rows = root.data
  if (!Array.isArray(rows)) return null
  const models: Record<string, RelayPrice> = {}
  for (const raw of rows) {
    const price = relayPriceOf(raw)
    if (price !== null) models[price.model] = price
  }
  return Object.keys(models).length > 0 ? { relays: { [relay]: models }, at } : null
}

/** One upstream transport, injectable so tests never touch the network. */
export type RelayFetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean
  json: () => Promise<unknown>
}>

const defaultFetcher: RelayFetcher = (url, init) => fetch(url, init) as unknown as ReturnType<RelayFetcher>

let fetcher: RelayFetcher = defaultFetcher

/** Replace the transport (tests); `null` restores the default. */
export function setRelayFetcher(next: RelayFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let cached: { at: number; value: RelayPriceTable | null } | null = null

/** Drop the cache (tests). */
export function resetRelayPrices(): void {
  cached = null
}

/**
 * Read the relay's published price table.
 *
 * `null` means "could not read this time", which the client renders as "prices unavailable" — it is
 * explicitly not "the models are free". A failed read never overwrites a previous good table.
 */
export async function relayPrices(now = Date.now()): Promise<RelayPriceTable | null> {
  if (cached !== null && now - cached.at < CACHE_MS) return cached.value
  try {
    const response = await fetcher(RELAY_MODELS_URL, { signal: AbortSignal.timeout(10_000) })
    if (response.ok) {
      const table = relayPriceTableOf(await response.json(), 'woyao', now)
      if (table !== null) {
        cached = { at: now, value: table }
        return table
      }
    }
  } catch {
    // Offline or the vendor moved the endpoint: keep whatever was last readable.
  }
  if (cached !== null) return cached.value
  cached = { at: now, value: null }
  return null
}

/** Arm the relay-price route as soon as `connection` is provided. */
export function watchRelayPricesChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (): Promise<Response> => replyValue(await relayPrices())
    registerPostRoute(
      c,
      c.get('connection') as ConnectionFace | undefined,
      RELAY_PRICES_ROUTE,
      handler,
      'dsh-cost-breakdown: relay prices route',
    )
  })
}
