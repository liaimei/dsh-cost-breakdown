/**
 * The three token cards under the KPI band — the "token half" of the page.
 *
 * All three are token-denominated on purpose: money has its own section below, and a card that mixed
 * the two would claim the two quantities could be compared. Each card therefore spells out which
 * token accounting it shows:
 *   1. **billed buckets** — what the provider actually metered (cache hit, uncached input, cache
 *      write, output), never an estimate;
 *   2. **stage split** — where the context's tokens went, apportioned by the composition card's own
 *      proportions (marked `≈`, because the prompt side is a split of a reported total);
 *   3. **timing** — where the wall clock went, with the ring clamped so overlapping tool runs can
 *      never push it past the wall clock while the rows keep the real durations.
 */

import { useState, type ReactElement, type ReactNode } from 'react'
import type { TimingTotals } from '../../../wire/model'
import type { BilledTotals, TokenPartTotal, UsageTotals } from '../../data/aggregate'
import { cacheHitPercent, formatCount, formatDuration, formatShare } from '../../i18n/format'
import type { Translate } from '../../i18n/dict'
import { BUCKET_COLORS, Donut, SliceList, STAGE_COLORS, TIMING_COLORS, type SliceRow } from './donut'

/** The four billed buckets in legend reading order. */
const BUCKETS = ['cacheRead', 'uncached', 'cacheWrite', 'output'] as const

/** A bucket's display label; assembled here so the two token cards cannot drift. */
const BUCKET_LABELS: Readonly<Record<(typeof BUCKETS)[number], string>> = {
  cacheRead: 'stats.costHit',
  uncached: 'stats.costMiss',
  cacheWrite: 'stats.costWrite',
  output: 'stats.costOut',
}

/** The card frame every donut card shares: a title row and one body slot. */
function Card(props: { title: string; rate?: string; rateTip?: string; children: ReactNode }): ReactElement {
  return (
    <div className="cb-ov-card cb-ov-card-donut">
      <div className="cb-ov-card-title">
        <span className="cb-ov-card-title-text">{props.title}</span>
        {props.rate !== undefined && (
          <span className="cb-ov-card-rate" title={props.rateTip}>
            {props.rate}
          </span>
        )}
      </div>
      {props.children}
    </div>
  )
}

/** Donut + legend, the one row shape three cards use. */
function DonutRow(props: {
  segments: ReadonlyArray<{ key: string; color: string; value: number }>
  centerTop: string
  centerSub: string
  rows: SliceRow[]
  hoverKey: string | null
  onHoverKey: (key: string | null) => void
}): ReactElement {
  return (
    <div className="cb-ov-donut-row">
      <Donut
        segments={props.segments}
        size={96}
        centerTop={props.centerTop}
        centerSub={props.centerSub}
        hoverKey={props.hoverKey}
        onHoverKey={props.onHoverKey}
      />
      <SliceList rows={props.rows} hoverKey={props.hoverKey} onHoverKey={props.onHoverKey} />
    </div>
  )
}

export interface BilledCardProps {
  /** The scope's billed totals, or `null` when the scope has no billing at all. */
  billed: BilledTotals | null
  t: Translate
}

/** Card 1: the reported billed buckets. Every number here is metered, so none carries `≈`. */
export function BilledCard(props: BilledCardProps): ReactElement {
  const { t } = props
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const billed = props.billed
  if (billed === null) {
    return <Card title={t('ov.billed.title')}><div className="cb-ov-empty">{t('ov.stats.empty')}</div></Card>
  }
  // Zero buckets are dropped: the legend lists only what actually happened.
  const shown = BUCKETS.filter(bucket => billed.costByBucket[bucket] > 0)
  // A credit-only range has spend but no token buckets; render the shell (the spend section lives
  // below, not here) only when there is something at all.
  if (shown.length === 0 && billed.platforms.length === 0) {
    return <Card title={t('ov.billed.title')}><div className="cb-ov-empty">{t('ov.stats.empty')}</div></Card>
  }
  const total = billed.tokens.total
  const rows: SliceRow[] = shown.map(bucket => ({
    key: bucket,
    color: BUCKET_COLORS[bucket] ?? 'var(--cb-ov-slate)',
    label: t(BUCKET_LABELS[bucket]),
    pct: formatShare(billed.costByBucket[bucket], billed.costByBucket.total),
    count: formatCount(billed.costByBucket[bucket]),
  }))
  return (
    <Card title={t('ov.billed.title')}>
      {shown.length > 0
        ? (
          <DonutRow
            segments={shown.map(bucket => ({
              key: bucket,
              color: BUCKET_COLORS[bucket] ?? 'var(--cb-ov-slate)',
              value: billed.costByBucket[bucket],
            }))}
            centerTop={formatCount(billed.costByBucket.total)}
            centerSub={t('tokens.total')}
            rows={rows}
            hoverKey={hoverKey}
            onHoverKey={setHoverKey}
          />
        )
        : null}
      {total === 0 ? <div className="cb-ov-empty">{t('ov.stats.empty')}</div> : null}
    </Card>
  )
}

export interface StageCardProps {
  /** Per-stage token totals from the scope's live context composition. */
  parts: readonly TokenPartTotal[]
  t: Translate
}

/** Card 2: the per-stage split. The prompt side is apportioned from each row's composition, so its
 * counts are marked `≈`; the total in the hole is the metered number. */
export function StageCard(props: StageCardProps): ReactElement {
  const { t } = props
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const total = props.parts.reduce((sum, part) => sum + part.tokens, 0)
  const shown = props.parts.filter(part => part.tokens > 0)
  if (total <= 0) {
    return <Card title={t('tokens.title')}><div className="cb-ov-empty">{t('ov.stats.empty')}</div></Card>
  }
  const rows: SliceRow[] = shown.map(part => ({
    key: part.key,
    color: STAGE_COLORS[part.key] ?? 'var(--cb-ov-slate)',
    label: t('cat.' + part.key),
    pct: formatShare(part.tokens, total),
    count: '≈' + formatCount(part.tokens),
  }))
  return (
    <Card title={t('tokens.title')}>
      <DonutRow
        segments={shown.map(part => ({
          key: part.key,
          color: STAGE_COLORS[part.key] ?? 'var(--cb-ov-slate)',
          value: part.tokens,
        }))}
        centerTop={formatCount(total)}
        centerSub={t('tokens.total')}
        rows={rows}
        hoverKey={hoverKey}
        onHoverKey={setHoverKey}
      />
    </Card>
  )
}

/** Decode throughput, formatted the way the harness's own session-stats slot does it: whole numbers
 * at ten and above, one decimal below. */
function formatTokensPerSecond(tokensPerSecond: number): string {
  const clamped = Math.max(0, tokensPerSecond)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** One ring slice before its share is computed; `ms` is the **real** duration the row prints, while
 * the ring value is clamped into its window. */
interface TimingSlice {
  key: string
  color: string
  label: string
  ms: number
  /** The count that qualifies this segment (calls, runs, blocks), already translated. */
  times?: string
}

export interface TimingCardProps {
  timing: TimingTotals | null
  t: Translate
}

/**
 * Card 3: where the wall clock went.
 *
 * The ring arithmetic is the load-bearing part. Windows are allocated in reading order and each is
 * clamped into what the previous ones left: TTFT, then the generation window (shared sequentially by
 * the decode buckets when the host folded them), then tools, then the remainder as overhead. Rows
 * print the real durations instead, so a parallel tool run that overlaps the model window cannot
 * change a number the reader sees — only the ring, which must stay a ring.
 */
export function TimingCard(props: TimingCardProps): ReactElement {
  const { t } = props
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const timing = props.timing
  const wall = timing !== null && Number.isFinite(timing.wallMs) && timing.wallMs > 0 ? timing.wallMs : 0
  // Throughput pairs provider output tokens with the decode window, exactly like the harness's own
  // fold; a missing half (an older cache row) renders no figure rather than a guess.
  const tokensPerSecond = timing !== null
    && typeof timing.speedMs === 'number' && Number.isFinite(timing.speedMs) && timing.speedMs > 0
    && typeof timing.speedTokens === 'number' && Number.isFinite(timing.speedTokens) && timing.speedTokens >= 0
    ? formatTokensPerSecond(timing.speedTokens / (timing.speedMs / 1_000))
    : null
  let segments: Array<{ key: string; color: string; value: number }> = []
  let rows: SliceRow[] = []
  if (timing !== null && (wall > 0 || timing.calls > 0 || timing.toolCalls > 0)) {
    const callTimes = t('timing.callTimes', { n: formatCount(timing.calls) })
    const modelSlices: TimingSlice[] = [
      { key: 'ttft', color: TIMING_COLORS.ttft, label: t('timing.ttft'), ms: timing.ttftMs, times: callTimes },
    ]
    // Generation either unfolds into its decode buckets or stays one slice. Only split when a bucket
    // actually carries time: a host that never folded the split serves `genMs` alone, and a log with
    // token increments but no block markers yields all-zero buckets — three dead rows would then be
    // worse than the unsplit shape.
    const blockTimes = (blocks?: number): string | undefined =>
      blocks !== undefined && blocks > 0 ? t('timing.blockTimes', { n: formatCount(blocks) }) : undefined
    const decodeBuckets: TimingSlice[] = [
      { key: 'reasoning', color: TIMING_COLORS.reasoning, label: t('timing.reasoning'), ms: timing.reasoningMs ?? 0, ...maybeTimes(blockTimes(timing.reasoningBlocks)) },
      { key: 'text', color: TIMING_COLORS.text, label: t('timing.text'), ms: timing.textMs ?? 0, ...maybeTimes(blockTimes(timing.textBlocks)) },
      { key: 'toolarg', color: TIMING_COLORS.toolarg, label: t('timing.toolArgs'), ms: timing.toolArgMs ?? 0, ...maybeTimes(blockTimes(timing.toolArgBlocks)) },
    ]
    if (decodeBuckets.some(bucket => bucket.ms > 0)) modelSlices.push(...decodeBuckets)
    else modelSlices.push({ key: 'gen', color: TIMING_COLORS.gen, label: t('timing.gen'), ms: timing.genMs })
    const ttftRing = Math.min(Math.max(0, timing.ttftMs), wall)
    const genRing = Math.max(0, Math.min(timing.genMs, wall - ttftRing))
    const genEnd = ttftRing + genRing
    let used = ttftRing
    const modelRings: number[] = [ttftRing]
    for (const slice of modelSlices.slice(1)) {
      const take = Math.max(0, Math.min(slice.ms, genEnd - used))
      modelRings.push(take)
      used += take
    }
    const toolRing = Math.max(0, Math.min(timing.toolsMs, wall - ttftRing - genRing))
    const other = Math.max(0, wall - ttftRing - genRing - toolRing)
    const share = (ms: number): number => (wall > 0 ? ms / wall : 0)
    // A slice that never happened is hidden, not printed as a zero: a `0.0%` row still carrying a
    // count reads as "323 calls that took no time", while the truth is that nothing ran there. The
    // ring already skips a zero arc, so the legend now matches it.
    const toRow = (slice: TimingSlice): SliceRow => ({
      key: slice.key,
      color: slice.color,
      label: slice.label,
      pct: formatShare(slice.ms, wall),
      count: slice.ms > 0
        ? (slice.times === undefined ? formatDuration(slice.ms) : `${formatDuration(slice.ms)} · ${slice.times}`)
        : (slice.times ?? ''),
    })
    segments = [
      ...modelSlices.map((slice, index) => ({ key: slice.key, color: slice.color, value: share(modelRings[index]) })),
      { key: 'tools', color: TIMING_COLORS.tools, value: share(toolRing) },
      { key: 'other', color: TIMING_COLORS.other, value: share(other) },
    ]
    rows = [
      ...modelSlices.map(toRow),
      toRow({
        key: 'tools',
        color: TIMING_COLORS.tools,
        label: t('timing.tools'),
        ms: timing.toolsMs,
        times: t('timing.toolTimes', { n: formatCount(timing.toolCalls) }),
      }),
      toRow({ key: 'other', color: TIMING_COLORS.other, label: t('timing.other'), ms: other }),
    ].filter(row => row.count !== '')
  }
  return (
    <Card
      title={t('timing.title')}
      {...(tokensPerSecond !== null ? { rate: t('timing.tps', { tps: tokensPerSecond }), rateTip: t('timing.tpsTip') } : {})}
    >
      {rows.length === 0
        ? <div className="cb-ov-empty">{t('timing.empty')}</div>
        : (
          <DonutRow
            segments={segments}
            centerTop={wall > 0 ? formatDuration(wall) : '—'}
            centerSub={t('timing.total')}
            rows={rows}
            hoverKey={hoverKey}
            onHoverKey={setHoverKey}
          />
        )}
    </Card>
  )
}

/** Spread an optional value into an object literal: with `exactOptionalPropertyTypes`-style strictness
 * a property set to `undefined` is not the same as an absent one. */
function maybeTimes(times: string | undefined): { times?: string } {
  return times === undefined ? {} : { times }
}

/** The cache-hit share of the billed prompt — the KPI band's figure, exported so the page and the
 * token cards read the same number from the same place. */
export function cacheHitOf(totals: UsageTotals | null): string | null {
  if (totals === null) return null
  return cacheHitPercent(totals.cacheRead, totals.uncached + totals.cacheRead + totals.cacheWrite)
}

/** The stage order the token card draws in, re-exported so a future stacked view cannot reorder it. */
export { STAGE_ORDER } from '../../data/aggregate'
