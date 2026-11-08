/// <reference types="node" />
/**
 * `POST /api/dsh-cost-breakdown/plan-quota` — the live remaining quota of a **subscription** plan.
 *
 * Why this is host-side: each platform's quota is behind that platform's own API key, and the key
 * never reaches the browser (the same rule the balance and credits routes follow). The host resolves
 * the credential through the harness `credentials` service, calls the vendor's own usage endpoint,
 * and serves only sanitised numbers.
 *
 * Why every failure is a typed `null`: a quota is a claim about the user's money. A stale, guessed or
 * cross-filled figure is worse than an empty row, so a missing key, a signed-out account, a timeout, a
 * non-`ok` status, an unrecognised payload, or an endpoint this build does not know all resolve to
 * `null` — the surface then says "not readable" instead of inventing a number.
 *
 * Only endpoints that the vendor actually publishes are wired. A platform whose quota API is not
 * documented (MiniMax M Plan, Kimi Code Plan, Xiaomi Token Plan) deliberately has **no reader** here:
 * a made-up URL would fail on every call and teach the user to distrust the whole panel.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PlanQuota, PlanQuotaTable } from '../../wire/model'
import { planFamilyOf } from '../../core/plans'
import { type ConnectionFace, registerPostRoute, replyValue, routePath } from './router'

/** The quota route, inside the authenticated `/api` fence. */
export const PLAN_QUOTA_ROUTE = routePath('plan-quota')

/** Hard ceiling on one vendor read: a quota row is better absent than hanging the panel. */
const FETCH_TIMEOUT_MS = 8_000

/** Balances and quotas move on a 5-hour or monthly cadence; a one-minute cache is plenty and keeps
 * the panel from hammering the vendor on every open. */
const CACHE_MS = 60_000

/** `credentials` service: resolves a credential reference into its value. */
interface CredentialsFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

/** `settings` service: only the Config-form `describe()` projection is consumed. */
interface SettingsFace {
  describe?(): unknown
}

/** One vendor reader: where to call, how to authenticate, and how to narrow the reply. */
interface QuotaReader {
  /** Harness route id this reader answers for. */
  provider: string
  /** Credential reference the provider row declares (e.g. `ZAI_CODING_CN_API_KEY`). */
  credentialEnv: string
  /** The vendor's usage endpoint. */
  url: string
  /** Narrow the vendor payload into windows; `null` when the shape is not recognised. */
  narrow(value: unknown): PlanQuota['windows'] | null
}

/** A finite non-negative amount, or `null`. */
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
 * 智谱 GLM Coding Plan quota (`GET /api/monitor/usage/quota/limit`).
 *
 * The reply carries a `limits` array whose entries name a window (`5h`, `weekly`, …) and its used/total
 * pair. Field spellings vary between deployments, so each entry is read defensively: an entry that
 * does not yield both numbers is dropped rather than half-adopted.
 */
export function narrowZhipuQuota(value: unknown): PlanQuota['windows'] | null {
  const root = recordOf(value)
  if (root === null) return null
  const data = recordOf(root.data) ?? root
  const limits = data.limits ?? data.quotaLimits ?? data.list
  if (!Array.isArray(limits)) return null
  const windows: PlanQuota['windows'] = []
  for (const raw of limits) {
    const entry = recordOf(raw)
    if (entry === null) continue
    const label = entry.type ?? entry.window ?? entry.name ?? entry.period
    const total = amountOf(entry.total ?? entry.limit ?? entry.max ?? entry.totalAmount)
    const used = amountOf(entry.used ?? entry.usage ?? entry.usedAmount ?? entry.consumed)
    if (typeof label !== 'string' || label === '' || total === null || total <= 0) continue
    const consumed = used ?? Math.max(total - (amountOf(entry.remaining ?? entry.left ?? entry.balance) ?? total), 0)
    windows.push({ label, total, used: Math.min(consumed, total) })
  }
  return windows.length > 0 ? windows : null
}

/** The readers this build can actually call. */
const READERS: readonly QuotaReader[] = [
  {
    provider: 'zai-coding-cn',
    credentialEnv: 'ZAI_CODING_CN_API_KEY',
    url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    narrow: narrowZhipuQuota,
  },
]

/** One upstream transport, injectable so tests never touch the network. */
export type QuotaFetcher = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  json: () => Promise<unknown>
}>

const defaultFetcher: QuotaFetcher = (url, init) => fetch(url, init) as unknown as ReturnType<QuotaFetcher>

let fetcher: QuotaFetcher = defaultFetcher

/** Replace the transport (tests); `null` restores the default. */
export function setQuotaFetcher(next: QuotaFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let cached: { at: number; value: PlanQuotaTable | null } | null = null

/** Drop the cache (tests). */
export function resetQuota(): void {
  cached = null
}

/** Resolve one credential reference to its value, or `null`. */
async function resolveCredential(ctx: Context, env: string): Promise<string | null> {
  const credentials = ctx.get('credentials') as CredentialsFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  try {
    const hit = await resolve(env)
    return typeof hit?.value === 'string' && hit.value !== '' ? hit.value : null
  } catch {
    return null
  }
}

/**
 * The provider's declared credential reference, folded off the Config-form projection.
 *
 * The harness lets a row override `apiKeyEnv`, so the row's own value wins over the built-in default;
 * only a row whose `apiKeyEnv` is a string counts, and a hostile row is skipped.
 */
function credentialEnvOf(ctx: Context, provider: string): string | null {
  const settings = ctx.get('settings') as SettingsFace | undefined
  if (typeof settings?.describe !== 'function') return null
  try {
    const rows = settings.describe()
    if (!Array.isArray(rows)) return null
    for (const row of rows) {
      try {
        const record = recordOf(row)
        if (record === null || record.ns !== provider) continue
        const value = recordOf(record.value)
        const env = value?.apiKeyEnv
        if (typeof env === 'string' && env !== '') return env
      } catch {
        continue
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Read every subscription plan's live quota.
 *
 * A provider is absent from the table unless its reader succeeded: the client distinguishes
 * "not readable" (no entry) from "read, and nothing left" (an entry with `used === total`).
 */
export async function planQuotas(ctx: Context, now = Date.now()): Promise<PlanQuotaTable | null> {
  if (cached !== null && now - cached.at < CACHE_MS) return cached.value
  const table: PlanQuotaTable = {}
  await Promise.all(READERS.map(async (reader) => {
    try {
      const family = planFamilyOf(reader.provider)
      if (family === null) return
      const env = credentialEnvOf(ctx, reader.provider) ?? reader.credentialEnv
      const apiKey = await resolveCredential(ctx, env)
      if (apiKey === null) return
      const response = await fetcher(reader.url, {
        headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) return
      const windows = reader.narrow(await response.json())
      if (windows === null) return
      const quota: PlanQuota = { provider: reader.provider, familyId: family.id, windows, at: now }
      table[reader.provider] = quota
    } catch {
      // Not configured, signed out, or the vendor changed shape: this plan has no readable quota.
    }
  }))
  const value = Object.keys(table).length > 0 ? table : null
  cached = { at: now, value }
  return value
}

/** Arm the plan-quota route as soon as `connection` is provided. */
export function watchPlanQuotaChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (): Promise<Response> => replyValue(await planQuotas(ctx))
    registerPostRoute(
      c,
      c.get('connection') as ConnectionFace | undefined,
      PLAN_QUOTA_ROUTE,
      handler,
      'dsh-cost-breakdown: plan quota route',
    )
  })
}
