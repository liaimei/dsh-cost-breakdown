/// <reference types="node" />
/**
 * Per-request credit rates, read out of the platforms' own catalogues.
 *
 * workbuddy's host writes and keeps refreshing `.workbuddy-catalog.json` under the harness home;
 * each model entry carries `billing.credits` like `"x0.11 credits"`, i.e. *per request*. The
 * browser cannot read that file, so the host reads it and embeds the trimmed table in the
 * timeline head (`creditRates`), which the client prices against (`host-owned, per-request`).
 *
 * Design constraints:
 * - **Unreadable means `null`, never a guessed rate.** The caller falls back to the money path;
 *   a wrong rate would silently misprice every request.
 * - **The file is another plugin's output — untrusted input.** Version, structure and every
 *   field must prove themselves; a non-conforming catalogue is dropped whole rather than
 *   partially adopted.
 * - **A short cache.** Catalogues refresh on demand; reading the disk on every serve frame is
 *   pointless.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { creditAmountOf, creditRatesOf } from '../../core/credits'
import type { CreditRateTable } from '../../wire/model'

/** The only catalogue format this reader accepts; any other version drops the whole file. */
const CATALOG_FORMAT_VERSION = 1

/**
 * Two catalogues, one per route key: the domestic and international editions have separate
 * accounts and separate credit pools, so neither rate table may stand in for the other.
 */
const CATALOGUES: readonly { file: string; provider: string }[] = [
  { file: '.workbuddy-catalog.json', provider: 'workbuddy' },
  { file: '.workbuddy-ai-catalog.json', provider: 'workbuddy-ai' },
]

/** A catalogue refresh is on-demand; a 30 s cache is plenty and keeps every serve off the disk. */
const CACHE_MS = 30_000

/** The harness home: `DSH_HOME` first (workbuddy's own convention), else `~/.dsh`. */
export function dshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
}

/**
 * Extract the rate table from one parsed catalogue payload. Structure and fields are proven
 * layer by layer; a non-conforming catalogue is dropped whole.
 *
 * @param value - parsed catalogue JSON (untrusted).
 * @param provider - the DSH route key this catalogue belongs to.
 */
export function creditRatesFromCatalogue(value: unknown, provider = 'workbuddy'): CreditRateTable | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const root = value as { version?: unknown; entries?: unknown }
  // An unknown version is dropped whole: better no readout than a table read off a guessed shape.
  if (root.version !== CATALOG_FORMAT_VERSION) return null
  if (root.entries === null || typeof root.entries !== 'object' || Array.isArray(root.entries)) return null

  // One catalogue holds several account entries; the most recently fetched one wins, because an
  // older account's rates may already be stale.
  let best: { fetchedAtMs: number; models: unknown[] } | null = null
  for (const raw of Object.values(root.entries as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as { fetchedAtMs?: unknown; models?: unknown }
    const at = typeof entry.fetchedAtMs === 'number' && Number.isFinite(entry.fetchedAtMs)
      ? entry.fetchedAtMs
      : -1
    if (!Array.isArray(entry.models)) continue
    if (best === null || at > best.fetchedAtMs) best = { fetchedAtMs: at, models: entry.models }
  }
  if (best === null) return null

  const models: Record<string, number> = {}
  for (const raw of best.models) {
    if (raw === null || typeof raw !== 'object') continue
    const model = raw as { id?: unknown; billing?: unknown }
    if (typeof model.id !== 'string' || model.id === '') continue
    const billing = model.billing
    if (billing === null || typeof billing !== 'object') continue
    const amount = creditAmountOf((billing as { credits?: unknown }).credits)
    // An unparseable rate is skipped: its price is unknown, so the UI must fall back to money.
    if (amount === null) continue
    models[model.id.toLowerCase()] = amount
  }
  return Object.keys(models).length > 0 ? { [provider]: models } : null
}

let cached: { at: number; value: CreditRateTable | null } | null = null

/**
 * Read and cache the platforms' credit rates. Any failure (missing file, corrupt JSON, changed
 * shape) yields `null`; each catalogue is read independently, so an install that only mounts
 * the international edition contributes only its own rates.
 */
export function platformCreditRates(now = Date.now()): CreditRateTable | null {
  if (cached !== null && now - cached.at < CACHE_MS) return cached.value
  const out: CreditRateTable = {}
  for (const { file, provider } of CATALOGUES) {
    try {
      const text = readFileSync(join(dshHome(), file), 'utf8')
      const one = creditRatesFromCatalogue(JSON.parse(text) as unknown, provider)
      if (one !== null) out[provider] = one[provider]
    } catch {
      // This edition is not installed or its file is unreadable: no rates for that key.
    }
  }
  const value = Object.keys(out).length > 0 ? out : null
  cached = { at: now, value }
  return value
}

/** Drop the cache (tests). */
export function resetCreditRates(): void {
  cached = null
}

/**
 * The wire form of the rate table. `undefined` means "absent, not empty": the field stays off
 * the head entirely and the client falls back to pricing money.
 */
export function creditRatesForWire(): Record<string, Record<string, number>> | undefined {
  return creditRatesOf(platformCreditRates()) ?? undefined
}

/** Re-exported so callers can name the table type without reaching into the wire model. */
export type { CreditRateTable }
