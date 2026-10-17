/**
 * User-declared third-party rates — the plugin's only authority for non-registry platforms.
 *
 * Why the user declares them instead of the plugin inferring: a public registry lists the same
 * model from dozens of vendors at prices that differ by an order of magnitude, and the third-party
 * platform a user actually pays is usually not in that registry at all. Which vendor and which
 * price is a deployment fact the plugin cannot infer — a guess would silently produce a plausible
 * wrong number, which is worse than saying "cannot be priced".
 *
 * The key format is `<dsh provider id>:<model id>`, both segments spelled exactly as the billing
 * ledger spells them. The payload arrives over the wire and is therefore untrusted: every entry
 * is validated on its own and a bad one is dropped without invalidating the table.
 */

import type { RateQuad } from '../../wire/model'

/** One platform's rates: model id (kept as written; matching ignores case) → USD per million
 * tokens. */
export type ThirdPartyRates = Record<string, Record<string, RateQuad>>

/** Split a `<provider>:<model>` key. The provider segment can itself contain a colon (an observed
 * `workbuddy-ai:` key has a trailing one), so split on the **first** colon and trim trailing
 * colons off the provider. */
export function splitRateKey(key: string): { provider: string; model: string } | null {
  const at = key.indexOf(':')
  if (at <= 0) return null
  const provider = key.slice(0, at).replace(/:+$/, '').toLowerCase()
  const model = key.slice(at + 1).replace(/^:+/, '').trim().toLowerCase()
  if (provider === '' || model === '') return null
  return { provider, model }
}

function rateOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Narrow one rate. `input` and `output` are required; the two cache rates fall back to the input
 * rate, matching how the registry payload is narrowed. */
function quadOf(value: unknown): RateQuad | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const miss = rateOf(record.input ?? record.miss)
  const out = rateOf(record.output ?? record.out)
  if (miss === null || out === null) return null
  return {
    hit: rateOf(record.cacheRead ?? record.hit) ?? miss,
    miss,
    write: rateOf(record.cacheWrite ?? record.write) ?? miss,
    out,
  }
}

/** Narrow the configured table. Accepts `{ "<provider>:<model>": {...} }`; an entry with a bad key
 * or bad rates is skipped and the rest still applies — one typo must not disable the table. */
export function thirdPartyRatesOf(value: unknown): ThirdPartyRates | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: ThirdPartyRates = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parts = splitRateKey(key)
    if (parts === null) continue
    const quad = quadOf(raw)
    if (quad === null) continue
    const models = out[parts.provider] ?? {}
    models[parts.model] = quad
    out[parts.provider] = models
  }
  return Object.keys(out).length > 0 ? out : null
}

/** Look up a configured rate; provider and model match case-insensitively and exactly. */
export function configuredRateOf(
  rates: ThirdPartyRates | null | undefined,
  provider: string,
  model: string,
): RateQuad | null {
  if (rates === null || rates === undefined) return null
  const needleProvider = provider.trim().toLowerCase()
  const needleModel = model.trim().toLowerCase()
  for (const [providerId, models] of Object.entries(rates)) {
    if (providerId !== needleProvider) continue
    for (const [modelId, rate] of Object.entries(models)) {
      if (modelId === needleModel) return rate
    }
    return null
  }
  return null
}

/** A human-readable echo of the configured table for the settings surface, sorted so two renders
 * cannot reorder it. */
export function formatRatesForDisplay(rates: ThirdPartyRates | null): string[] {
  if (rates === null) return []
  const lines: string[] = []
  for (const provider of Object.keys(rates).sort()) {
    for (const model of Object.keys(rates[provider]).sort()) {
      const rate = rates[provider][model]
      lines.push(`${provider}:${model} → in ${rate.miss} / out ${rate.out} / read ${rate.hit} / write ${rate.write}`)
    }
  }
  return lines
}
