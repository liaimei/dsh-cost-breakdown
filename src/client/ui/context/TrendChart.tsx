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
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { RequestRow, Snapshot, TimingSegment } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { formatCount, formatDuration } from '../../i18n/format'
import { headlineOf } from './derive'
import { STAGE_COLOR } from './derive'
import type { TrendBand, DeltaBand, DnaDelta } from './dna'
import { bandLabel, deltaBandsOf } from './dna'

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

/** The chart's fixed plot height in px — mirrored by `.cb-chart` in the stylesheet, and by the grid/axis
 * offsets below; changing one without the others makes the grid lines drift. */
const CHART_H = 112
/** Label band above the plot: the chart's `padding-top`. */
const PAD_TOP = 18
/** Bars are a constant width: dense history scrolls rather than compressing. The turn band below mirrors the
 * same column grid. */
const BAR_W = 14
const BAR_GAP = 2
/** One step flag every N bars (step granularity only). */
const STEP_FLAG_EVERY = 5
/** Neutral zebra fills for the turn band, deliberately disjoint from the stage palette: that band is a
 * partition of time, not a slice of a bar. */
const TURN_FILLS = [
  'color-mix(in srgb, var(--color-neutral-500) 12%, transparent)',
  'color-mix(in srgb, var(--color-neutral-500) 26%, transparent)',
]

/** The chart.
 *
 * The structure is the one this chart has always had: a fixed-height plot row of constant-width bars beside a
 * numeric axis rail, dashed grid lines at the quarters, a solid zero baseline, an optional turn band beneath
 * mirroring the column grid, and two independent overlays — the DNA highlight row and the duration curve.
 * Absolute pixel offsets tie the grid and the axis to `CHART_H` + `PAD_TOP`, so all three constants live here.
 */
export function TrendChart(props: TrendChartProps): ReactElement {
  const { t, rows, markers, mode, selectedSeq, hoveredSeq, dna, durationCurve, adaptive } = props
  const scroll = useRef<HTMLDivElement | null>(null)
  const [localHover, setLocalHover] = useState<number | null>(null)
  const [hoverTurn, setHoverTurn] = useState<number | null>(null)

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

  // Adaptive: once the history outgrows a readable column width, show a slice centred on the active bar.
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

  // The plot's scale: in total mode the tallest bar, in delta mode the largest single change, so one big
  // compaction cannot flatten every other bar.
  const { bars, peak } = useMemo(
    () => barsOf({ rows: windowRows, dna: windowDna, mode, colorOf }),
    [windowRows, windowDna, mode],
  )

  // Painted values for the axis labels: the scale top, its quarters, and zero.
  const axisTop = Math.max(1, peak)

  // The duration curve, scaled to the largest active time in the window.
  let peakActive = 1
  for (const row of windowRows) if ((row.activeMs ?? 0) > peakActive) peakActive = row.activeMs ?? 0
  const activePath = windowRows.map((row, index) => {
    const active = row.activeMs
    return active === undefined ? null : { index, y: PAD_TOP + CHART_H - Math.min(1, active / peakActive) * CHART_H }
  })
  const activePoints = activePath.filter((point): point is { index: number; y: number } => point !== null)

  const activeRow = activeIndex >= 0 && activeIndex < rows.length ? rows[activeIndex] : null
  const turnOf = (row: RequestRow): number => row.turn ?? 0

  // The turn band: one cell per turn run, sized to the columns it spans, so the grid below the bars matches the
  // bars themselves.
  const turns = useMemo(() => {
    const bands: Array<{ turn: number; start: number; span: number }> = []
    windowRows.forEach((row, index) => {
      const turn = turnOf(row)
      const last = bands.at(-1)
      if (last !== undefined && last.turn === turn) {
        last.span += 1
        return
      }
      bands.push({ turn, start: index, span: 1 })
    })
    return bands
  }, [windowRows])

  return h('div', { className: 'cb-chart-wrap' },
    h('div', { className: 'cb-chartrow' },
      // The numeric axis rail: shared by both modes, its offsets tied to the plot geometry.
      h('div', { className: 'cb-axis' },
        h('span', { className: 'cb-axis-top' }, formatCount(axisTop)),
        h('span', { className: 'cb-axis-q3' }, formatCount(Math.round(axisTop * 0.75))),
        mode === 'delta'
          ? h('span', { className: 'cb-axis-mid' }, '0')
          : h('span', { className: 'cb-axis-mid' }, formatCount(Math.round(axisTop * 0.5))),
        h('span', { className: 'cb-axis-q1' }, formatCount(Math.round(axisTop * 0.25))),
        h('span', { className: 'cb-axis-bot' }, mode === 'delta' ? `−${formatCount(axisTop)}` : '0')),
      h('div', { className: 'cb-chart-scroll', ref: scroll },
        h('div', {
          className: `cb-chart${props.hoverBand !== null ? ' cb-chart-catdim' : ''}`,
          role: 'img',
          'aria-label': t('trend.title'),
          ...(props.hoverBand !== null ? { 'data-catdim': props.hoverBand } : {}),
        },
          // Grid lines first, in the same order the stylesheet stacks them.
          h('span', { className: 'cb-grid cb-grid-top' }),
          h('span', { className: 'cb-grid cb-grid-q3' }),
          h('span', { className: 'cb-grid cb-grid-mid' }),
          h('span', { className: 'cb-grid cb-grid-q1' }),
          h('span', { className: 'cb-grid cb-grid-zero' }),
          // The duration curve, drawn under the bars so it never hides one.
          durationCurve && activePoints.length > 1
            ? h('svg', {
              className: 'cb-duration',
              width: windowRows.length * (BAR_W + BAR_GAP),
              height: CHART_H,
              'aria-hidden': 'true',
            }, h('polyline', {
              points: activePoints.map(point => `${point.index * (BAR_W + BAR_GAP) + BAR_W / 2},${Math.round(point.y - PAD_TOP)}`).join(' '),
            }))
            : null,
          bars.map((bar, index) => h('div', {
            key: bar.seq,
            className: `cb-bar${index === activeIndex - from ? ' cb-bar-selected' : ''}${index === localHover ? ' cb-bar-hovered' : ''}`,
            role: 'button',
            tabIndex: 0,
            title: tooltipOf(t, bar.row, props.granularity),
            onMouseEnter: () => {
              setLocalHover(index)
              props.onHover(bar.seq)
              setHoverTurn(turnOf(bar.row))
            },
            onMouseLeave: () => {
              setLocalHover(null)
              props.onHover(null)
              setHoverTurn(null)
            },
            onClick: () => { props.onSelect(activeRow?.seq === bar.seq ? null : bar.seq) },
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              props.onSelect(activeRow?.seq === bar.seq ? null : bar.seq)
            },
          },
            // A step flag every N bars: a 1px pole in the label band with its step number boxed at the top,
            // decor only, outside the animated stack.
            props.granularity === 'step' && index % STEP_FLAG_EVERY === 0 && index > 0
              ? h('span', { className: 'cb-step-flag' },
                h('span', { className: 'cb-step-flag-label' }, formatCount(bar.row.step ?? index)))
              : null,
            mode === 'delta'
              ? [
                h('div', { key: 'up', className: 'cb-bar-up' }, bar.up.map(band => h('div', {
                  key: band.key,
                  'data-cat': band.key,
                  className: 'cb-cat-seg',
                  style: { height: `${Math.max(1, band.height)}px`, background: band.color },
                }))),
                h('div', { key: 'down', className: 'cb-bar-down' }, bar.down.map(band => h('div', {
                  key: band.key,
                  'data-cat': band.key,
                  className: 'cb-cat-seg',
                  style: { height: `${Math.max(1, band.height)}px`, background: band.color },
                }))),
              ]
              : [
                dna !== null
                  ? h('div', {
                    key: 'dna',
                    className: 'cb-bar-dna',
                    style: {
                      height: `${Math.max(1, bar.height)}px`,
                      background: `linear-gradient(to top, ${bar.bands.map(band => `${band.color} ${band.bottom}px ${band.bottom + band.height}px`).join(', ')})`,
                    },
                  })
                  : h('div', { key: 'stack', className: 'cb-bar-stack' }, bar.bands.map(band => h('div', {
                    key: band.key,
                    'data-cat': band.key,
                    className: 'cb-cat-seg',
                    style: { height: `${Math.max(1, band.height)}px`, background: band.color },
                  }))),
              ],
            windowMarkers[index] !== undefined
              ? h('span', {
                className: 'cb-bar-marker',
                title: t(`kind.${(windowMarkers[index] as Snapshot['events'][number]).kind}`),
              }, '✂')
              : null,
          )),
          // The DNA highlight row: a mirrored column grid, so a hovered item lights the same slice in every bar.
          windowDna !== null
            ? h('div', { className: 'cb-dna-hl' }, windowDna.map((bands, index) => h('span', { key: windowRows[index]?.seq ?? index, className: 'cb-dna-cell' },
              bands.map(band => props.hoverBand === band.key
                ? h('span', {
                  key: band.key,
                  className: 'cb-dna-slice',
                  style: { bottom: `${band.off}px`, height: `${Math.max(1, band.tokens)}px` },
                })
                : null))))
            : null)),
    ),
    // The turn band: one cell per turn run, mirroring the column grid.
    h('div', { className: 'cb-turns' }, turns.map(band => h('div', {
      key: band.turn,
      className: `cb-turn${hoverTurn === band.turn ? ' cb-turn-on' : ''}`,
      style: {
        width: `${band.span * (BAR_W + BAR_GAP) - BAR_GAP}px`,
        background: TURN_FILLS[band.turn % TURN_FILLS.length],
      },
      title: t('detail.turn', { t: band.turn, n: band.span }),
      onMouseEnter: () => { setHoverTurn(band.turn) },
      onMouseLeave: () => { setHoverTurn(null) },
    }, h('span', { className: 'cb-turn-label' }, formatCount(band.turn))))),
    // The active bar's composition, below the plot.
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
