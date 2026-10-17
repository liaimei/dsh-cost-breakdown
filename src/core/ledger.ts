/**
 * Billing-unit vocabulary and the ledger arithmetic both halves share.
 *
 * The host writes tokens; the browser prices them. Both sides therefore need the same idea of
 * what a "bucket" is and how two ledgers merge — but neither needs the other's money maths.
 */

import type { BucketTotals, CallLedger, CostLedger, ModelLedger, TurnLedger } from '../wire/model'
import type { Period } from './clock'

/** An empty bucket set. */
export function emptyBuckets(): BucketTotals {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** Sum the four buckets of one totals row. */
export function billedTokensOf(usage: BucketTotals): number {
  return usage.uncached + usage.cacheRead + usage.cacheWrite + usage.output
}

/** Add one settlement into a bucket set, returning a new row (never mutating the input). */
export function addBuckets(into: BucketTotals, delta: BucketTotals): BucketTotals {
  return {
    uncached: into.uncached + delta.uncached,
    cacheRead: into.cacheRead + delta.cacheRead,
    cacheWrite: into.cacheWrite + delta.cacheWrite,
    output: into.output + delta.output,
  }
}

/** Deep-copy a model ledger so a served view can never alias persisted state. */
export function copyModelLedger(ledger: ModelLedger): ModelLedger {
  const copy: ModelLedger = {}
  if (ledger.peak !== undefined) copy.peak = { ...ledger.peak }
  if (ledger.off !== undefined) copy.off = { ...ledger.off }
  return copy
}

/** Deep-copy a cost ledger. */
export function copyCostLedger(ledger: CostLedger): CostLedger {
  const copy: CostLedger = {}
  for (const [provider, models] of Object.entries(ledger)) {
    const row: { [model: string]: ModelLedger } = {}
    for (const [model, entry] of Object.entries(models)) row[model] = copyModelLedger(entry)
    copy[provider] = row
  }
  return copy
}

/** Deep-copy a call ledger. */
export function copyCallLedger(ledger: CallLedger): CallLedger {
  const copy: CallLedger = {}
  for (const [provider, models] of Object.entries(ledger)) copy[provider] = { ...models }
  return copy
}

/** Deep-copy a turn ledger. */
export function copyTurnLedger(ledger: TurnLedger): TurnLedger {
  const copy: TurnLedger = {}
  for (const [turn, entry] of Object.entries(ledger)) {
    copy[turn] = { usage: copyCostLedger(entry.usage), requests: copyCallLedger(entry.requests) }
  }
  return copy
}

/**
 * Book one settlement into a cost ledger.
 *
 * The period is supplied by the caller (the fold resolves it once from the settlement time and
 * model), so this function is pure arithmetic: it cannot disagree with the period the UI shows.
 */
export function bookUsage(
  ledger: CostLedger,
  provider: string,
  model: string,
  period: Period,
  buckets: BucketTotals,
): CostLedger {
  const next = copyCostLedger(ledger)
  const providerRow = next[provider] ?? {}
  const modelRow = providerRow[model] ?? {}
  const current = period === 'peak' ? modelRow.peak : modelRow.off
  const merged = current === undefined ? { ...buckets } : addBuckets(current, buckets)
  if (period === 'peak') modelRow.peak = merged
  else modelRow.off = merged
  providerRow[model] = modelRow
  next[provider] = providerRow
  return next
}

/** Count one request in a call ledger (per-request billing is what credit platforms do). */
export function bookCall(ledger: CallLedger, provider: string, model: string): CallLedger {
  const next = copyCallLedger(ledger)
  const providerRow = next[provider] ?? {}
  providerRow[model] = (providerRow[model] ?? 0) + 1
  next[provider] = providerRow
  return next
}

/** Merge two ledgers, summing overlapping buckets. Returns `null` when both are empty, so
 * "no billing data" stays distinguishable from "zero cost". */
export function mergeCostLedgers(left: CostLedger | null | undefined, right: CostLedger | null | undefined): CostLedger | null {
  // `undefined` is a real possibility here: callers pass optional projections straight through, and an
  // absent ledger must read as empty, not as a crash.
  const sources = [left, right].filter((ledger): ledger is CostLedger => ledger != null && Object.keys(ledger).length > 0)
  if (sources.length === 0) return null
  const out: CostLedger = {}
  for (const ledger of sources) {
    for (const [provider, models] of Object.entries(ledger)) {
      const providerRow = out[provider] ?? {}
      for (const [model, entry] of Object.entries(models)) {
        const target = providerRow[model] ?? {}
        if (entry.peak !== undefined) {
          target.peak = target.peak === undefined ? { ...entry.peak } : addBuckets(target.peak, entry.peak)
        }
        if (entry.off !== undefined) {
          target.off = target.off === undefined ? { ...entry.off } : addBuckets(target.off, entry.off)
        }
        providerRow[model] = target
      }
      out[provider] = providerRow
    }
  }
  return out
}

/** Merge two call ledgers. Returns `null` when both are empty. */
export function mergeCallLedgers(left: CallLedger | null | undefined, right: CallLedger | null | undefined): CallLedger | null {
  const sources = [left, right].filter((ledger): ledger is CallLedger => ledger != null && Object.keys(ledger).length > 0)
  if (sources.length === 0) return null
  const out: CallLedger = {}
  for (const ledger of sources) {
    for (const [provider, models] of Object.entries(ledger)) {
      const providerRow = out[provider] ?? {}
      for (const [model, calls] of Object.entries(models)) providerRow[model] = (providerRow[model] ?? 0) + calls
      out[provider] = providerRow
    }
  }
  return out
}

/** Total billed tokens across every provider and period in a ledger. `null` for an empty one. */
export function ledgerTokens(ledger: CostLedger | null | undefined): number | null {
  if (ledger === null || ledger === undefined) return null
  let total = 0
  let seen = false
  for (const models of Object.values(ledger)) {
    for (const entry of Object.values(models)) {
      if (entry.peak !== undefined) {
        total += billedTokensOf(entry.peak)
        seen = true
      }
      if (entry.off !== undefined) {
        total += billedTokensOf(entry.off)
        seen = true
      }
    }
  }
  return seen ? total : null
}

/** How many requests a call ledger counts. */
export function ledgerCalls(ledger: CallLedger | null | undefined): number {
  if (ledger === null || ledger === undefined) return 0
  let total = 0
  for (const models of Object.values(ledger)) {
    for (const calls of Object.values(models)) total += calls
  }
  return total
}
