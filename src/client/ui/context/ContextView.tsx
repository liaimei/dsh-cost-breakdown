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

import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { ClientContext, ContextSeatProps } from '../../shell/contracts'
import { headerEpochsOf } from '../../shell/contracts'
import type { Translate } from '../../i18n/dict'
import type { PreferencesStore } from '../../shell/preferences'
import { useTimelineSource } from '../../data/timeline'
import { formatClock, formatCount, formatDuration, formatShare } from '../../i18n/format'
import { headlineOf, STAGES, stageLabel, STAGE_COLOR } from './derive'
import { TrendChart } from './TrendChart'
import { attachMarkers, assemble } from './assemble'
import { trendBandsOf } from './dna'
import type { TrendBand } from './dna'
import { takeContextFocus } from './jump'
import { makeErrorBoundary } from './ErrorBoundary'
import { BrowserCard } from './Browser'
import { AgentNetwork } from './AgentNetwork'
import { openSessionWith, serviceOf, type SessionsFace } from '../../shell/contracts'
import type { HeaderTimeline, RequestRow, Snapshot } from '../../../wire/model'

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
  // In-chart toggles stay mount-local: they change how this reader looks at the data, not a persisted
  // preference, and writing them back would surprise the next session.
  const [dna, setDna] = useState(false)
  const [adaptive, setAdaptive] = useState(true)
  const [durationCurve, setDurationCurve] = useState(preferences.get().defaultDurationCurve !== 'hide')
  const [hoverBand, setHoverBand] = useState<string | null>(null)
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
      granularity,
      onGranularity: setGranularity,
      mode,
      onMode: setMode,
      dna,
      onDna: setDna,
      adaptive,
      onAdaptive: setAdaptive,
      durationCurve,
      onDurationCurve: setDurationCurve,
      selectedSeq,
      hoverSeq,
      hoverBand,
      onBandHover: setHoverBand,
      onSelect: setSelectedSeq,
      onHover: setHoverSeq,
      ready,
      retry: timeline.retryDetail,
      headers,
    }),
    h(BrowserCard, { t, data: head, headers, selectedSeq: activeRow?.seq ?? null, sessionId }),
    h(EventsSection, { t, snapshot: head }),
    h(FilesSection, { t, snapshot: head }),
    h(AgentNetworkBridge, { t, ctx: props.ctx, sessionId, snapshot: head, now: Date.now() }),
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

/**
 * The trend card: the chart plus its toolbar.
 *
 * Three independent toggles, matching the three questions a reader can ask of the same history:
 *   - **DNA** — decompose each bar into its items instead of its stages, so a specific message or tool schema
 *     can be followed across steps;
 *   - **adaptive** — narrow the window around the active bar once the history outgrows a readable column;
 *   - **duration** — overlay each step's active time, which answers "where did the wall clock go" rather than
 *     "what filled the context".
 *
 * The granularity and mode groups sit beside them; all five are mount-local, so nothing here writes a
 * preference.
 */
function TrendSection(props: {
  t: Translate
  snapshot: Snapshot
  rows: readonly RequestRow[]
  granularity: 'step' | 'turn'
  onGranularity: (value: 'step' | 'turn') => void
  mode: 'total' | 'delta'
  onMode: (value: 'total' | 'delta') => void
  dna: boolean
  onDna: (value: boolean) => void
  adaptive: boolean
  onAdaptive: (value: boolean) => void
  durationCurve: boolean
  onDurationCurve: (value: boolean) => void
  selectedSeq: number | null
  hoverSeq: number | null
  hoverBand: string | null
  onBandHover: (key: string | null) => void
  onSelect: (seq: number | null) => void
  onHover: (seq: number | null) => void
  ready: boolean
  retry: () => void
  headers: HeaderTimeline | null
}): ReactElement {
  const { t, snapshot, rows, granularity, mode, dna, adaptive, durationCurve } = props
  const [legend, setLegend] = useState<string | null>(null)

  // Markers attach to the first request recorded after each boundary event, so the chart and the detail
  // panel name the same event.
  const markers = useMemo(() => attachMarkers(snapshot.requests, snapshot.events), [snapshot.requests, snapshot.events])

  // DNA bands, one list per bar: rebuild the context as it stood at that dispatch and decompose it in read
  // order. Only computed when the mode is on — it is the expensive path.
  const dnaBands = useMemo<readonly TrendBand[][] | null>(() => {
    if (!dna || granularity !== 'step') return null
    const colorOf = (cat: string): string => (STAGE_COLOR as Record<string, string>)[cat] ?? 'var(--cb-ctx-slate)'
    return snapshot.requests.map(row => trendBandsOf(assemble(snapshot, props.headers, row.seq), colorOf))
  }, [dna, granularity, snapshot, props.headers])

  if (rows.length === 0) {
    return h('div', { className: 'cb-card' },
      h('div', { className: 'cb-card-title' }, h('span', { className: 'cb-card-title-text' }, t('trend.title'))),
      h('div', { className: 'cb-empty' }, props.ready ? t('trend.empty') : t('loading')))
  }

  return h('div', { className: 'cb-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('trend.title')),
      h('div', { className: 'cb-trend-ctl' },
        h('div', { className: 'cb-gran', role: 'group' },
          toggle(t, t('trend.dna'), t('trend.dnaTip'), dna, () => { props.onDna(!dna) }),
          toggle(t, t('trend.adaptive'), t('trend.adaptiveHint'), adaptive, () => { props.onAdaptive(!adaptive) }),
          toggle(t, t('trend.duration'), t('trend.durationTip'), durationCurve, () => { props.onDurationCurve(!durationCurve) })),
        h('div', { className: 'cb-gran', role: 'group', 'aria-label': t('gran.modeHint') },
          segment(t, t('gran.step'), granularity === 'step', () => { props.onGranularity('step') }),
          segment(t, t('gran.turn'), granularity === 'turn', () => { props.onGranularity('turn') }),
          segment(t, t('gran.total'), mode === 'total', () => { props.onMode('total') }),
          segment(t, t('gran.delta'), mode === 'delta', () => { props.onMode('delta') })))),
    h(TrendChart, {
      t,
      rows,
      markers,
      granularity,
      mode,
      selectedSeq: props.selectedSeq,
      hoveredSeq: props.hoverSeq,
      focusTurn: null,
      dna: dnaBands,
      hoverBand: props.hoverBand,
      onSelect: props.onSelect,
      onHover: props.onHover,
      onHoverBand: props.onBandHover,
      durationCurve,
      adaptive,
      spans: snapshot.spans,
    }),
    // The stage legend doubles as a hover filter for the stacked bars: pointing at a stage highlights that
    // band in every drawn bar, which is how a reader follows one series across the window.
    dna
      ? null
      : h('div', { className: 'cb-trend-legend' }, STAGES.map(stage => h('span', {
        key: stage,
        className: `cb-trend-legend-item${legend === stage ? ' cb-trend-legend-on' : ''}`,
        onMouseEnter: () => { setLegend(stage); props.onBandHover(stage) },
        onMouseLeave: () => { setLegend(null); props.onBandHover(null) },
      },
        h('span', { className: 'cb-trend-legend-dot', style: { background: STAGE_COLOR[stage] } }),
        h('span', null, stageLabel(t, stage))))),
  )
}

/** A toolbar toggle with its tooltip. */
function toggle(t: Translate, label: string, tip: string, on: boolean, onClick: () => void): ReactElement {
  return h('button', {
    type: 'button',
    className: `cb-gran-btn${on ? ' cb-gran-on' : ''}`,
    'aria-pressed': on,
    title: tip,
    onClick,
  }, label)
}

/** A segmented-control button. */
function segment(t: Translate, label: string, on: boolean, onClick: () => void): ReactElement {
  void t
  return h('button', {
    type: 'button',
    className: `cb-gran-btn${on ? ' cb-gran-on' : ''}`,
    'aria-pressed': on,
    onClick,
  }, label)
}

/** One key/value cell, shared by the request detail and the timing totals. */
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
        kinds.map(kind => segment(t, t(`kind.${kind}`), picked.includes(kind), () => { toggle(kind) })))),
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

/**
 * The agent network, wired to the session-list snapshot.
 *
 * The card itself is pure; this bridge supplies the two things it cannot derive: the session-list snapshot
 * (which carries the relatives) and the verb that opens one. Reading the list is the one place this view
 * touches a service, so it is isolated here rather than threaded through the card.
 */
function AgentNetworkBridge(props: {
  t: Translate
  ctx: ClientContext
  sessionId: string
  snapshot: Snapshot
  now: number
}): ReactElement {
  const { t, ctx, sessionId, snapshot, now } = props
  const [sessions, setSessions] = useState<unknown>(undefined)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const face = serviceOf<SessionsFace>(ctx, 'sessions')
    const list = face?.list
    if (list === undefined) return
    const update = (): void => {
      try {
        setSessions(list.getSnapshot())
      } catch {
        // A hostile list degrades the card to its single-node form rather than failing the surface.
        setSessions(undefined)
      }
    }
    update()
    const unsubscribe = list.subscribe?.(update)
    // Opening a sub-agent that has not materialised yet is the card's job: refreshing the baseline once on
    // mount is what makes a relative appear without a manual reload.
    void face?.refresh?.().catch(() => {})
    return unsubscribe
  }, [ctx])

  // The card is expensive to lay out, so it only mounts once the reader asks for it.
  if (!expanded) {
    return h('div', { className: 'cb-card cb-agent-card' },
      h('div', { className: 'cb-card-title' },
        h('span', { className: 'cb-card-title-text' }, t('agents.title')),
        h('span', { className: 'cb-card-sub' }, t('agents.sub'))),
      h('button', {
        type: 'button',
        className: 'cb-agent-expand',
        onClick: () => { setExpanded(true) },
      }, t('agents.self')))
  }
  return h(AgentNetwork, {
    t,
    sessionId,
    snapshot,
    sessions,
    now,
    onOpen: (id: string) => { openSessionWith(ctx, id) },
  })
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
