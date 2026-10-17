/**
 * Credit rates: the per-request price of a credit-metered platform.
 *
 * Different in meaning from a token rate table — this is "how many credits per request", not
 * "how much money per million tokens". Both the host (which reads it out of the platform's own
 * catalogue) and the browser (which displays the readout) normalise it the same way, hence the
 * shared module.
 *
 * The host reads the catalogue instead of asking the user to type rates because the platform
 * keeps them in its own model catalogue (`billing.credits`), which only its host can read; a
 * user transcription would drift on every price change.
 */

import type { CreditRateTable } from '../wire/model'

/** Both spellings a catalogue uses: an `x` prefix and/or a `credits` suffix. */
const CREDIT_AMOUNT = /^\s*x?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?\s*$/i

/**
 * Parse a credit amount such as `"x0.11 credits"` → `0.11`.
 *
 * Only unambiguous shapes are accepted; anything else returns `null` so the caller falls back to
 * the money path. A `free: true` model has rate 0 — that is a real value, not a missing one.
 */
export function creditAmountOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const match = CREDIT_AMOUNT.exec(value)
  if (match === null) return null
  const amount = Number(match[1])
  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

/**
 * Narrow a value into `provider → model → credits per request`.
 *
 * Accepts both shapes the table has in the wild, because its two sources differ: the platform
 * catalogue (host-read) already nests, while a user setting writes flat `<provider>:<model>`
 * keys. Bad entries are dropped one by one — one typo must not invalidate the table.
 */
export function creditRatesOf(value: unknown): CreditRateTable | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: CreditRateTable = {}
  const put = (provider: string, model: string, amount: number): void => {
    if (provider === '' || model === '') return
    const models = out[provider] ?? {}
    models[model] = amount
    out[provider] = models
  }
  const amountOf = (raw: unknown): number | null => (
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
  )
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const colon = key.indexOf(':')
    if (colon > 0) {
      const amount = amountOf(raw)
      if (amount !== null) put(key.slice(0, colon).trim().toLowerCase(), key.slice(colon + 1).trim().toLowerCase(), amount)
      continue
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const provider = key.trim().toLowerCase()
    for (const [model, inner] of Object.entries(raw as Record<string, unknown>)) {
      const amount = amountOf(inner)
      if (amount !== null) put(provider, model.trim().toLowerCase(), amount)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** The credit rate of one request; provider and model match case-insensitively. */
export function creditRateOf(
  rates: CreditRateTable | null | undefined,
  provider: string,
  model: string,
): number | null {
  if (rates === null || rates === undefined) return null
  const models = rates[provider.trim().toLowerCase()]
  if (models === undefined) return null
  const rate = models[model.trim().toLowerCase()]
  return rate === undefined ? null : rate
}

/** Whether a provider bills per request (any of its models carries a credit rate). */
export function isCreditProvider(rates: CreditRateTable | null | undefined, provider: string): boolean {
  if (rates === null || rates === undefined) return false
  const models = rates[provider.trim().toLowerCase()]
  return models !== undefined && Object.keys(models).length > 0
}

/** First-writer-wins merge, so cross-session merging cannot change a platform's number. */
export function mergeCreditRates(
  into: CreditRateTable | null,
  from: CreditRateTable | null | undefined,
): CreditRateTable | null {
  if (from === null || from === undefined) return into
  if (into === null) return creditRatesOf(from)
  const out: CreditRateTable = {}
  for (const [provider, models] of Object.entries(into)) out[provider] = { ...models }
  for (const [provider, models] of Object.entries(from)) {
    const target: Record<string, number> = out[provider] ?? {}
    for (const [model, rate] of Object.entries(models)) {
      if (target[model] === undefined) target[model] = rate
    }
    out[provider] = target
  }
  return Object.keys(out).length > 0 ? out : null
}
