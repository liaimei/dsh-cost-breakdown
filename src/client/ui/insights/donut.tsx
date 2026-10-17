/**
 * The composition donut and its legend — the one chart every Insights card shares.
 *
 * Two decisions shape it:
 *   1. **A ring is drawn as dashed strokes on a fixed 100-unit circumference**, so one dasharray
 *      unit is one percent. The radius (`15.9155` on a 42-unit viewBox) is chosen for exactly that,
 *      which is why every card can hand in raw values and never rescale.
 *   2. **A zero total renders a neutral track, never a full ring.** A full ring would claim that
 *      the whole budget went somewhere; an empty ring says the truth: nothing was measured yet.
 *
 * The palette constants live here rather than in each card so the same stage is the same colour on
 * every surface (composition strip, session card, token card, legend).
 */

import type { CSSProperties, ReactElement, ReactNode } from 'react'

/** The gap between arcs, in dasharray units (one unit ≈ one percent ≈ 2.3 px on a 96 px ring). Each
 * neighbouring arc gives up half of it, so the card's own background shows through as a hairline. */
const SEG_GAP = 0.5

/** Radius that makes the circumference ≈ 100 units on a 42-unit viewBox. */
const RADIUS = 15.9155

/** Dimmable multi-segment ring: `hoverKey` comes from the shared legend hover state. */
export interface DonutSegment {
  key: string
  /** Any CSS colour, including `var(--cb-ov-*)`. */
  color: string
  value: number
}

export interface DonutProps {
  segments: readonly DonutSegment[]
  /** The large figure in the hole; already formatted, because the ring must not know its unit. */
  centerTop: ReactNode
  centerSub?: ReactNode
  /** Outer diameter in px. */
  size?: number
  /** The segment key currently hovered anywhere in the card (legend or ring). */
  hoverKey?: string | null
  /** Hover relay; omitted means the ring does not react. */
  onHoverKey?: (key: string | null) => void
}

/** A proportional ring. Segments are skipped when non-finite or non-positive, and the ring dims its
 * other arcs only when the hovered key actually maps to an arc. */
export function Donut(props: DonutProps): ReactElement {
  const size = props.size ?? 118
  let total = 0
  for (const segment of props.segments) {
    if (Number.isFinite(segment.value) && segment.value > 0) total += segment.value
  }
  const arcs: Array<{ key: string; color: string; length: number; offset: number }> = []
  let accumulated = 0
  if (total > 0) {
    for (const segment of props.segments) {
      const value = Number.isFinite(segment.value) && segment.value > 0 ? segment.value : 0
      if (value === 0) continue
      const percent = (value / total) * 100
      // `+25` pins the first arc at twelve o'clock; each later arc starts where the previous ended.
      arcs.push({ key: segment.key, color: segment.color, length: percent, offset: 100 - accumulated + 25 })
      accumulated += percent
    }
  }
  // A lone coloured arc keeps a complete ring (a gap there looks like a bite was taken out); the cut
  // is capped at a quarter of the arc so a 0.2% wedge cannot disappear entirely.
  if (arcs.length > 1) {
    for (const arc of arcs) {
      const cut = Math.min(SEG_GAP / 2, arc.length / 4)
      arc.length -= cut * 2
      arc.offset -= cut
    }
  }
  const hovering = props.hoverKey !== null && props.hoverKey !== undefined
    && arcs.some(arc => arc.key === props.hoverKey)
  return (
    <div
      className={'cb-ov-donut' + (hovering ? ' cb-ov-donut-dim' : '')}
      style={{ width: size, height: size }}
      onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
    >
      <svg viewBox="0 0 42 42" width={size} height={size} aria-hidden="true">
        {arcs.length === 0
          ? <circle className="cb-ov-donut-track" cx="21" cy="21" r={RADIUS} />
          : arcs.map(arc => (
            <circle
              key={arc.key}
              className={'cb-ov-donut-seg' + (props.hoverKey === arc.key ? ' cb-ov-donut-seg-on' : '')}
              cx="21"
              cy="21"
              r={RADIUS}
              strokeDasharray={`${arc.length} ${100 - arc.length}`}
              strokeDashoffset={arc.offset}
              // Inline because the stroke colour is a CSS variable, which an SVG presentation
              // attribute cannot carry.
              style={{ stroke: arc.color } as CSSProperties}
              onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(arc.key) }}
            />
          ))}
      </svg>
      <div className="cb-ov-donut-center">
        <b style={{ fontSize: Math.max(11, Math.round(size * 0.13)) }}>{props.centerTop}</b>
        {props.centerSub !== undefined
          ? <span style={{ fontSize: Math.max(9, Math.round(size * 0.105)) }}>{props.centerSub}</span>
          : null}
      </div>
    </div>
  )
}

/** One legend row. Every string is pre-formatted: the card owner decides currency, the `≈` mark for
 * estimates, and the dash placeholder. */
export interface SliceRow {
  key: string
  color: string
  label: string
  /** Pre-formatted share (`'84%'`, `'<1%'`, `'—'`). */
  pct: string
  /** Pre-formatted second line; an empty string renders no second line. */
  count: string
  /** A zero-value segment is dimmed rather than hidden: the ring already carries its share. */
  dim?: boolean
}

export interface SliceListProps {
  rows: readonly SliceRow[]
  hoverKey?: string | null
  /** Omitted means no row reacts. */
  onHoverKey?: (key: string | null) => void
}

/** Rows are the ring's legend: hovering either side lights the pair. Clearing the shared key happens
 * on the **container** mouseleave, so moving between rows never blanks the ring. */
export function SliceList(props: SliceListProps): ReactElement {
  return (
    <div
      className="cb-ov-sl"
      onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}
    >
      {props.rows.map(row => (
        <div
          key={row.key}
          className={'cb-ov-sl-row'
            + (row.dim === true ? ' cb-ov-sl-row-dim' : '')
            + (props.hoverKey !== undefined && props.hoverKey === row.key ? ' cb-ov-sl-row-on' : '')}
          onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(row.key) }}
        >
          <div className="cb-ov-sl-main">
            <i className="cb-ov-sl-dot" style={{ background: row.color }} />
            <span className="cb-ov-sl-label" title={row.label}>{row.label}</span>
            <span className="cb-ov-sl-pct">{row.pct}</span>
          </div>
          {row.count !== '' ? <div className="cb-ov-sl-sub" title={row.count}>{row.count}</div> : null}
        </div>
      ))}
    </div>
  )
}

/** Composition stages in draw order: the cached prompt prefix first, then the message stages in the
 * order the model reads them. The order is also the colour-assignment order, so no card can shuffle
 * two cards' legends relative to each other. */
export const STAGE_COLORS: Readonly<Record<string, string>> = {
  system: 'var(--cb-ov-indigo)',
  tools: 'var(--cb-ov-amber)',
  user: 'var(--cb-ov-green)',
  inject: 'var(--cb-ov-purple)',
  skill: 'var(--cb-ov-orange)',
  assistant: 'var(--cb-ov-blue)',
  tool: 'var(--cb-ov-teal)',
}

/** The four billed token buckets, in legend reading order, matching the cost card's own palette. */
export const BUCKET_COLORS: Readonly<Record<string, string>> = {
  cacheRead: 'var(--cb-ov-green)',
  uncached: 'var(--cb-ov-amber)',
  cacheWrite: 'var(--cb-ov-purple)',
  output: 'var(--cb-ov-pink)',
}

/** Timing segments: the same colours the time strip uses on the context surface. */
export const TIMING_COLORS: Readonly<Record<string, string>> = {
  ttft: 'var(--cb-ov-blue)',
  reasoning: 'var(--cb-ov-violet)',
  text: 'var(--cb-ov-pink)',
  toolarg: 'var(--cb-ov-amber)',
  tools: 'var(--cb-ov-teal)',
  other: 'var(--cb-ov-slate)',
  gen: 'var(--cb-ov-violet)',
}

/** Per-model segment palette, cycled in model order so one platform card stays internally stable. */
export const PLATFORM_COLORS: readonly string[] = [
  'var(--cb-ov-green)',
  'var(--cb-ov-amber)',
  'var(--cb-ov-purple)',
  'var(--cb-ov-pink)',
  'var(--cb-ov-blue)',
  'var(--cb-ov-teal)',
]
