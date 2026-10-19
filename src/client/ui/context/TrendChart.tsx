/**
 * The composition trend chart.
 *
 * One bar per step (or per turn), drawn three ways:
 *   - **stacked** (default) — the bar is the request's composition, anchored to the provider's own prompt
 *     size so the top of the bar is the real context, not a heuristic sum;
 *   - **DNA** — the bar is decomposed into one band per *item* in read order (system, each tool schema, then
 *     each message), so a reader can see which message grew;
 *   - **delta** — each bar is the change against its baseline, drawn above and below one zero line.
 *
 * Two overlays are independent of those modes: the **duration curve** traces each step's active time, and
 * **adaptive** narrows the window to a readable slice around the active bar once the history outgrows the
 * card's width (a 400-step session otherwise draws 2px columns nobody can hit).
 */

import { useMemo, useRef, useState } from 'react'
import { createElement as h, Fragment } from 'react'
import type { ReactElement } from 'react'
import type { RequestRow, Snapshot, TimingSegment } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { formatCount, formatDuration } from '../../i18n/format'
import { headlineOf } from './derive'
import { STAGE_COLOR } from './derive'
import type { TrendBand, DeltaBand, DnaDelta } from './dna'
import { bandLabel, deltaBandsOf } from './dna'

/** Only the newest columns animate in: the chart mounts anchored to the newest bar, and animating the whole
 * window would layer the card and stall its expansion. */
const RISE_CAP = 200

/** Bars drawn at most in adaptive mode, centred on the active one. */
const ADAPTIVE_WINDOW = 40

/** The chart's inputs. Geometry is derived here, never passed in. */
export interface TrendChartProps {
  t: Translate
  rows: readonly RequestRow[]
  markers: ReadonlyArray<Snapshot['events'][number] | undefined>
  granularity: 'step' | 'turn'
  mode: 'total' | 'delta'
  selectedSeq: number | null
  hoveredSeq: number | null
  focusTurn: number | null
  /** DNA bands per bar, or `null` when DNA mode is off. */
  dna: readonly TrendBand[][] | null
  /** The active step's own band highlight, by key. */
  hoverBand: string | null
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  onHoverBand: (key: string | null) => void
  /** Whether the duration curve overlay is drawn. */
  durationCurve: boolean
  /** Whether the window narrows around the active bar. */
  adaptive: boolean
  /** The timing slices of the whole session, for the duration overlay. */
  spans: readonly TimingSegment[] | undefined
}

/** One drawn bar: its geometry and the bands that fill it. */
interface Bar {
  seq: number
  row: RequestRow
  height: number
  top: number
  /** Stacked bands, bottom-up. */
  bands: Array<{ key: string; color: string; height: number; bottom: number }>
  /** Delta mode: the parts above and below the zero line. */
  up: Array<{ key: string; color: string; height: number; bottom: number }>
  down: Array<{ key: string; color: string; height: number; bottom: number }>
  clickable: boolean
}

/** Height of the plotting area in px; the CSS sets the same value so the two cannot drift. */
const PLOT_HEIGHT = 132

/** Build the bars for one mode. */
function barsOf(input: {
  rows: readonly RequestRow[]
  dna: readonly TrendBand[][] | null
  mode: 'total' | 'delta'
  colorOf: (cat: string) => string
}): { bars: Bar[]; peak: number } {
  const { rows, dna, mode, colorOf } = input
  if (mode === 'delta') {
    // A delta bar splits at the zero line; the scale is driven by the largest single change, so one big
    // compaction cannot flatten every other bar.
    const deltas: DnaDelta[] = rows.map((_row, index) => (dna !== null && dna[index] !== undefined
      ? deltaBandsOf([...(dna[index] as TrendBand[])], index > 0 ? [...(dna[index - 1] as TrendBand[])] : null)
      : { up: [], down: [] }))
    let peak = 1
    for (const delta of deltas) {
      const up = delta.up.reduce((sum, band) => sum + band.tokens, 0)
      const down = delta.down.reduce((sum, band) => sum + -band.tokens, 0)
      peak = Math.max(peak, up, down)
    }
    const bars = deltas.map((delta, index): Bar => ({
      seq: rows[index].seq,
      row: rows[index],
      height: 0,
      top: 0,
      bands: [],
      up: delta.up.map((band: DeltaBand) => ({
        key: band.key,
        color: band.color,
        height: (band.tokens / peak) * (PLOT_HEIGHT / 2),
        bottom: (band.off / peak) * (PLOT_HEIGHT / 2),
      })),
      down: delta.down.map((band: DeltaBand) => ({
        key: band.key,
        color: band.color,
        height: (-band.tokens / peak) * (PLOT_HEIGHT / 2),
        bottom: (band.off / peak) * (PLOT_HEIGHT / 2),
      })),
      clickable: true,
    }))
    return { bars, peak }
  }
  if (dna !== null) {
    // DNA: each bar is its own total, scaled to the tallest bar in the window.
    let peak = 1
    for (const bands of dna) {
      const total = bands.reduce((sum, band) => sum + band.tokens, 0)
      peak = Math.max(peak, total)
    }
    const bars = rows.map((row, index): Bar => {
      const bands = dna[index] ?? []
      const total = bands.reduce((sum, band) => sum + band.tokens, 0)
      const scale = total > 0 ? (total / peak) * PLOT_HEIGHT / total : 0
      const rendered: Bar['bands'] = []
      let bottom = 0
      for (const band of bands) {
        const height = band.tokens * scale
        rendered.push({ key: band.key, color: band.color, height, bottom })
        bottom += height
      }
      return { seq: row.seq, row, height: (total / peak) * PLOT_HEIGHT, top: 0, bands: rendered, up: [], down: [], clickable: true }
    })
    return { bars, peak }
  }
  // Stacked: the bar splits the request's composition by stage, scaled to the tallest total.
  let peak = 1
  for (const row of rows) peak = Math.max(peak, row.total)
  const bars = rows.map((row): Bar => {
    const parts: Array<[string, number]> = [
      ['system', row.system],
      ['tools', row.tools],
      ['user', row.user],
      ['inject', row.inject],
      ['skill', row.skill ?? 0],
      ['assistant', row.assistant],
      ['tool', row.tool],
    ]
    const rendered: Bar['bands'] = []
    let bottom = 0
    for (const [key, tokens] of parts) {
      if (tokens <= 0) continue
      const height = (tokens / peak) * PLOT_HEIGHT
      rendered.push({ key, color: colorOf(key), height, bottom })
      bottom += height
    }
    return { seq: row.seq, row, height: (row.total / peak) * PLOT_HEIGHT, top: 0, bands: rendered, up: [], down: [], clickable: true }
  })
  return { bars, peak }
}

/** The chart. */
export function TrendChart(props: TrendChartProps): ReactElement {
  const { t, rows, markers, mode, selectedSeq, hoveredSeq, dna, durationCurve, adaptive } = props
  const plot = useRef<HTMLDivElement | null>(null)
  const [localHover, setLocalHover] = useState<number | null>(null)

  const activeIndex = (() => {
    const hovered = hoveredSeq ?? localHover
    if (hovered !== null) {
      const index = rows.findIndex(row => row.seq === hovered)
      if (index >= 0) return index
    }
    if (selectedSeq !== null) {
      const index = rows.findIndex(row => row.seq === selectedSeq)
      if (index >= 0) return index
    }
    return rows.length - 1
  })()

  // Adaptive: once the history outgrows a readable column width, show a slice centred on the active bar. The
  // newest bar stays in view when nothing is selected, which is where the chart mounts.
  const [from, to] = (() => {
    if (!adaptive || rows.length <= ADAPTIVE_WINDOW) return [0, rows.length] as const
    const half = Math.floor(ADAPTIVE_WINDOW / 2)
    const start = Math.max(0, Math.min(activeIndex - half, rows.length - ADAPTIVE_WINDOW))
    return [start, start + ADAPTIVE_WINDOW] as const
  })()

  const windowRows = rows.slice(from, to)
  const windowMarkers = markers.slice(from, to)
  const windowDna = dna === null ? null : dna.slice(from, to)
  const colorOf = (cat: string): string => STAGE_COLOR[cat as keyof typeof STAGE_COLOR] ?? 'var(--cb-ctx-slate)'

  const { bars, peak } = useMemo(
    () => barsOf({ rows: windowRows, dna: windowDna, mode, colorOf }),
    // `colorOf` is derived from a frozen table, so the rows and the mode are the real inputs.
    [windowRows, windowDna, mode],
  )

  // The duration curve: each visible step's active time, scaled to the largest in the window.
  let peakActive = 1
  for (const row of windowRows) if ((row.activeMs ?? 0) > peakActive) peakActive = row.activeMs ?? 0
  const durationPoints = windowRows.map((row, index) => {
    const active = row.activeMs
    if (active === undefined) return null
    return { index, y: PLOT_HEIGHT - Math.min(1, active / peakActive) * PLOT_HEIGHT }
  })

  /** Resolve a pointer position to a bar index (used by the click-anywhere-in-the-plot convention). */
  const barAt = (event: { clientX: number }): number | null => {
    const element = plot.current
    if (element === null) return null
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || windowRows.length === 0) return null
    const ratio = (event.clientX - rect.left) / rect.width
    return Math.max(0, Math.min(windowRows.length - 1, Math.floor(ratio * windowRows.length)))
  }

  const activeRow = activeIndex >= 0 && activeIndex < rows.length ? rows[activeIndex] : null

  return h('div', { className: 'cb-trend-wrap' },
    h('div', {
      ref: plot,
      className: `cb-trend${mode === 'delta' ? ' cb-trend-delta' : ''}`,
      role: 'img',
      'aria-label': t('trend.title'),
      onClick: (event: MouseEvent) => {
        const index = barAt(event)
        if (index === null) return
        const row = windowRows[index]
        props.onSelect(activeRow?.seq === row.seq ? null : row.seq)
      },
      onMouseLeave: () => {
        props.onHover(null)
        setLocalHover(null)
        props.onHoverBand(null)
      },
    },
      colors(durationCurve ? durationPoints : []),
      // turn bands: a hairline at each turn change, so a long run of steps stays readable.
      windowRows.map((row, index) => {
        const isTurnStart = index === 0 || (windowRows[index - 1].turn ?? 0) !== (row.turn ?? 0)
        return isTurnStart
          ? h('span', { key: `turn-${row.seq}`, className: 'cb-trend-turnline', style: { left: `${(index / windowRows.length) * 100}%` } })
          : null
      }),
      bars.map((bar, index) => h('button', {
        key: bar.seq,
        type: 'button',
        className: `cb-trend-bar${index === activeIndex - from ? ' cb-trend-bar-on' : ''}${index < windowRows.length - RISE_CAP ? '' : ' cb-trend-bar-rise'}`,
        style: { height: `${Math.max(2, bar.height)}px` },
        title: tooltipOf(t, bar.row, props.granularity),
        'aria-label': tooltipOf(t, bar.row, props.granularity),
        onMouseEnter: () => {
          setLocalHover(bar.seq)
          props.onHover(bar.seq)
        },
        onClick: (event: MouseEvent) => {
          // The plot's own click handler would otherwise toggle twice.
          event.stopPropagation()
          props.onSelect(activeRow?.seq === bar.seq ? null : bar.seq)
        },
      },
        mode === 'delta'
          ? h(Fragment, null,
            h('span', { className: 'cb-trend-zero' }),
            bar.up.map(band => h('span', {
              key: `u-${band.key}`,
              className: `cb-trend-band${props.hoverBand === band.key ? ' cb-trend-band-on' : ''}`,
              style: { background: band.color, height: `${band.height}px`, bottom: `calc(50% + ${band.bottom}px)` },
              onMouseEnter: () => { props.onHoverBand(band.key) },
            })),
            bar.down.map(band => h('span', {
              key: `d-${band.key}`,
              className: `cb-trend-band${props.hoverBand === band.key ? ' cb-trend-band-on' : ''}`,
              style: { background: band.color, height: `${band.height}px`, top: `calc(50% + ${band.bottom}px)` },
              onMouseEnter: () => { props.onHoverBand(band.key) },
            })))
          : bar.bands.map(band => h('span', {
            key: band.key,
            className: `cb-trend-band${props.hoverBand === band.key ? ' cb-trend-band-on' : ''}`,
            style: { background: band.color, height: `${band.height}px`, bottom: `${band.bottom}px` },
            onMouseEnter: () => { props.onHoverBand(band.key) },
          })),
        (windowMarkers[index] ?? null) !== null
          ? h('span', { className: 'cb-trend-marker', title: t(`kind.${(windowMarkers[index] as Snapshot['events'][number]).kind}`) })
          : null)),
    ),
    h('div', { className: 'cb-trend-axis' },
      h('span', null, `0`),
      h('span', null, formatCount(peak))),
    // The active bar's detail: what it is, and what it is made of.
    activeRow !== null
      ? h('div', { className: 'cb-trend-detail' },
        h('div', { className: 'cb-trend-detail-row' },
          h('span', { className: 'cb-card-sub' }, props.granularity === 'turn'
            ? t('detail.turn', { t: activeRow.turn ?? 0, n: activeRow.stepCount ?? 1 })
            : t('detail.step', { t: activeRow.turn ?? 0, s: activeRow.step ?? 0, n: 0 })),
          h('span', { className: 'cb-trend-detail-total' }, formatCount(activeRow.total))),
        props.granularity === 'step' && windowDna !== null && windowDna[activeIndex - from] !== undefined
          ? h('div', { className: 'cb-trend-dna-legend' }, (windowDna[activeIndex - from] as TrendBand[]).slice(0, 24).map(band => h('span', {
            key: band.key,
            className: `cb-trend-dna-item${props.hoverBand === band.key ? ' cb-trend-dna-item-on' : ''}`,
            onMouseEnter: () => { props.onHoverBand(band.key) },
            onMouseLeave: () => { props.onHoverBand(null) },
          },
            h('span', { className: 'cb-trend-dna-dot', style: { background: band.color } }),
            h('span', { className: 'cb-trend-dna-label' }, bandLabel(band, t, key => t(`cat.${key}`))),
            h('span', { className: 'cb-trend-dna-tokens' }, formatCount(band.tokens)))))
          : null,
        h('div', { className: 'cb-kv-grid' },
          kv(t('cat.system'), formatCount(activeRow.system)),
          kv(t('cat.tools'), formatCount(activeRow.tools)),
          kv(t('cat.user'), formatCount(activeRow.user)),
          kv(t('cat.inject'), formatCount(activeRow.inject)),
          kv(t('cat.skill'), formatCount(activeRow.skill ?? 0)),
          kv(t('cat.assistant'), formatCount(activeRow.assistant)),
          kv(t('cat.tool'), formatCount(activeRow.tool)),
          kv(t('stats.cacheHit'), activeRow.prompt !== undefined && activeRow.prompt > 0 && activeRow.cacheRead !== undefined
            ? `${Math.round((activeRow.cacheRead / activeRow.prompt) * 100)}%`
            : '—'),
          kv(t('tokens.output'), activeRow.output !== undefined ? formatCount(activeRow.output) : '—'),
          kv(t('timing.total'), activeRow.activeMs !== undefined ? formatDuration(activeRow.activeMs) : '—')))
      : null,
  )
}

/** The duration curve overlay: a polyline through each visible step's active time. */
function colors(points: ReadonlyArray<{ index: number; y: number } | null>): ReactElement | null {
  const visible = points.filter((point): point is { index: number; y: number } => point !== null)
  if (visible.length < 2) return null
  const width = 100
  const path = visible
    .map((point, order) => `${order === 0 ? 'M' : 'L'}${(point.index / Math.max(1, points.length - 1)) * width},${point.y}`)
    .join(' ')
  return h('svg', {
    className: 'cb-trend-duration',
    viewBox: `0 0 ${width} ${PLOT_HEIGHT}`,
    preserveAspectRatio: 'none',
    'aria-hidden': 'true',
  }, h('path', { d: path, fill: 'none', stroke: 'var(--cb-ctx-pink)', 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke' }))
}

/** A bar's tooltip: its turn/step identity and its billed total. */
function tooltipOf(t: Translate, row: RequestRow, granularity: 'step' | 'turn'): string {
  const identity = granularity === 'turn'
    ? t('detail.turn', { t: row.turn ?? 0, n: row.stepCount ?? 1 })
    : t('detail.step', { t: row.turn ?? 0, s: row.step ?? 0, n: 0 })
  return `${identity} · ${t('tip.total', { n: formatCount(row.total) })}`
}

/** One key/value cell in the detail block. */
function kv(key: string, value: string): ReactElement {
  return h('div', { key, className: 'cb-kv' },
    h('span', { className: 'cb-kv-key' }, key),
    h('span', { className: 'cb-kv-value' }, value))
}

/** Re-exported for the view, which owns the DNA toggle and the band hover state. */
export { headlineOf }
