/**
 * Metering: turning untrusted provider usage into billing counts, and the accumulators that write
 * them into the fold state.
 *
 * Two rules shape this whole module.
 *
 * **Sanitise at the boundary.** Provider usage arrives from a durable log and is therefore
 * untrusted. The wire/state schemas demand non-negative integers, and the registry parses every
 * served view without an error boundary — one raw `-80` or `10.4` in the state would freeze that
 * session's projection feed forever. So every bucket goes through {@link tokenCountOf} before it
 * can touch the state, and a wholly unreadable usage object is treated as *absent* rather than as
 * fabricated zeros.
 *
 * **One accumulation point.** A settlement writes the session ledger, the request counter and the
 * optional per-turn ledger from the same call, so the card and the per-turn readout can never
 * disagree about what one request cost. The period is decided once, by model, through
 * `pricedByPeriod` + the Beijing clock.
 */

import { type Period } from '../../core/clock'
import { addBuckets, billedTokensOf, emptyBuckets } from '../../core/ledger'
import { pricedByPeriod } from '../../core/providers'
import { isPeakAt } from '../../core/clock'
import type { BucketTotals, TimingTotals } from '../../wire/model'
import type { TimelineState } from './state'

/** The usage shape read off a durable settlement. Every field is untrusted. */
export interface RawUsage {
  inputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  outputTokens?: unknown
}

/**
 * Narrow one provider-reported bucket into a billing count, or `null` when it is not a readable
 * number.
 *
 * Fractions round (a gateway may report averaged figures), negatives clamp to zero (a gateway
 * reporting `cached_tokens > prompt_tokens` would otherwise produce a negative uncached bucket),
 * and numeric strings parse because some adapters forward them verbatim. `NaN`, infinities and
 * everything else read as *absent*, never as zero: "no sample" and "zero tokens" price the same
 * but mean different things to the occupancy anchor.
 */
export function tokenCountOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null
  }
  return null
}

/** The four billing buckets of one settlement, sanitised; `null` when not one bucket is readable. */
export interface BilledSettlement {
  buckets: BucketTotals
  /** Billed prompt side (`uncached + cacheRead + cacheWrite`). Present whenever the settlement is,
   * because "this sample billed nothing on the prompt side" is a real reading, not a missing one. */
  prompt: number
  /** Provider-reported output, `null` when that bucket specifically was unreadable. */
  output: number | null
  /** Cache-read share of the prompt, `null` when that bucket specifically was unreadable. */
  cacheRead: number | null
}

/**
 * Sanitise a settlement's usage.
 *
 * The "at least one readable bucket" gate matters: a hostile or broken adapter must not be able
 * to inject a fabricated zero sample, because the client derives occupancy from these rows.
 */
export function settlementOf(usage: unknown): BilledSettlement | null {
  if (usage === null || typeof usage !== 'object') return null
  const raw = usage as RawUsage
  const input = tokenCountOf(raw.inputTokens)
  const cacheRead = tokenCountOf(raw.cacheReadTokens)
  const cacheWrite = tokenCountOf(raw.cacheWriteTokens)
  const output = tokenCountOf(raw.outputTokens)
  if (input === null && cacheRead === null && cacheWrite === null && output === null) return null
  return {
    buckets: {
      uncached: input ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
      output: output ?? 0,
    },
    // Any readable bucket makes this a billing sample, so the prompt side is reported even when it
    // is wholly unknown: an output-only settlement bills prompt 0, not "no prompt reading".
    prompt: (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    output,
    cacheRead,
  }
}

/**
 * The billing period of one settlement.
 *
 * Only models the official price list covers are split by the Beijing windows; every other model
 * books entirely under `peak`, which is the plain list-price bucket (the client applies no peak
 * multiplier there). Keying this on the *route* instead of the model would book a proxied
 * DeepSeek model into `peak` without the multiplier — mis-dated and half the price.
 */
export function periodAt(time: number, provider: string, model: string | undefined, holidays: readonly string[]): Period {
  if (!pricedByPeriod(provider, model)) return 'peak'
  return isPeakAt(time, holidays) ? 'peak' : 'off'
}

/** Accumulate one settled request into the whole-session and (when named) per-turn ledgers. */
export interface SettlementContext {
  time: number
  provider: string
  model: string | undefined
  holidays: readonly string[]
  turn: number | undefined
}

/**
 * The single write point for billing data.
 *
 * Writes three things from one settlement: the session `cost` ledger, the per-(provider, model)
 * request count, and — only when the request named its turn — that turn's ledger. A request with
 * no model is not priceable at all, so nothing is written rather than a guessed row under an
 * empty key.
 */
export function bookSettlement(state: TimelineState, context: SettlementContext, buckets: BucketTotals): void {
  const { model } = context
  if (model === undefined || model === '') return
  const provider = context.provider
  const period = periodAt(context.time, provider, model, context.holidays)
  state.cost = bookInto(state.cost, provider, model, period, buckets)
  bumpCalls(state, provider, model)
  if (context.turn !== undefined && Number.isFinite(context.turn)) {
    appendTurnUsage(state, String(context.turn), provider, model, period, buckets)
  }
}

/**
 * Book buckets into a cost ledger, cloning only the touched path.
 *
 * Works for both the session ledger and one turn's ledger because they share a shape — that is
 * what makes it impossible for the two to price one settlement differently.
 */
function bookInto(ledger: TimelineState['cost'], provider: string, model: string, period: Period, buckets: BucketTotals) {
  const next = { ...(ledger ?? {}) }
  const providerRow = { ...(next[provider] ?? {}) }
  const modelRow = { ...(providerRow[model] ?? {}) }
  const current = period === 'peak' ? modelRow.peak : modelRow.off
  const merged = current === undefined ? { ...buckets } : addBuckets(current, buckets)
  if (period === 'peak') modelRow.peak = merged
  else modelRow.off = merged
  providerRow[model] = modelRow
  next[provider] = providerRow
  return next
}

function appendTurnUsage(
  state: TimelineState,
  turnKey: string,
  provider: string,
  model: string,
  period: Period,
  buckets: BucketTotals,
): void {
  const previous = state.turnCost?.[turnKey]
  const usage = bookInto(previous?.usage, provider, model, period, buckets)
  const requests = { ...(previous?.requests ?? {}) }
  const models = { ...(requests[provider] ?? {}) }
  models[model] = (models[model] ?? 0) + 1
  requests[provider] = models
  state.turnCost = { ...(state.turnCost ?? {}), [turnKey]: { usage, requests } }
}

/** Count one request against its (provider, model). Written at the same point as `cost`. */
function bumpCalls(state: TimelineState, provider: string, model: string): void {
  const calls = { ...(state.calls ?? {}) }
  const row = { ...(calls[provider] ?? {}) }
  row[model] = (row[model] ?? 0) + 1
  calls[provider] = row
  state.calls = calls
}

/** Billed tokens across one settlement — the activity ledger's per-day token figure. */
export function settlementTokens(buckets: BucketTotals): number {
  return billedTokensOf(buckets)
}

/** An empty bucket set, re-exported for the activity fold's default path. */
export { emptyBuckets }

// ---------------------------------------------------------------------------
// Timing accumulators
// ---------------------------------------------------------------------------

/** Only the busiest 16 tool names are ranked; the rest are dropped wholesale. */
export const TOOL_TIMING_CAP = 16

/** A clamped `to - from` in milliseconds. Non-finite endpoints read as 0, so a corrupt timestamp
 * cannot create a NaN interval the state schema would reject. */
export function durationBetween(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, to - from)
}

/** The whole-session timing accumulator, created on first use. */
export function ensureTiming(state: TimelineState): TimingTotals {
  if (state.timing === undefined) {
    state.timing = { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }
  }
  return state.timing
}

/** The decode buckets the generation split reports, in card order. */
export type DecodeKind = 'reasoning' | 'text' | 'toolarg'

export const DECODE_KINDS: readonly DecodeKind[] = ['reasoning', 'text', 'toolarg']

/** Which `TimingTotals` fields a decode bucket accumulates into. */
const DECODE_FIELDS: Record<DecodeKind, { ms: 'reasoningMs' | 'textMs' | 'toolArgMs'; blocks: 'reasoningBlocks' | 'textBlocks' | 'toolArgBlocks' }> = {
  reasoning: { ms: 'reasoningMs', blocks: 'reasoningBlocks' },
  text: { ms: 'textMs', blocks: 'textBlocks' },
  toolarg: { ms: 'toolArgMs', blocks: 'toolArgBlocks' },
}

/**
 * Add one decode bucket's span and block count.
 *
 * Zero stays **absent**: a state folded before the split existed must not grow a pile of useless
 * zero properties, and the card reads absence as zero anyway.
 */
export function addDecode(timing: TimingTotals, kind: DecodeKind, ms: number, blocks: number): void {
  const fields = DECODE_FIELDS[kind]
  if (ms > 0) timing[fields.ms] = (timing[fields.ms] ?? 0) + ms
  if (blocks > 0) timing[fields.blocks] = (timing[fields.blocks] ?? 0) + blocks
}

/**
 * Add one settled tool call to the per-name ranking.
 *
 * The cap evicts the cheapest total, so even a log of unique names stays bounded. `__proto__` is
 * skipped: assigning it writes the prototype instead of a row, which would both lose the tally
 * and hand the wire copier inherited `calls`/`ms` values that the strict schema rejects.
 */
export function addToolTiming(timing: TimingTotals, name: string, ms: number): void {
  if (name === '__proto__') return
  if (!Object.hasOwn(timing.tools, name)) {
    if (Object.keys(timing.tools).length >= TOOL_TIMING_CAP) {
      let cheapest = ''
      let cheapestMs = Infinity
      for (const key of Object.keys(timing.tools)) {
        if (timing.tools[key].ms < cheapestMs) {
          cheapestMs = timing.tools[key].ms
          cheapest = key
        }
      }
      const kept: TimingTotals['tools'] = {}
      for (const key of Object.keys(timing.tools)) {
        if (key !== cheapest) kept[key] = timing.tools[key]
      }
      timing.tools = kept
    }
    timing.tools[name] = { calls: 1, ms }
    return
  }
  const current = timing.tools[name]
  timing.tools[name] = { calls: current.calls + 1, ms: current.ms + ms }
}
