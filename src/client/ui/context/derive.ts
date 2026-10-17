/**
 * Stage vocabulary and the headline derivation shared by the composition card, the trend chart, the
 * browser and the `/context` modal.
 *
 * Two rules shape everything here:
 *   1. **The stage order is the draw order.** `STAGES` is used to build every stacked strip, legend,
 *      detail row and DNA band, so two cards can never disagree about where a segment sits.
 *   2. **The headline is anchored to the provider's own measurement** — the same `contextPressure`
 *      projection the chat composer ring reads — while the legend prints the fold's own heuristic
 *      counts. The bar's *width* and the legend's *number* therefore come from different sources on
 *      purpose: the width is what the ring shows, the number is what the fold counted.
 */

import type { RequestRow, Snapshot } from '../../../wire/model'

/** One stage of the composition; the union the wire's fold can emit. */
export type Stage = 'user' | 'inject' | 'skill' | 'assistant' | 'tool'
/** Every key a composition strip may carry: the five message stages plus the two header stages. */
export type PartKey = Stage | 'system' | 'tools'
/** A chrome key that is not a stage: the remaining window. */
export type FreeKey = 'free'

/** The `contextPressure` projection the chat composer ring reads. Missing keys stay absent, which is
 * how a host that never folded the projection is distinguished from one that folded zeroes. */
export interface ContextPressure {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}
/** The `contextBreakdown` projection: the ring's panel rows (system / tools / messages). */
export interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}
/** The `tokenUsage` projection: provider-reported billed buckets over the whole log. */
export interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The seven stages, in draw order (the cached prompt prefix first, then the messages as read). */
export const STAGES: readonly PartKey[] = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']

/** Stage → CSS custom property. One mapping, so a palette change cannot half-apply. */
export const STAGE_COLOR: Readonly<Record<PartKey, string>> = {
  system: 'var(--cb-ctx-indigo)',
  tools: 'var(--cb-ctx-amber)',
  user: 'var(--cb-ctx-green)',
  inject: 'var(--cb-ctx-purple)',
  skill: 'var(--cb-ctx-orange)',
  assistant: 'var(--cb-ctx-blue)',
  tool: 'var(--cb-ctx-teal)',
}

/** The five message stages (everything the breakdown splits by fold ratio). */
const MESSAGE_STAGES: readonly Stage[] = ['user', 'inject', 'skill', 'assistant', 'tool']

/** One segment of a stacked strip. `value` sizes the band; `raw` is the number the legend prints, so
 * an anchored bar can report the fold's own count while drawing the provider's scale. */
export interface Part {
  key: string
  color: string
  value: number
  raw?: number
  label?: string
  group?: string
}

/** Un-anchored parts straight off a fold record (or the live `current` block). */
export function partsOf(source: Record<PartKey, number>): Part[] {
  return STAGES.map(key => ({
    key,
    color: STAGE_COLOR[key],
    value: finiteOrZero(source[key]),
  }))
}

/**
 * Parts derived from the official breakdown.
 *
 * The breakdown supplies three totals; the five message stages split `messageTokens` in the fold's own
 * proportions. The rounding residue is added to the largest message stage so the parts always sum to
 * the total (a slightly-heavy largest bucket is invisible; a missing token is not).
 */
export function officialParts(current: Snapshot['current'], breakdown: ContextBreakdown | null): Part[] {
  const foldSurface = current.user + current.inject + current.skill + current.assistant + current.tool
  const system = breakdown?.systemTokens ?? current.system
  const tools = breakdown?.toolsTokens ?? current.tools
  const messages = breakdown?.messageTokens ?? foldSurface
  const values: Record<PartKey, number> = { system, tools, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 }
  if (foldSurface > 0) {
    let assigned = 0
    let largest: Stage = 'user'
    for (const stage of MESSAGE_STAGES) {
      const count = Math.round((messages * current[stage]) / foldSurface)
      values[stage] = count
      assigned += count
      if (current[stage] > current[largest]) largest = stage
    }
    // Floor at zero: several upward roundings can overshoot, and a negative band would be unpaintable.
    values[largest] = Math.max(0, values[largest] + messages - assigned)
  }
  return STAGES.map(key => ({ key, color: STAGE_COLOR[key], value: values[key] }))
}

/**
 * Rescale heuristic parts onto a provider-anchored total: the heuristic supplies the proportions, the
 * provider's measurement the scale. The heuristic counts survive in `raw` (the legend reads them).
 *
 * `target` null/zero/empty leaves the values alone — the bar then shows exactly the heuristic, which
 * is the honest thing to draw when there is no anchor to trust.
 */
export function anchoredParts(parts: readonly Part[], target: number | null): Part[] {
  const sourced = parts.map(part => ({ ...part, raw: part.raw ?? part.value }))
  if (target === null || target <= 0) return sourced
  let total = 0
  for (const part of sourced) total += part.raw ?? 0
  if (total <= 0) return sourced
  if (total === target) return sourced.map(part => ({ ...part, value: part.raw ?? 0 }))
  const scale = target / total
  return sourced.map(part => ({ ...part, value: Math.round((part.raw ?? 0) * scale) }))
}

/** The billed token split for the token card: the prompt's stages anchored to the exact billed input,
 * plus the exact output count as a pink slice so the ring sums to the harness's own total. */
export function billedParts(current: Snapshot['current'], breakdown: ContextBreakdown | null, usage: TokenUsage): Part[] {
  const input = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const estimated = officialParts(current, breakdown)
  const prompt = input > 0
    ? anchoredParts(estimated, input)
    : estimated.map(part => ({ ...part, value: 0 }))
  return [...prompt, { key: 'output', color: 'var(--cb-ctx-pink)', value: Math.max(0, usage.outputTokens) }]
}

/** The composition card's headline. `parts` is anchored to the ring's fill, so the strip length and
 * the percentage always describe the same quantity. */
export interface Headline {
  tokens: number
  window?: number
  pct: number | null
  parts: Part[]
}

/**
 * The kernel's own composer-ring derivation (`ui-conversation`'s `contextOccupancy`,
 * `min(100, round(used / window * 100))`) on a 0.1 grid. The caller guarantees `window > 0`.
 */
export function occupancyPercent(tokens: number, window: number): number {
  return Math.min(100, Math.round((tokens / window) * 1000) / 10)
}

/**
 * Derive the headline from the timeline, preferring the token meter's own projections when present.
 *
 * Anchor order: the ring's live projection → its last sampled prompt → the newest request's reported
 * prompt plus the heuristic drift since. The wire keeps that last summary in `last` for the split
 * generation (the request rows live on the detail channel) and on the request rows inline.
 */
export function headlineOf(
  data: Snapshot,
  pressure: ContextPressure | null = null,
  breakdown: ContextBreakdown | null = null,
): Headline {
  const current = data.current
  const projected = pressure !== null && typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : undefined
  const sampled = pressure !== null && typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : undefined
  const anchorRecord: { prompt?: number; total: number } | null = data.last !== undefined
    ? data.last
    : data.requests.length > 0
      ? data.requests[data.requests.length - 1]
      : null
  const derived = anchorRecord !== null && typeof anchorRecord.prompt === 'number'
    ? anchorRecord.prompt + (current.total - anchorRecord.total)
    : undefined
  const occupancy = projected ?? sampled ?? derived ?? null
  const window = pressure !== null && typeof pressure.contextWindow === 'number' ? pressure.contextWindow : data.contextWindow
  const tokens = occupancy ?? current.total
  const pct = window !== undefined && window > 0 ? occupancyPercent(tokens, window) : null
  const parts = anchoredParts(officialParts(current, breakdown), occupancy !== null && tokens > 0 ? tokens : null)
  return { tokens, window, pct, parts }
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The stage a browser category row names; `system` and `tools` are header singletons rather than
 * buckets of surface nodes. */
export function isHeaderStage(key: string): key is 'system' | 'tools' {
  return key === 'system' || key === 'tools'
}

/** A stage label through the dictionary (`cat.<key>`), so a runtime-built key stays greppable. */
export function stageLabel(t: (key: string) => string, key: string): string {
  return t('cat.' + key)
}

/** The newest request by `seq` — the wire's array order is not trusted (restored rows may re-sort). */
export function newestRequest(requests: readonly RequestRow[]): RequestRow | null {
  let newest: RequestRow | null = null
  for (const row of requests) if (newest === null || row.seq > newest.seq) newest = row
  return newest
}
