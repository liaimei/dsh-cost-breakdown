/**
 * The conversation Context surface: what the model currently sees, how it got there, and what it touched.
 *
 * It is deliberately **token-only**: money lives in the sidebar summary and the statistics page. Putting a
 * currency figure here would invite the reader to treat tokens and prices as interchangeable, and they
 * answer different questions.
 *
 * The surface is one composition over small, single-question sections, so a change in one section does
 * not ripple through the others.
 */

import { createElement as h, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ClientContext, ContextSeatProps } from '../../shell/contracts'
import { headerEpochsOf } from '../../shell/contracts'
import type { Translate } from '../../i18n/dict'
import type { PreferencesStore } from '../../shell/preferences'
import { useTimelineSource } from '../../data/timeline'
import { formatClock, formatCount, formatDuration, formatShare } from '../../i18n/format'
import { headlineOf, stageLabel } from './derive'
import { takeContextFocus } from './jump'
import { makeErrorBoundary } from './ErrorBoundary'
import { BrowserCard } from './Browser'
import type { RequestRow, Snapshot } from '../../../wire/model'

/** The view's props: the seat plus the closures the entry supplies. */
export interface ContextViewProps extends ContextSeatProps {
  t: Translate
  ctx: ClientContext
  preferences: PreferencesStore
}

/** The component the entry mounts: the body behind a boundary, so one throwing card degrades to a
 * readable, retryable error instead of a blank conversation view. */
export function ContextView(props: ContextViewProps): ReactElement {
  const Boundary = makeErrorBoundary(props.t)
  return h(Boundary, null, h(ContextBody, props))
}

/** Fold consecutive same-turn rows into one bar (turn granularity). */
export function aggregateByTurn(rows: readonly RequestRow[]): RequestRow[] {
  const out: RequestRow[] = []
  for (const row of rows) {
    const previous = out.at(-1)
    if (previous !== undefined && (previous.turn ?? 0) === (row.turn ?? 0)) {
      previous.stepCount = (previous.stepCount ?? 1) + 1
      previous.total += row.total
      previous.system += row.system
      previous.tools += row.tools
      previous.user += row.user
      previous.inject += row.inject
      previous.skill = (previous.skill ?? 0) + (row.skill ?? 0)
      previous.assistant += row.assistant
      previous.tool += row.tool
      if (row.output !== undefined) previous.output = (previous.output ?? 0) + row.output
      if (row.cacheRead !== undefined) previous.cacheRead = (previous.cacheRead ?? 0) + row.cacheRead
      continue
    }
    out.push({ ...row, stepCount: 1 })
  }
  return out
}

/** Index of the row carrying a seq, or -1. */
function indexOfSeq(rows: readonly RequestRow[], seq: number): number {
  for (let index = 0; index < rows.length; index++) if (rows[index].seq === seq) return index
  return -1
}

/** The view body. */
function ContextBody(props: ContextViewProps): ReactElement {
  const { t, preferences, host } = props
  const timeline = useTimelineSource({ sessionId: props.sessionId, useProjection: props.useProjection })
  const headers = headerEpochsOf(props)
  const [granularity, setGranularity] = useState<'step' | 'turn'>(
    preferences.get().defaultGranularity === 'turn' ? 'turn' : 'step',
  )
  const [mode, setMode] = useState<'total' | 'delta'>(preferences.get().defaultTrendMode === 'delta' ? 'delta' : 'total')
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
  const [hoverSeq, setHoverSeq] = useState<number | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const sidebar = host === 'sidebar'
  const head = timeline.data

  // The chat→context jump consumes its pending seq only once the detail collections have landed: a
  // scroll target that is not rendered yet would scroll to nothing.
  const ready = timeline.detailState === 'ready' || timeline.detailState === 'legacy'
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const pending = sessionId === '' ? null : takeContextFocus(sessionId)
  const target = pending !== null && head !== null ? head.requests.find(row => row.seq === pending) : undefined
  if (target !== undefined) {
    setGranularity('turn')
    setSelectedSeq(target.seq)
    if (root.current !== null) {
      const anchor = root.current.querySelector('[data-cb-current]')
      const scroller = root.current.closest('[data-conversation-scroll]')
      if (anchor !== null && scroller instanceof HTMLElement) {
        scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      }
    }
  }

  if (head === null) {
    const failed = timeline.detailState === 'failed'
    return h('div', { className: 'cb-root', ref: root },
      failed
        ? h('div', { className: 'cb-error' },
          h('div', { className: 'cb-error-msg' }, t('detail.loadFailed')),
          h('button', { type: 'button', className: 'cb-error-retry', onClick: () => { timeline.retryDetail() } }, t('error.retry')))
        : h('div', { className: 'cb-empty' }, t('loading')))
  }

  const headline = headlineOf(head, null, null)
  const displayed = granularity === 'turn' ? aggregateByTurn(head.requests) : head.requests
  const activeIndex = hoverSeq !== null ? indexOfSeq(displayed, hoverSeq) : selectedSeq !== null ? indexOfSeq(displayed, selectedSeq) : displayed.length - 1
  const activeRow = activeIndex >= 0 ? displayed[activeIndex] : null

  return h('div', { className: 'cb-root', ref: root },
    sidebar ? null : h(CompositionSection, { t, headline, subtitle: [head.model, head.provider].filter(Boolean).join(' · '), snapshot: head }),
    h(TrendSection, {
      t,
      snapshot: head,
      rows: displayed,
      activeIndex,
      granularity,
      onGranularity: setGranularity,
      mode,
      onMode: setMode,
      onSelect: setSelectedSeq,
      onHover: setHoverSeq,
      ready,
      retry: timeline.retryDetail,
    }),
    h(BrowserCard, { t, data: head, headers, selectedSeq: activeRow?.seq ?? null }),
    h(EventsSection, { t, snapshot: head }),
    h(FilesSection, { t, snapshot: head }),
    h(AgentSection, { t, sessionId, snapshot: head }),
    h(TimingSection, { t, snapshot: head }),
  )
}

/** The stage composition strip plus the occupancy headline. */
function CompositionSection(props: { t: Translate; headline: ReturnType<typeof headlineOf>; subtitle: string; snapshot: Snapshot }): ReactElement {
  const { t, headline, subtitle, snapshot } = props
  const window = headline.window
  const parts = headline.parts
  return h('div', { className: 'cb-card', 'data-cb-current': '1' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('overview.title')),
      h('span', { className: 'cb-card-sub' }, t('overview.estimate'))),
    subtitle !== '' ? h('div', { className: 'cb-card-sub' }, subtitle) : null,
    h('div', { className: 'cb-comp-flow' },
      parts.map(part => h('span', {
        key: part.key,
        className: `cb-comp-seg cb-comp-${part.key}`,
        style: { flexGrow: String(Math.max(part.value, 0.0001)), background: part.color },
        title: `${stageLabel(t, part.key)}: ${formatCount(part.value)}`,
      }, part.value / Math.max(1, headline.tokens) >= 0.08 ? stageLabel(t, part.key) : ''))),
    h('div', { className: 'cb-comp-legend' },
      parts.map(part => h('span', { key: part.key, className: 'cb-comp-legend-item' },
        h('span', { className: 'cb-comp-dot', style: { background: part.color } }),
        h('span', { className: 'cb-comp-legend-label' }, stageLabel(t, part.key)),
        h('span', { className: 'cb-comp-legend-value' }, formatCount(part.value)),
        h('span', { className: 'cb-comp-legend-share' }, formatShare(part.value, headline.tokens))))),
    headline.pct !== null
      ? h('div', { className: 'cb-comp-occupancy' },
        h('span', { className: 'cb-comp-pct' }, `${headline.pct}%`),
        h('span', { className: 'cb-card-sub' }, `${t('overview.used')} · ${formatCount(window ?? 0)}`))
      : null,
    snapshot.unsupported !== undefined
      ? h('div', { className: 'cb-gate' },
        h('div', { className: 'cb-gate-title' }, t('gate.title')),
        h('div', { className: 'cb-card-sub' }, t('gate.body', { current: snapshot.unsupported.current, minimum: snapshot.unsupported.minimum })))
      : null,
  )
}

/** The trend bars: one bar per step or turn, total or delta, with the selected bar's detail. */
function TrendSection(props: {
  t: Translate
  snapshot: Snapshot
  rows: readonly RequestRow[]
  activeIndex: number
  granularity: 'step' | 'turn'
  onGranularity: (value: 'step' | 'turn') => void
  mode: 'total' | 'delta'
  onMode: (value: 'total' | 'delta') => void
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  ready: boolean
  retry: () => void
}): ReactElement {
  const { t, rows, activeIndex, granularity, onGranularity, mode, onMode, onSelect, onHover } = props
  const active = activeIndex >= 0 ? rows[activeIndex] : null
  const values = mode === 'delta' ? deltasOf(rows) : rows.map(row => row.total)
  const peak = Math.max(1, ...values)
  if (rows.length === 0) {
    return h('div', { className: 'cb-card' },
      h('div', { className: 'cb-card-title' }, h('span', { className: 'cb-card-title-text' }, t('trend.title'))),
      h('div', { className: 'cb-empty' }, props.ready ? t('trend.empty') : t('loading')))
  }
  return h('div', { className: 'cb-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('trend.title')),
      h('span', { className: 'cb-gran', role: 'group', 'aria-label': t('gran.modeHint') },
        granButton(t('gran.step'), granularity === 'step', () => { onGranularity('step') }),
        granButton(t('gran.turn'), granularity === 'turn', () => { onGranularity('turn') }),
        granButton(t('gran.total'), mode === 'total', () => { onMode('total') }),
        granButton(t('gran.delta'), mode === 'delta', () => { onMode('delta') }))),
    h('div', { className: 'cb-trend' },
      rows.map((row, index) => {
        const height = Math.max(2, Math.round((values[index] / peak) * 100))
        const hovered = index === activeIndex
        return h('button', {
          key: `${row.seq}-${index}`,
          type: 'button',
          className: `cb-trend-bar${hovered ? ' cb-trend-bar-on' : ''}${props.snapshot.requests[0] !== undefined && row.seq === props.snapshot.requests[0].seq ? ' cb-trend-bar-first' : ''}`,
          style: { height: `${height}%` },
          title: `${row.turn !== undefined ? `T${row.turn}` : ''}${row.step !== undefined ? ` · S${row.step}` : ''} · ${formatCount(row.total)}`,
          onMouseEnter: () => { onHover(row.seq) },
          onMouseLeave: () => { onHover(null) },
          onClick: () => { onSelect(active?.seq === row.seq ? null : row.seq) },
        })
      })),
    active !== null
      ? h('div', { className: 'cb-trend-detail' },
        h('div', { className: 'cb-trend-detail-row' },
          h('span', { className: 'cb-card-sub' }, granularity === 'turn' ? t('detail.turn', { t: active.turn ?? 0, n: active.stepCount ?? 1 }) : t('detail.step', { t: active.turn ?? 0, s: active.step ?? 0, n: 0 })),
          h('span', { className: 'cb-trend-detail-total' }, formatCount(active.total))),
        h('div', { className: 'cb-kv-grid' },
          kv(t('cat.system'), formatCount(active.system)),
          kv(t('cat.tools'), formatCount(active.tools)),
          kv(t('cat.user'), formatCount(active.user)),
          kv(t('cat.inject'), formatCount(active.inject)),
          kv(t('cat.skill'), formatCount(active.skill ?? 0)),
          kv(t('cat.assistant'), formatCount(active.assistant)),
          kv(t('cat.tool'), formatCount(active.tool)),
          kv(t('stats.cacheHit'), active.cacheRead !== undefined && active.prompt !== undefined && active.prompt > 0 ? `${Math.round((active.cacheRead / active.prompt) * 100)}%` : '—'),
          kv(t('tokens.output'), active.output !== undefined ? formatCount(active.output) : '—'),
          kv(t('timing.total'), active.activeMs !== undefined ? formatDuration(active.activeMs) : '—')))
      : null)
}

/** A single delta-mode bar value: the signed change against the previous bar. */
function deltasOf(rows: readonly RequestRow[]): number[] {
  return rows.map((row, index) => (index === 0 ? row.total : row.total - rows[index - 1].total))
}

function granButton(label: string, on: boolean, onClick: () => void): ReactElement {
  return h('button', { type: 'button', className: `cb-gran-btn${on ? ' cb-gran-on' : ''}`, 'aria-pressed': on, onClick }, label)
}

function kv(key: string, value: string): ReactElement {
  return h('div', { key, className: 'cb-kv' },
    h('span', { className: 'cb-kv-key' }, key),
    h('span', { className: 'cb-kv-value' }, value))
}

/** The persistent-event list, with one toggle per kind. */
function EventsSection(props: { t: Translate; snapshot: Snapshot }): ReactElement {
  const { t, snapshot } = props
  const kinds = ['inject', 'compaction', 'prune', 'model', 'mode'] as const
  const [picked, setPicked] = useState<readonly string[]>(kinds)
  const toggle = (kind: string): void => {
    setPicked((current) => {
      if (current.length === kinds.length) return [kind]
      if (!current.includes(kind)) return [...current, kind]
      if (current.length === 1) return [...kinds]
      return current.filter(entry => entry !== kind)
    })
  }
  const events = picked.length === kinds.length
    ? snapshot.events
    : snapshot.events.filter(event => picked.includes(event.kind))
  return h('div', { className: 'cb-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('events.title')),
      h('span', { className: 'cb-gran', role: 'group' },
        kinds.map(kind => granButton(t(`kind.${kind}`), picked.includes(kind), () => { toggle(kind) })))),
    events.length === 0
      ? h('div', { className: 'cb-empty' }, t('events.empty'))
      : h('ul', { className: 'cb-events' }, [...events].reverse().map(event => h('li', { key: event.seq, className: 'cb-event-row' },
        h('span', { className: 'cb-event-kind' }, t(`kind.${event.kind}`)),
        h('span', { className: 'cb-event-time' }, formatClock(event.time)),
        h('span', { className: 'cb-event-detail' }, eventDetail(event, t)),
        h('span', { className: 'cb-event-tokens' }, event.tokens !== undefined ? formatCount(event.tokens) : '')))))
}

function eventDetail(event: Snapshot['events'][number], t: Translate): string {
  if (event.kind === 'model') return `${event.from ?? '?'} → ${event.to ?? '?'}`
  if (event.kind === 'mode') return event.name === 'plan.on' ? t('ev.mode.plan.on') : t('ev.mode.plan.off')
  if (event.kind === 'inject') return event.sub === 'skill' ? `${t('ev.skill')}: ${event.name ?? ''}` : (event.name ?? t('ev.compaction'))
  return event.kind === 'prune' ? t('ev.prune') : t('ev.compaction')
}

/** The file-activity list. */
function FilesSection(props: { t: Translate; snapshot: Snapshot }): ReactElement {
  const { t, snapshot } = props
  const ops = snapshot.fileOps ?? []
  return h('div', { className: 'cb-card' },
    h('div', { className: 'cb-card-title' }, h('span', { className: 'cb-card-title-text' }, t('files.title'))),
    ops.length === 0
      ? h('div', { className: 'cb-empty' }, t('files.empty'))
      : h('ul', { className: 'cb-files' }, [...ops].reverse().slice(0, 40).map(op => h('li', { key: `${op.seq}-${op.path}`, className: 'cb-file-row' },
        h('span', { className: `cb-file-kind cb-file-${op.kind}` }, t(`files.kind.${op.kind}`)),
        h('span', { className: 'cb-file-path', title: op.path }, op.pattern === true ? op.path : op.path),
        h('span', { className: 'cb-file-tool' }, op.tool),
        op.added > 0 || op.removed > 0
          ? h('span', { className: 'cb-file-delta' }, `+${op.added} −${op.removed}`)
          : null,
        op.err ? h('span', { className: 'cb-file-err' }, '!') : null))))
}

/** The agent network: this session and its relatives, with billed tokens per node. */
function AgentSection(props: { t: Translate; sessionId: string; snapshot: Snapshot }): ReactElement {
  const { t, sessionId, snapshot } = props
  const billed = snapshot.cost !== undefined ? tokenTotalOf(snapshot) : null
  return h('div', { className: 'cb-card cb-agent-card' },
    h('div', { className: 'cb-card-title' }, h('span', { className: 'cb-card-title-text' }, t('agents.title'))),
    h('div', { className: 'cb-agent-self' },
      h('span', { className: 'cb-agent-node cb-agent-current' },
        h('span', { className: 'cb-agent-name' }, t('stats.currentAgent')),
        h('span', { className: 'cb-agent-tokens' }, billed !== null ? formatCount(billed) : '—'),
        h('span', { className: 'cb-agent-sub' }, formatCount(snapshot.requests.length)))),
    h('div', { className: 'cb-agent-note' }, sessionId))
}

/** Total billed tokens of a snapshot's own ledger. */
function tokenTotalOf(snapshot: Snapshot): number {
  let total = 0
  for (const models of Object.values(snapshot.cost ?? {})) {
    for (const entry of Object.values(models)) {
      if (entry.peak !== undefined) total += entry.peak.uncached + entry.peak.cacheRead + entry.peak.cacheWrite + entry.peak.output
      if (entry.off !== undefined) total += entry.off.uncached + entry.off.cacheRead + entry.off.cacheWrite + entry.off.output
    }
  }
  return total
}

/** The session timing strip and totals. */
function TimingSection(props: { t: Translate; snapshot: Snapshot }): ReactElement {
  const { t, snapshot } = props
  const timing = snapshot.timing
  if (timing === undefined) return h('div', { className: 'cb-card' }, h('div', { className: 'cb-card-title' }, h('span', { className: 'cb-card-title-text' }, t('timing.title'))), h('div', { className: 'cb-empty' }, t('timing.empty')))
  const spans = snapshot.spans ?? []
  const from = spans.length > 0 ? spans[0].start : 0
  const to = spans.length > 0 ? spans[spans.length - 1].end : 0
  const width = Math.max(1, to - from)
  return h('div', { className: 'cb-card' },
    h('div', { className: 'cb-card-title' }, h('span', { className: 'cb-card-title-text' }, t('timing.title'))),
    h('div', { className: 'cb-timing-strip' }, spans.map((span, index) => h('span', {
      key: index,
      className: `cb-timing-seg cb-timing-${span.kind}`,
      style: { left: `${((span.start - from) / width) * 100}%`, width: `${((span.end - span.start) / width) * 100}%` },
      title: `${span.kind}: ${formatDuration(span.end - span.start)}`,
    }))),
    h('div', { className: 'cb-kv-grid' },
      kv(t('timing.total'), formatDuration(timing.wallMs)),
      kv(t('timing.ttft'), formatDuration(timing.ttftMs)),
      kv(t('timing.gen'), formatDuration(timing.genMs)),
      kv(t('timing.tools'), formatDuration(timing.toolsMs)),
      kv(t('stats.toolCalls'), formatCount(timing.toolCalls)),
      kv(t('stats.answers'), formatCount(snapshot.answers ?? 0))))
}
