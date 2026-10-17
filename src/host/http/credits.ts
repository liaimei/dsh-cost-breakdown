/// <reference types="node" />
/**
 * `POST /api/dsh-cost-breakdown/credits` — remaining platform credits.
 *
 * The only source is each platform edition's own status route, on loopback. It accepts only
 * loopback callers and needs its own login credentials to reach upstream, so only this host can
 * read it — the browser cannot.
 *
 * **The two editions are read separately, and their results are never cross-filled.** The
 * domestic and international workbuddy builds are different accounts with different pools
 * (measured: `…/status` reports `www.workbuddy.cn` and `…/ai/status` reports
 * `www.workbuddy.ai`). Copying one number onto the other's row shows the user two identical
 * figures — worse than showing nothing.
 */

import type { Context } from '@deepseek-ai/cordis'
import { type ConnectionFace, registerPostRoute, replyValue, routePath } from './router'

/** The credits route, inside the authenticated `/api` fence. */
export const CREDITS_ROUTE = routePath('credits')

/** The minimal response shape this reader understands; every other field is ignored. */
export interface PlatformCredits {
  /** Remaining credits; meaningless when `unlimited`, where the UI shows "unlimited". */
  total: number
  unlimited: boolean
  /** Cycle reset time, passed through from upstream verbatim (may be absent). */
  cycleResetTime?: string
}

/** One edition's own status route; the provider key is the DSH route id. */
const CREDITS_ROUTES: readonly { provider: string; url: string }[] = [
  { provider: 'workbuddy', url: 'http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/status' },
  { provider: 'workbuddy-ai', url: 'http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/ai/status' },
]

/** How long one read is reused: balances move slowly, and each read makes the platform call upstream. */
const CACHE_MS = 60_000

/** One read may not hang the dock's balance line. */
const FETCH_TIMEOUT_MS = 8_000

/**
 * Shape-narrow one untrusted payload. `total` must be a finite non-negative number or the whole
 * edition is abandoned; `unlimited` is only true on a literal `true`.
 */
export function creditsOfPayload(value: unknown): PlatformCredits | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const root = value as { status?: unknown; credits?: unknown }
  if (root.status !== 'signed-in') return null
  const credits = root.credits
  if (credits === null || typeof credits !== 'object' || Array.isArray(credits)) return null
  const raw = credits as { total?: unknown; unlimited?: unknown; cycleResetTime?: unknown }
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total >= 0
    ? raw.total
    : null
  if (total === null) return null
  return {
    total,
    unlimited: raw.unlimited === true,
    // An empty reset time is not a time; leaving it absent keeps the wire pure JSON.
    ...typeof raw.cycleResetTime === 'string' && raw.cycleResetTime !== ''
      ? { cycleResetTime: raw.cycleResetTime }
      : {},
  }
}

/** The transport slice used here. */
export type CreditsFetcher = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

const defaultFetcher: CreditsFetcher = (url, init) => fetch(url, init) as unknown as ReturnType<CreditsFetcher>

let fetcher: CreditsFetcher = defaultFetcher

/** provider → that edition's balance; an unreadable edition is simply absent. */
export type PlatformCreditsTable = Record<string, PlatformCredits>

let cached: { at: number; value: PlatformCreditsTable | null } | null = null

/** Replace the transport (tests); `null` restores the default. */
export function setCreditsFetcher(next: CreditsFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

/** Drop the cache (tests). */
export function resetCredits(): void {
  cached = null
}

/**
 * Read both editions' remaining credits. An edition that times out, refuses the connection, is
 * signed out, or changed shape is absent from the table — its number is never borrowed from the
 * other edition.
 */
export async function platformCredits(now = Date.now()): Promise<PlatformCreditsTable | null> {
  if (cached !== null && now - cached.at < CACHE_MS) return cached.value
  const table: PlatformCreditsTable = {}
  await Promise.all(CREDITS_ROUTES.map(async ({ provider, url }) => {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) return
      const value = creditsOfPayload(await response.json())
      if (value !== null) table[provider] = value
    } catch {
      // Not installed or not signed in: this edition has no balance.
    }
  }))
  const value = Object.keys(table).length > 0 ? table : null
  cached = { at: now, value }
  return value
}

/** Arm the credits route as soon as `connection` is provided. */
export function watchCreditsChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (): Promise<Response> => replyValue(await platformCredits())
    registerPostRoute(
      c,
      c.get('connection') as ConnectionFace | undefined,
      CREDITS_ROUTE,
      handler,
      'dsh-cost-breakdown: platform credits route',
    )
  })
}
