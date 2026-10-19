/**
 * DNA mode for the composition trend: one band per *item* in the assembled context, in the order the model
 * reads them.
 *
 * The ordering rule is the subtle part and it is not the obvious one. A header generation's `seq` must
 * **not** be used as a sort key: the harness appends `request/header` when the first request that uses it is
 * dispatched, which lands after every message already in the context. Sorting by seq would therefore draw
 * the tool bands after the results those schemas describe. A generation replaces its prefix in place, so the
 * current generation's bands always stay first.
 */

import type { Stage, SurfaceEntry } from '../../../wire/model'
import type { Assembled } from './assemble'

/** One item in a step's DNA, before it becomes a drawn band. */
export type DnaItem =
  | { key: string; cat: 'system' | 'tools'; tokens: number; time?: number }
  | { key: string; cat: Stage; tokens: number; time?: number; entry: SurfaceEntry }

/**
 * The items of one assembled step: the system band, then one band per tool schema, then the surface
 * messages in read order.
 *
 * A zero-token item keeps its band (the strip drops zero-width ones) so the reading order stays truthful.
 */
export function dnaOf(view: Assembled): DnaItem[] {
  const items: DnaItem[] = []
  if (view.system !== null) {
    items.push({ key: 'sys', cat: 'system', tokens: view.system.tokens, time: view.system.time })
  }
  if (view.header !== null) {
    for (const tool of view.header.tools) {
      items.push({ key: `tool:${tool.name}`, cat: 'tools', tokens: tool.tokens })
    }
  }
  for (const entry of view.nodes) {
    items.push({
      key: `n${entry.seq}`,
      cat: entry.cat,
      tokens: entry.tokens,
      entry,
      ...(entry.time !== undefined ? { time: entry.time } : {}),
    })
  }
  return items
}

/** A drawn band: the item plus its colour and the token offset it starts at within the bar. */
export type TrendBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Stage; tokens: number; off: number; color: string; entry: SurfaceEntry }

/** One bar's bands, with cumulative offsets so a hit test and a cross-bar highlight both find the same
 * slice by key. */
export function trendBandsOf(view: Assembled, colorOf: (cat: string) => string): TrendBand[] {
  const bands: TrendBand[] = []
  let offset = 0
  for (const item of dnaOf(view)) {
    const color = colorOf(item.cat)
    if ('entry' in item) {
      bands.push({ key: item.key, cat: item.cat, tokens: item.tokens, off: offset, color, entry: item.entry })
    } else {
      bands.push({ key: item.key, cat: item.cat, tokens: item.tokens, off: offset, color })
    }
    offset += item.tokens
  }
  return bands
}

/** A band of a delta bar; `tokens` carries the sign and `off` is the magnitude accumulated from the zero
 * line, so the strip can draw above and below one baseline. */
export type DeltaBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Stage; tokens: number; off: number; color: string; entry: SurfaceEntry }

/** One bar's change against the previous bar, split by sign because the chart draws the two sides of one
 * zero line. */
export interface DnaDelta {
  up: DeltaBand[]
  down: DeltaBand[]
}

/**
 * Pair two bars' bands by **key** (not by position): a band that moved within the prompt still reports the
 * same item's change, and a removed item is found by looking for keys the successor lost.
 *
 * `previous === null` is "no baseline": the bar carries no change, so the scale is driven by the deltas
 * rather than pinned by the opening context's size.
 */
export function deltaBandsOf(bands: TrendBand[], previous: TrendBand[] | null): DnaDelta {
  if (previous === null) return { up: [], down: [] }
  const before = new Map(previous.map(band => [band.key, band.tokens] as const))
  const after = new Map(bands.map(band => [band.key, band.tokens] as const))
  const up: DeltaBand[] = []
  const down: DeltaBand[] = []
  for (const band of bands) {
    const delta = band.tokens - (before.get(band.key) ?? 0)
    if (delta <= 0) continue
    up.push('entry' in band
      ? { key: band.key, cat: band.cat, tokens: delta, off: 0, color: band.color, entry: band.entry }
      : { key: band.key, cat: band.cat, tokens: delta, off: 0, color: band.color })
  }
  for (const band of previous) {
    const delta = (after.get(band.key) ?? 0) - band.tokens
    if (delta >= 0) continue
    down.push('entry' in band
      ? { key: band.key, cat: band.cat, tokens: delta, off: 0, color: band.color, entry: band.entry }
      : { key: band.key, cat: band.cat, tokens: delta, off: 0, color: band.color })
  }
  let upOffset = 0
  // `off` is a magnitude measured from the zero line in both directions; the down list's tokens are
  // negative, so subtracting accumulates a positive offset.
  for (const band of up) {
    band.off = upOffset
    upOffset += band.tokens
  }
  let downOffset = 0
  for (const band of down) {
    band.off = downOffset
    downOffset -= band.tokens
  }
  return { up, down }
}

/** The compact item name both DNA surfaces share: a header band names the prompt or a tool schema, a message
 * band names its skill or tool. */
export function bandLabel(
  band: DnaItem | TrendBand | DeltaBand,
  t: (key: string, params?: Record<string, string | number>) => string,
  catLabel: (key: string) => string,
): string {
  if (!('entry' in band)) return band.cat === 'system' ? catLabel('system') : band.key.slice('tool:'.length)
  const entry = band.entry
  if (entry.skill !== undefined) return t('node.skillTag', { name: entry.skill })
  if (entry.cat === 'tool') return entry.tool ?? '?'
  if (entry.cat === 'inject') return t(`form.${entry.form ?? 'context'}`)
  return catLabel(entry.cat)
}
