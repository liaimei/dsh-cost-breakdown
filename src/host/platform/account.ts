/**
 * DeepSeek platform balance, read host-side through two independent routes.
 *
 * 1. **The harness's own account login** (`ctx.deepseekAccount`) needs no key: the user signed
 *    into DSH is the account being billed, and that service already reports granted and
 *    topped-up wallets separately.
 * 2. **The DeepSeek API-key provider**, for deployments without that service: the provider's
 *    settings section (read off the Config-form projection) declares a credential reference and
 *    optionally an endpoint override, which the `credentials` service resolves into a key.
 *
 * The key never reaches the browser: the host reads it and serves only sanitised numbers. Every
 * failure — missing service, signed out, timeout, non-`ok` status, malformed payload, empty
 * wallet list — resolves to a typed `null`; these surfaces would rather render nothing than a
 * stale or wrong number.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BalanceEntry, PlatformBalance } from '../../wire/model'

/** Settings namespace of the DeepSeek API-key provider; preferred over its row name. */
const DEEPSEEK_SETTINGS_NS = 'llm-deepseek'

/** Alternate namespace the same provider has shipped under. */
const DEEPSEEK_API_KEY_NS = 'llm-deepseek-api-key'

/** DeepSeek's public API root (`GET /user/balance`). */
const PUBLIC_BASE_URL = 'https://api.deepseek.com'

/** Hard ceiling on a platform read: the balance row is better hidden than hanging the page. */
const FETCH_TIMEOUT_MS = 10_000

/** `settings` service: only the Config-form `describe()` projection is consumed. */
interface SettingsFace {
  describe?(): unknown
}

/** `credentials` service: resolves a credential reference into its value. */
interface CredentialsFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

/** The harness's own account login. */
interface AccountFace {
  getState?(): Promise<unknown> | unknown
  getBalance?(client: unknown): Promise<unknown> | unknown
}

/** Re-verify one platform amount. The platform sends some numbers as decimal strings; negatives
 * and non-finite values are not amounts, and returning `null` drops the whole wallet. */
function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** Plain-object view of an untrusted payload. */
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Client metadata forwarded to the platform: fixed version/locale plus this machine's eastward
 * UTC offset, computed rather than assumed.
 */
export function clientMetadata(): Record<string, unknown> {
  return {
    version: '1',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/** Whether a payload status means "signed out" — a conclusion, unlike a failed probe. */
function isSignedOut(state: unknown): boolean {
  return recordOf(state)?.status === 'signed-out'
}

/**
 * Fold a wallet list into one entry per currency, marking which half of the split it belongs to.
 * A wallet whose shape does not hold is dropped whole; survivors accumulate into their currency.
 */
function addWallets(
  into: Map<string, BalanceEntry>,
  wallets: unknown,
  field: 'granted' | 'toppedUp',
): void {
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    try {
      const entry = recordOf(wallet)
      if (entry === null) continue
      const amount = amountOf(entry.balance)
      if (typeof entry.currency !== 'string' || entry.currency === '' || amount === null) continue
      const current = into.get(entry.currency)
        ?? { currency: entry.currency, total: 0, granted: 0, toppedUp: 0 }
      current[field] += amount
      // Derive the total from the two re-verified halves rather than trusting the platform's
      // independently rounded `total_balance`.
      current.total += amount
      into.set(entry.currency, current)
    } catch {
      // A hostile wallet that throws on property read is dropped, not fatal.
      continue
    }
  }
}

/**
 * Read the balance through the harness account login. Returns `null` when the service is
 * missing, the account is signed out, or the read fails — the caller then falls back to the API
 * key route.
 */
export async function readAccountBalance(ctx: Context): Promise<PlatformBalance | null> {
  const account = ctx.get('deepseekAccount') as AccountFace | undefined
  const getBalance = typeof account?.getBalance === 'function' ? account.getBalance.bind(account) : undefined
  if (getBalance === undefined) return null
  try {
    if (typeof account?.getState === 'function') {
      const state = await account.getState()
      if (isSignedOut(state)) return null
    }
  } catch {
    // A failed state probe is not a conclusion: the balance read below gets its own chance.
  }
  try {
    const outcome = recordOf(await getBalance(clientMetadata()))
    if (outcome === null || outcome.status !== 'ready') return null
    // The service splits wallets structurally: `value` is topped-up money, `bonusWallets` is
    // granted money, so the console's own breakdown reaches the UI unchanged.
    const byCurrency = new Map<string, BalanceEntry>()
    addWallets(byCurrency, outcome.value, 'toppedUp')
    addWallets(byCurrency, outcome.bonusWallets, 'granted')
    const balances = [...byCurrency.values()]
    return balances.length > 0 ? { isAvailable: true, balances } : null
  } catch {
    return null
  }
}

/** Endpoint plus credential resolved from the API-key provider's settings section. */
export interface DeepSeekFacts {
  baseUrl: string
  apiKey: string
}

/**
 * The DeepSeek API-key provider's settings section, folded off the Config-form projection: its
 * row declares a top-level `apiKeyEnv` credential reference, a shape only that provider
 * produces. Rows are folded independently — a hostile row is dropped, valid rows still count.
 */
function deepSeekSectionOf(ctx: Context): Record<string, unknown> | null {
  const settings = ctx.get('settings') as SettingsFace | undefined
  if (typeof settings?.describe !== 'function') return null
  try {
    const rows = settings.describe()
    if (!Array.isArray(rows)) return null
    let shaped: Record<string, unknown> | null = null
    for (const row of rows) {
      try {
        const record = recordOf(row)
        if (record === null) continue
        const value = recordOf(record.value)
        if (value === null || typeof value.apiKeyEnv !== 'string' || value.apiKeyEnv === '') continue
        if (record.ns === DEEPSEEK_SETTINGS_NS || record.ns === DEEPSEEK_API_KEY_NS) return value
        shaped ??= value
      } catch {
        continue
      }
    }
    return shaped
  } catch {
    return null
  }
}

/** Resolve the connection facts the API-key provider actually uses; `null` if any is missing. */
export async function resolveDeepSeekFacts(ctx: Context): Promise<DeepSeekFacts | null> {
  const section = deepSeekSectionOf(ctx)
  if (section === null) return null
  const apiKeyEnv = section.apiKeyEnv as string
  const baseUrl = typeof section.baseURL === 'string' && section.baseURL !== ''
    ? section.baseURL
    : PUBLIC_BASE_URL
  const credentials = ctx.get('credentials') as CredentialsFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  let hit: { value?: unknown } | undefined
  try {
    hit = await resolve(apiKeyEnv)
  } catch {
    return null
  }
  const apiKey = typeof hit?.value === 'string' ? hit.value : ''
  return apiKey === '' ? null : { baseUrl, apiKey }
}

/**
 * Narrow the platform payload into the wire value: the total is the sum of the two re-verified
 * halves, so the UI's own arithmetic decides. Entries whose shape does not hold are dropped; a
 * payload with no valid entry is no balance at all.
 */
export function balanceOfPayload(value: unknown): PlatformBalance | null {
  const data = recordOf(value)
  if (data === null) return null
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const balances: BalanceEntry[] = []
  for (const info of infos) {
    try {
      const entry = recordOf(info)
      if (entry === null) continue
      const currency = entry.currency
      const granted = amountOf(entry.granted_balance)
      const toppedUp = amountOf(entry.topped_up_balance)
      if (typeof currency !== 'string' || currency === '' || granted === null || toppedUp === null) continue
      balances.push({ currency, total: granted + toppedUp, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.is_available === true, balances }
    : null
}

/** One upstream transport, injectable so tests never touch the network. */
export type BalanceFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: BalanceFetcher = (url, init) => fetch(url, init)

let fetcher: BalanceFetcher = defaultFetcher

/** Replace the platform transport (tests); `null` restores the default. */
export function setBalanceFetcher(next: BalanceFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let inFlight: Promise<PlatformBalance | null> | null = null

/** Drop the shared in-flight read (tests), so the next request really hits the transport. */
export function resetBalance(): void {
  inFlight = null
}

/**
 * One platform read for these facts, shared with any concurrent identical read.
 *
 * Nothing is remembered after it settles: the balance moves with every billed request, so a
 * cached number would be a lie. All failure paths — transport, timeout, non-`ok` status,
 * malformed payload — resolve `null`.
 */
export async function readApiKeyBalance(facts: DeepSeekFacts): Promise<PlatformBalance | null> {
  if (inFlight !== null) return inFlight
  inFlight = (async (): Promise<PlatformBalance | null> => {
    try {
      const response = await fetcher(facts.baseUrl.replace(/\/+$/, '') + '/user/balance', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + facts.apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      return response.ok ? balanceOfPayload(await response.json()) : null
    } catch {
      // Any failure hides the balance row rather than surfacing a transport error.
      return null
    }
  })()
  const settled = inFlight
  try {
    return await settled
  } finally {
    // The `inFlight !== null` guard means a settled read only ever clears its own value.
    inFlight = null
  }
}
