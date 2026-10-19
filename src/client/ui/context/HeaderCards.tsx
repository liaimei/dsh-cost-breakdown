/**
 * The context surface's four header cards.
 *
 * They answer the questions a reader asks before scrolling: how many turns/steps/tools is this session, what
 * is it costing in tokens, and where did the wall clock go. The old implementation's layout is preserved card
 * for card — an overview, a token ring, a timing ring, and the plugin's identity — because a reader who
 * learned the page should not have to re-learn it.
 *
 * Two rules hold throughout:
 *   - these cards are **token-only**; money lives in the sidebar summary and the statistics page;
 *   - a figure that was never measured is a dash, never a zero.
 */

import { useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { TimingTotals, Snapshot } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { cacheHitPercent, formatCount, formatDuration } from '../../i18n/format'
import { Donut, SliceList, STAGE_COLORS, TIMING_COLORS, type SliceRow } from '../insights/donut'
import { STAGE_COLOR, stageLabel, STAGES } from './derive'
import { PluginMark } from '../mark'

/** The overview card's inputs: counters only — the proportions live on the composition card and the token
 * numbers on the token card. */
export interface OverviewStatsProps {
  t: Translate
  snapshot: Snapshot
  /** The whole-family billed tokens (this session plus its sub-agents), when known. */
  familyTokens: number | null
  /** Sub-agent count in the family. */
  familyCount: number
  /** The tool tally of the live surface, name → results. */
  tools: ReadonlyArray<readonly [string, number]>
  /** Open a category in the browser (skills / answers figures). */
  onFigureClick?: (kind: 'skills' | 'answers') => void
}

/** The overview card: a compact grid of counts. */
export function OverviewCard(props: OverviewStatsProps): ReactElement {
  const { t, snapshot, familyTokens, familyCount, tools, onFigureClick } = props
  const counts = snapshot.counts
  const turnCount = counts?.turns ?? new Set(snapshot.requests.map(row => row.turn ?? 0)).size
  const stepCount = counts?.steps ?? snapshot.requests.length
  const injects = counts?.injects ?? snapshot.events.filter(event => event.kind === 'inject').length
  const compactions = counts?.compactions ?? snapshot.events.filter(event => event.kind === 'compaction').length
  const prunes = counts?.prunes ?? snapshot.events.filter(event => event.kind === 'prune').length
  const skillCount = counts?.skills ?? 0
  const toolTotal = snapshot.toolCalls ?? 0
  const io = snapshot.current.user + snapshot.current.assistant + snapshot.current.tool

  return h('div', { className: 'cb-card cb-overview-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('stats.title')),
      h('span', { className: 'cb-card-sub' }, t('stats.session'))),
    h('div', { className: 'cb-overview-grid' },
      cell(t('stats.turns'), formatCount(turnCount)),
      cell(t('stats.steps'), formatCount(stepCount)),
      figure(t, t('stats.skills'), formatCount(skillCount), t('stats.skillsJump'), () => onFigureClick?.('skills')),
      figure(t, t('stats.answers'), formatCount(snapshot.answers ?? 0), t('stats.answersJump'), () => onFigureClick?.('answers')),
      cell(t('stats.humanInputs'), formatCount(snapshot.humanInputs ?? 0)),
      cell(t('stats.io'), formatCount(io)),
      cell(t('stats.events'), formatCount(injects + compactions + prunes)),
      cell(t('stats.toolCalls'), formatCount(toolTotal))),
    // The three event kinds as counted pills, so the events card's totals are explained here too.
    h('div', { className: 'cb-overview-pills' },
      pill(t('kind.inject'), injects, 'inject'),
      pill(t('kind.compaction'), compactions, 'compaction'),
      pill(t('kind.prune'), prunes, 'prune')),
    // The tool breakdown: the ranked names, capped, with an overflow count.
    tools.length > 0
      ? h('div', { className: 'cb-overview-tools' },
        tools.slice(0, 8).map(([name, count]) => h('span', { key: name, className: 'cb-overview-tool' },
          h('span', { className: 'cb-overview-tool-name' }, name),
          h('b', null, formatCount(count)))),
        tools.length > 8
          ? h('span', { className: 'cb-overview-tool-more' }, t('stats.toolsMore', { n: formatCount(tools.length - 8) }))
          : null)
      : null,
    familyTokens !== null
      ? h('div', { className: 'cb-overview-family', title: t('stats.teamTip') },
        h('span', { className: 'cb-card-sub' }, `${t('agents.title')} · ${formatCount(familyCount)}`),
        h('span', { className: 'cb-overview-family-tokens' }, formatCount(familyTokens)))
      : null,
  )
}

/** One plain counter cell. */
function cell(label: string, value: string): ReactElement {
  return h('div', { key: label, className: 'cb-overview-cell' },
    h('span', { className: 'cb-overview-label' }, label),
    h('b', { className: 'cb-overview-value' }, value))
}

/** A clickable counter cell (skills / answers jump into the browser). */
function figure(t: Translate, label: string, value: string, tip: string, onClick: () => void): ReactElement {
  void t
  return h('button', {
    key: label,
    type: 'button',
    className: 'cb-overview-cell cb-overview-cell-link',
    title: tip,
    onClick,
  },
    h('span', { className: 'cb-overview-label' }, label),
    h('b', { className: 'cb-overview-value' }, value))
}

/** One event-kind pill. */
function pill(label: string, count: number, kind: string): ReactElement {
  return h('span', { key: kind, className: `cb-overview-pill${count === 0 ? ' cb-overview-pill-dim' : ''}` },
    h('span', { className: `cb-overview-pill-dot cb-kind-${kind}` }),
    h('span', { className: 'cb-overview-pill-label' }, label),
    h('b', null, formatCount(count)))
}

/** The token card: this session's billed tokens, split by what the tokens *are*. */
export function TokensCard(props: { t: Translate; snapshot: Snapshot }): ReactElement {
  const { t, snapshot } = props
  const [hover, setHover] = useState<string | null>(null)
  // The billed buckets are the provider's exact figures; the stage split apportions the prompt side by the
  // composition card's own proportions, which is why those rows carry the ≈ mark.
  const cost = snapshot.cost
  const billed = billedTotals(cost)
  const hit = billed.prompt > 0 ? cacheHitPercent(billed.cacheRead, billed.prompt) : null
  const parts = STAGES.map(stage => ({ key: stage, value: snapshot.current[stage] }))
  const promptTotal = parts.reduce((sum, part) => sum + part.value, 0)
  const rows: SliceRow[] = billed.billed > 0
    ? [
      ...parts.filter(part => part.value > 0).map(part => ({
        key: part.key,
        color: STAGE_COLOR[part.key],
        label: stageLabel(t, part.key),
        pct: share(part.value, promptTotal),
        count: `≈${formatCount(part.value)}`,
      })),
      {
        key: 'output',
        color: 'var(--cb-ctx-pink)',
        label: t('tokens.output'),
        pct: share(billed.output, billed.billed),
        count: `${formatCount(billed.output)} · ${t('tokens.outputNote')}`,
      },
    ]
    : parts.map(part => ({
      key: part.key,
      color: STAGE_COLOR[part.key],
      label: stageLabel(t, part.key),
      pct: '—',
      count: `≈${formatCount(part.value)}`,
      dim: true,
    }))
  return h('div', { className: 'cb-card cb-tokens-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('tokens.title')),
      hit !== null ? h('span', { className: 'cb-card-rate', title: t('stats.cacheHitTip') }, `${t('stats.cacheHit')} ${hit}%`) : null),
    h('div', { className: 'cb-donut-row' },
      h(Donut, {
        segments: rows.map(row => ({ key: row.key, color: row.color, value: rowValue(row, billed, parts) })),
        size: 96,
        centerTop: billed.billed > 0 ? formatCount(billed.billed) : '—',
        centerSub: t('tokens.total'),
        hoverKey: hover,
        onHoverKey: setHover,
      }),
      h(SliceList, { rows, hoverKey: hover, onHoverKey: setHover })))
}

/** The ring's own value for a row: the billed bucket for output, the stage share of the prompt otherwise. */
function rowValue(row: SliceRow, billed: ReturnType<typeof billedTotals>, parts: ReadonlyArray<{ key: string; value: number }>): number {
  if (row.key === 'output') return billed.output
  if (billed.billed === 0) return parts.find(part => part.key === row.key)?.value ?? 0
  const part = parts.find(entry => entry.key === row.key)?.value ?? 0
  const total = parts.reduce((sum, entry) => sum + entry.value, 0)
  return total > 0 ? (part / total) * billed.prompt : 0
}

/** Sum a ledger's buckets. `prompt` is the input side (what the cache rate divides by). */
function billedTotals(cost: Snapshot['cost']): { prompt: number; cacheRead: number; output: number; billed: number } {
  let prompt = 0
  let cacheRead = 0
  let output = 0
  for (const models of Object.values(cost ?? {})) {
    for (const entry of Object.values(models)) {
      for (const period of ['peak', 'off'] as const) {
        const bucket = entry[period]
        if (bucket === undefined) continue
        prompt += bucket.uncached + bucket.cacheRead + bucket.cacheWrite
        cacheRead += bucket.cacheRead
        output += bucket.output
      }
    }
  }
  return { prompt, cacheRead, output, billed: prompt + output }
}

/** A share with the page's usual truncation; a zero whole is a dash. */
function share(part: number, whole: number): string {
  if (!(whole > 0)) return '—'
  return `${Math.round((part / whole) * 100)}%`
}

/** The timing card: where the session's active time went. */
export function TimingCard(props: { t: Translate; snapshot: Snapshot }): ReactElement {
  const { t, snapshot } = props
  const [hover, setHover] = useState<string | null>(null)
  const timing = snapshot.timing
  if (timing === undefined) {
    return h('div', { className: 'cb-card cb-timing-card' },
      h('div', { className: 'cb-card-title' }, h('span', { className: 'cb-card-title-text' }, t('timing.title'))),
      h('div', { className: 'cb-empty' }, t('timing.empty')))
  }
  const segments = timingSegments(timing, t)
  const total = segments.reduce((sum, segment) => sum + segment.ms, 0)
  const rows: SliceRow[] = segments.map(segment => ({
    key: segment.key,
    color: segment.color,
    label: segment.label,
    pct: share(segment.ms, total),
    count: segment.times === undefined ? formatDuration(segment.ms) : `${formatDuration(segment.ms)} · ${segment.times}`,
  }))
  return h('div', { className: 'cb-card cb-timing-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('timing.title')),
      timing.speedTokens !== undefined && timing.speedMs !== undefined && timing.speedMs > 0
        ? h('span', { className: 'cb-card-rate', title: t('timing.tpsTip') },
          t('timing.tps', { tps: formatTps((timing.speedTokens / timing.speedMs) * 1000) }))
        : null),
    h('div', { className: 'cb-donut-row' },
      h(Donut, {
        segments: segments.map(segment => ({ key: segment.key, color: segment.color, value: segment.ms })),
        size: 96,
        centerTop: formatDuration(timing.wallMs),
        centerSub: t('timing.total'),
        hoverKey: hover,
        onHoverKey: setHover,
      }),
      h(SliceList, { rows, hoverKey: hover, onHoverKey: setHover })))
}

/** The decode throughput figure, formatted like the harness's own statistics slot. */
function formatTps(value: number): string {
  const clamped = Math.max(0, value)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** One timing slice before its share is computed. */
interface TimingSlice { key: string; color: string; label: string; ms: number; times?: string }

/**
 * Split the totals into the ring's slices.
 *
 * A segment that never happened (zero duration) is omitted entirely: the ring already skips its arc, and a
 * zero row would borrow the session's call count and read as "no time, yet many calls".
 */
function timingSegments(timing: TimingTotals, t: Translate): TimingSlice[] {
  const weighted: TimingSlice[] = [
    { key: 'ttft', color: TIMING_COLORS.ttft, label: t('timing.ttft'), ms: timing.ttftMs, times: t('timing.callTimes', { n: formatCount(timing.calls) }) },
  ]
  // When the host folded the decode split, the generation segment expands into what was being decoded.
  if (timing.reasoningMs !== undefined && timing.reasoningMs > 0) {
    weighted.push({ key: 'reasoning', color: TIMING_COLORS.reasoning, label: t('timing.reasoning'), ms: timing.reasoningMs, times: t('timing.blockTimes', { n: formatCount(timing.reasoningBlocks ?? 0) }) })
  }
  if (timing.textMs !== undefined && timing.textMs > 0) {
    weighted.push({ key: 'text', color: TIMING_COLORS.text, label: t('timing.text'), ms: timing.textMs, times: t('timing.blockTimes', { n: formatCount(timing.textBlocks ?? 0) }) })
  }
  if (timing.toolArgMs !== undefined && timing.toolArgMs > 0) {
    weighted.push({ key: 'toolarg', color: TIMING_COLORS.toolarg, label: t('timing.toolArgs'), ms: timing.toolArgMs, times: t('timing.blockTimes', { n: formatCount(timing.toolArgBlocks ?? 0) }) })
  }
  if (timing.reasoningMs === undefined && timing.textMs === undefined && timing.toolArgMs === undefined && timing.genMs > 0) {
    weighted.push({ key: 'gen', color: TIMING_COLORS.gen, label: t('timing.gen'), ms: timing.genMs })
  }
  if (timing.toolsMs > 0) {
    weighted.push({ key: 'tools', color: TIMING_COLORS.tools, label: t('timing.tools'), ms: timing.toolsMs, times: t('timing.toolTimes', { n: formatCount(timing.toolCalls) }) })
  }
  // The residual keeps the ring's sum equal to the wall clock.
  const attributed = weighted.reduce((sum, slice) => sum + slice.ms, 0)
  const residual = timing.wallMs - attributed
  if (residual > 0) {
    weighted.push({ key: 'other', color: TIMING_COLORS.other, label: t('timing.other'), ms: residual })
  }
  return weighted.filter(slice => slice.ms > 0)
}

/** The plugin's identity card: the mark, the version, and the repository link. */
export function PluginCard(props: { t: Translate; version: string; repo: string | null }): ReactElement {
  const { t, version, repo } = props
  return h('div', { className: 'cb-card cb-plugin-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('plugin.title'))),
    h('div', { className: 'cb-plugin-row' },
      h(PluginMark, { size: 22 }),
      h('span', { className: 'cb-plugin-name' }, t('plugin.name')),
      h('span', { className: 'cb-plugin-version' }, version)),
    repo !== null
      ? h('a', { className: 'cb-plugin-link', href: repo, target: '_blank', rel: 'noreferrer' }, t('plugin.github'))
      : null,
    h('div', { className: 'cb-card-sub' }, t('plugin.hint')))
}

/** Re-exported so the surface's cards share one palette table. */
export { STAGE_COLORS }
export type { ReactNode }
