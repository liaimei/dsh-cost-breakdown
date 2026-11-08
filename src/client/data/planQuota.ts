/**
 * Subscription plan quota, read from the host's `/plan-quota` route.
 *
 * The numbers are relayed by the host because only it holds the platform's API key; this module only
 * narrows the untrusted reply. A plan the host could not read is absent from the table, which the
 * panel renders as "not readable" — never as "0 left", because those two are opposite conclusions.
 */

import type { PlanQuotaTable, PlanQuotaWindow } from '../../wire/model'

const QUOTA_ROUTE = '/api/dsh-cost-breakdown/plan-quota'

/** Shape-only narrowing of one window: both numbers must be finite, non-negative, and ordered. */
function windowOf(value: unknown): PlanQuotaWindow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const label = record.label
  const total = record.total
  const used = record.used
  if (typeof label !== 'string' || label === '') return null
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return null
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null
  return { label, total, used: Math.min(used, total) }
}

/** Narrow the whole table, dropping a bad entry without touching its siblings. */
export function planQuotasOf(value: unknown): PlanQuotaTable | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: PlanQuotaTable = {}
  for (const [provider, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    const familyId = record.familyId
    const at = record.at
    if (typeof familyId !== 'string' || familyId === '') continue
    if (typeof at !== 'number' || !Number.isFinite(at)) continue
    const windows = Array.isArray(record.windows)
      ? record.windows.map(windowOf).filter((entry): entry is PlanQuotaWindow => entry !== null)
      : []
    if (windows.length === 0) continue
    out[provider] = { provider, familyId, windows, at }
  }
  return Object.keys(out).length > 0 ? out : null
}

let cached: PlanQuotaTable | null = null
let refreshing: Promise<void> | null = null
const landingCallbacks = new Set<(value: PlanQuotaTable) => void>()

/** One route POST, narrowed per entry. Never rejects. */
async function readRoute(): Promise<PlanQuotaTable | null> {
  try {
    const response = await fetch(QUOTA_ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' } })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') return null
    const envelope = body as { ok?: unknown; value?: unknown }
    if (envelope.ok !== true) return null
    return planQuotasOf(envelope.value)
  } catch {
    return null
  }
}

/** Read once and correct through `onRefresh`: an in-flight read is not restarted, and a failed read
 * notifies nobody (the previous figure stands). Returns the remembered value for the first frame. */
export function readPlanQuotas(onRefresh: (value: PlanQuotaTable) => void): PlanQuotaTable | null {
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
export function resetPlanQuotas(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
}
