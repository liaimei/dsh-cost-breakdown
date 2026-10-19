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
import { formatCount, formatShare } from '../../i18n/format'
import { headlineOf, STAGES, stageLabel, STAGE_COLOR } from './derive'
import { TrendChart } from './TrendChart'
import { attachMarkers, assemble } from './assemble'
import { trendBandsOf } from './dna'
import type { TrendBand } from './dna'
import { takeContextFocus } from './jump'
import { subagentCostOf } from './agents'
import { platformSpendsOf } from '../../data/platformSpend'
import { formatCredits, formatNativeSpend } from '../../data/cost'
import { moneyRates } from '../../shell/rateTables'
import { creditRates } from '../../shell/rateTables'
import { makeErrorBoundary } from './ErrorBoundary'
import { BrowserCard } from './Browser'
import { AgentNetwork } from './AgentNetwork'
import { OverviewCard, PluginCard, TimingCard, TokensCard } from './HeaderCards'
import { EventsCard } from './Events'
import { buildInfo } from './buildInfo'
import { FilesCard } from './Files'
import {
  canOpenPaths, openPathWith, openSessionWith, resourceOpenerOf, serviceOf, workspaceOf,
  type SessionsFace,
} from '../../shell/contracts'
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

/**
 * The right-sidebar summary: two sections, in the order the column's question deserves — the session's token
 * totals first, then what each platform charged.
 *
 * Money appears here (and on the statistics page) and nowhere else on this surface: the conversation tab is
 * token-only, so the two quantities never share a page.
 */
function SidebarSummary(props: {
  t: Translate
  ctx: ClientContext
  snapshot: Snapshot
  sessionId: string
}): ReactElement {
  const { t, snapshot } = props
  const rows = useMemo(() => {
    const ledger = snapshot.cost ?? null
    const calls = snapshot.calls ?? null
    return platformSpendsOf(ledger, calls, null, moneyRates(), snapshot.creditRates ?? creditRates())
  }, [snapshot])
  return h('div', { className: 'cb-sidebar-summary' },
    h('div', { className: 'cb-card' },
      h('div', { className: 'cb-card-title' },
        h('span', { className: 'cb-card-title-text' }, t('sidebar.title')),
        h('span', { className: 'cb-card-sub' }, t('sidebar.tokensSub'))),
      h('div', { className: 'cb-sidebar-tokens' }, STAGES.map(stage => h('div', {
        key: stage,
        className: 'cb-sidebar-token-row',
      },
        h('span', { className: 'cb-sidebar-token-dot', style: { background: STAGE_COLOR[stage] } }),
        h('span', { className: 'cb-sidebar-token-label' }, stageLabel(t, stage)),
        h('b', { className: 'cb-sidebar-token-value' }, formatCount(snapshot.current[stage]))))),
      h('div', { className: 'cb-sidebar-total' },
        h('span', { className: 'cb-card-sub' }, t('tokens.total')),
        h('b', null, formatCount(snapshot.current.total)))),
    h('div', { className: 'cb-card' },
      h('div', { className: 'cb-card-title' },
        h('span', { className: 'cb-card-title-text' }, t('spend.title')),
        h('span', { className: 'cb-card-sub' }, t('spend.sub'))),
      rows.length === 0
        ? h('div', { className: 'cb-empty' }, t('spend.empty'))
        : h('div', { className: 'cb-sidebar-platforms' }, rows.map(row => h('div', { key: row.provider, className: 'cb-sidebar-platform' },
          h('span', { className: 'cb-sidebar-platform-name' }, row.provider),
          h('b', null, row.unit === 'credits'
            ? t('dock.creditsSpent', { n: formatCredits(row.value) })
            : formatNativeSpend(row.value, row.currency ?? 'USD')),
          h('span', { className: 'cb-card-sub' }, t('costStat.calls', { n: formatCount(row.calls) })))))),
    h('div', { className: 'cb-sidebar-note' }, t('dock.note'))
  )
}

/**
 * The session-list snapshot, subscribed so the agent family follows it.
 *
 * The list is the only service this surface reads, and a sub-agent appears in it after it is spawned — so a
 * one-shot read would leave the family stale until a reload.
 */
function useSessionsSnapshot(ctx: ClientContext): unknown {
  const [snapshot, setSnapshot] = useState<unknown>(undefined)
  useEffect(() => {
    const face = serviceOf<SessionsFace>(ctx, 'sessions')
    const list = face?.list
    if (list === undefined) return
    const update = (): void => {
      try {
        setSnapshot(list.getSnapshot())
      } catch {
        setSnapshot(undefined)
      }
    }
    update()
    return list.subscribe?.(update)
  }, [ctx])
  return snapshot
}

/** The billed tokens of a ledger (or of nothing). */
function billedOf(ledger: { [provider: string]: { [model: string]: { peak?: { uncached: number; cacheRead: number; cacheWrite: number; output: number }; off?: { uncached: number; cacheRead: number; cacheWrite: number; output: number } } } } | null): number {
  let total = 0
  for (const models of Object.values(ledger ?? {})) {
    for (const entry of Object.values(models)) {
      if (entry.peak !== undefined) total += entry.peak.uncached + entry.peak.cacheRead + entry.peak.cacheWrite + entry.peak.output
      if (entry.off !== undefined) total += entry.off.uncached + entry.off.cacheRead + entry.off.cacheWrite + entry.off.output
    }
  }
  return total
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
  // A category the browser should open (driven by the overview card's clickable figures and the file card's
  // locate action). Consumed once, so a later manual toggle is not overridden.
  const [browserCategory, setBrowserCategory] = useState<string | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const sidebar = host === 'sidebar'
  const head = timeline.data
  const workspace = workspaceOf(props.ctx, props.sessionId)
  const sessionsSnapshot = useSessionsSnapshot(props.ctx)
  const [opener, setOpener] = useState<((path: string) => void) | undefined>(undefined)
  const [previewer, setPreviewer] = useState<((path: string) => boolean) | undefined>(undefined)

  // The two file actions depend on the deployment, not on the data: opening needs a loopback session whose
  // controller claims the verb, previewing needs the resource tab. Probing once is enough.
  useEffect(() => {
    let live = true
    void canOpenPaths(props.ctx).then((allowed) => {
      if (!live) return
      setOpener(allowed ? openPathWith(props.ctx) : undefined)
      const resource = resourceOpenerOf(props.ctx)
      if (resource === undefined) return
      // The preview address is session-scoped; the harness's own encoder builds it, so a path it rejects simply
      // is not previewable.
      setPreviewer(() => (path: string) => {
        try {
          return resource(`dsh-resource://file/${encodeURIComponent(path)}`)
        } catch {
          return false
        }
      })
    })
    return () => { live = false }
  }, [props.ctx])

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

  // The tools tally of the live surface, for the overview card's ranked list.
  const tools = useMemo(() => {
    const tally = new Map<string, number>()
    for (const node of head.nodes) {
      if (node.cat !== 'tool' && !(node.cat === 'skill' && node.tool !== undefined)) continue
      if (typeof node.tool !== 'string' || node.tool === '') continue
      tally.set(node.tool, (tally.get(node.tool) ?? 0) + 1)
    }
    return [...tally].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])) as Array<readonly [string, number]>
  }, [head.nodes])
  const family = useMemo(() => subagentCostOf(sessionsSnapshot, sessionId), [sessionsSnapshot, sessionId])
  const familyTokens = family.ledger === null && head.cost === undefined
    ? null
    : billedOf(family.ledger) + billedOf(head.cost ?? null)

  // The file scope: the active step's cut, so the file list and the browser describe the same moment.
  const filesBefore = activeRow === null || activeIndex === displayed.length - 1
    ? null
    : head.requests.find(row => row.seq > activeRow.seq)?.seq ?? null

  // The sidebar seat answers one question — this session's summary — in two sections: tokens, then spend.
  // The whole context stack (composition, trend, browser, events, files, agent network) stays on the
  // conversation tab: that column is narrow, and stacking the analysis tools into it makes both unreadable.
  if (sidebar) {
    return h('div', { className: 'cb-root', ref: root },
      h(SidebarSummary, { t, ctx: props.ctx, snapshot: head, sessionId }),
      head.unsupported !== undefined
        ? h('div', { className: 'cb-gate-card' },
          h('div', { className: 'cb-gate-title' }, t('gate.title')),
          h('div', { className: 'cb-gate-body' }, t('gate.body', { current: head.unsupported.current, minimum: head.unsupported.minimum })))
        : null)
  }

  return h('div', { className: 'cb-root', ref: root },
    // Band 1: the overview and the plugin's identity, side by side.
    h('div', { className: 'cb-cols cb-head' },
      h(OverviewCard, {
        t,
        snapshot: head,
        familyTokens,
        familyCount: family.count,
        tools,
        onFigureClick: (kind: 'skills' | 'answers') => { setBrowserCategory(kind === 'answers' ? 'tool' : 'skill') },
      }),
      h(PluginCard, { t, version: buildInfo().version, repo: buildInfo().repo })),
    // Band 2: the token ring and the timing ring.
    h('div', { className: 'cb-cols cb-head' },
      h(TokensCard, { t, snapshot: head }),
      h(TimingCard, { t, snapshot: head })),
    // Band 3: composition and trend on the left, the browser on the right.
    h('div', { className: 'cb-cols cb-cols-main' },
      h('div', { className: 'cb-col cb-col-left' },
        h(CompositionSection, { t, headline, subtitle: [head.model, head.provider].filter(Boolean).join(' · '), snapshot: head }),
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
        })),
      h('div', { className: 'cb-col cb-col-browser' },
        h(BrowserCard, {
          t,
          data: head,
          headers,
          selectedSeq: activeRow?.seq ?? null,
          sessionId,
          ...(browserCategory !== null ? { openCategory: browserCategory } : {}),
        }))),
    // Band 4: the persistent events and the file activity, side by side as an even two-column grid.
    h('div', { className: 'cb-cols-pair' },
      h(EventsCard, {
        t,
        snapshot: head,
        state: timeline.detailState,
        onRetry: timeline.retryDetail,
      }),
      h(FilesCard, {
        t,
        fileOps: head.fileOps,
        ...(head.fileOpsFloor !== undefined ? { floor: head.fileOpsFloor } : {}),
        before: filesBefore,
        ...(workspace !== undefined ? { workspace } : {}),
        onPreview: (path: string) => previewer?.(path) ?? false,
        ...(opener !== undefined ? { onOpen: opener } : {}),
        onLocate: () => { setBrowserCategory('tool') },
      })),
    // Band 5: the agent network.
    h(AgentNetworkBridge, { t, ctx: props.ctx, sessionId, snapshot: head, now: Date.now() }),
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
  const sessions = useSessionsSnapshot(ctx)

  // Opening a sub-agent that has not materialised yet is this card's job: refreshing the baseline once per
  // session is what makes a relative appear without a manual reload.
  useEffect(() => {
    const face = serviceOf<SessionsFace>(ctx, 'sessions')
    void face?.refresh?.().catch(() => {})
  }, [ctx, sessionId])

  return h(AgentNetwork, {
    t,
    sessionId,
    snapshot,
    sessions,
    now,
    onOpen: (id: string) => { openSessionWith(ctx, id) },
  })
}
