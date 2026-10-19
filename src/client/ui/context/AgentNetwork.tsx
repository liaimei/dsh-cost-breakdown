/**
 * The agent network card.
 *
 * It answers "who is working with me, and how much context is each of them carrying?" — a question the
 * session list cannot answer, because a sub-agent's row exists before anyone opens it and it is the parent's
 * page that needs to show it.
 *
 * The card is **token-only**: a node prints its occupancy and its billed token total, never a price. Money
 * lives in the right-sidebar summary and the statistics page, and mixing the two on one card would invite the
 * reader to compare them.
 *
 * Layout comes from `agents.ts` (a fixed-height grid, DFS pre-order); this file only draws it. A one-node
 * family drops the edge layer entirely rather than drawing an empty stage.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { Snapshot } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { formatCount } from '../../i18n/format'
import {
  AGENT_CARD_HEIGHT, agentForestOf, barSegmentsOf, formatDurationCompact, layoutForest,
  lineageOf, pressureColorOf, subagentCostOf,
} from './agents'
import type { AgentNode, SelfStats } from './agents'
import { headlineOf, STAGE_COLOR, stageLabel } from './derive'
import { makeDetailFetcher, mergeTimeline } from '../../data/timeline'

/**
 * Inject the fetched heads back into the session-list snapshot as each row's `contextTimeline` projection.
 *
 * The list block only carries projection values from the host's cache, so a relative that has not been mounted
 * since its last timeline change lists pressure alone. A landed head fills that one gap; the row's own value
 * always wins when it has one, because the list may be newer by a few seconds.
 */
function withLandedHeads(sessions: unknown, landed: ReadonlyMap<string, Snapshot>): unknown {
  if (landed.size === 0) return sessions
  if (sessions === null || typeof sessions !== 'object') return sessions
  const byId = (sessions as { byId?: unknown }).byId
  if (byId === null || typeof byId !== 'object') return sessions
  const merged: Record<string, unknown> = {}
  for (const [id, row] of Object.entries(byId as Record<string, unknown>)) {
    const head = landed.get(id)
    if (head === undefined || row === null || typeof row !== 'object') {
      merged[id] = row
      continue
    }
    const projections = (row as { projectionValues?: unknown }).projectionValues
    const values = projections !== null && typeof projections === 'object'
      ? projections as Record<string, unknown>
      : {}
    if (values.contextTimeline !== undefined) {
      merged[id] = row
      continue
    }
    merged[id] = { ...(row as object), projectionValues: { ...values, contextTimeline: head } }
  }
  return { ...(sessions as object), byId: merged }
}

/** The card's props. */
export interface AgentNetworkProps {
  t: Translate
  sessionId: string
  /** The current session's live projection (fresher than its list row). */
  snapshot: Snapshot
  /** The session-list snapshot, which carries the relatives. */
  sessions: unknown
  /** Open a session in the centre column. */
  onOpen: (id: string) => void
  /** Render instant, injected so relative state is deterministic under test. */
  now: number
}

/** The card. */
export function AgentNetwork(props: AgentNetworkProps): ReactElement {
  const { t, sessionId, snapshot, sessions, onOpen } = props
  const stage = useRef<HTMLDivElement | null>(null)
  /** The card frame, which is the width the graph must fit inside. */
  const card = useRef<HTMLDivElement | null>(null)
  /** The card's content width — the stage's own width comes from the layout, so measuring the stage would be
   * circular and would feed the first frame's fallback back into the next layout. */
  const [stageWidth, setStageWidth] = useState(0)
  /** The hovered node; its lineage is the only part of the graph left lit. */
  const [hoverId, setHoverId] = useState<string | null>(null)
  /** Composition heads fetched for relatives the list only carries pressure for, keyed by session id. */
  const [landed, setLanded] = useState<ReadonlyMap<string, Snapshot>>(new Map())

  // The current session's own live figures, which override its (possibly stale) list row.
  const self = useMemo<SelfStats>(() => ({
    // `headlineOf` reads `current`, `contextWindow` and the newest request anchor, which is exactly the
    // occupancy the composition card shows — so a node cannot report a different fullness.
    head: snapshot.requests.length > 0 || snapshot.current.total > 0 ? headlineOf(snapshot) : null,
    billed: snapshot.cost === undefined ? null : billedOf(snapshot),
    requests: snapshot.requests.length,
    ledger: snapshot.cost ?? null,
    durationMs: snapshot.timing?.wallMs ?? null,
  }), [snapshot])

  // The list block serves projection values from the host's cache, so a relative that has not been mounted
  // since its last timeline change only lists pressure — no composition. Its own head comes from the detail
  // route instead, and injecting it back into the row is what re-renders that node with its slices.
  const forest = useMemo(
    () => agentForestOf(withLandedHeads(sessions, landed), sessionId, self),
    [sessions, sessionId, self, landed],
  )
  const team = useMemo(() => subagentCostOf(sessions, sessionId), [sessions, sessionId])

  // Measure the stage so the grid can spread across the card's real width; a measurless environment (jsdom,
  // the first frame) falls back to the widest layout rather than cramming every card into one slot.
  // The card frame is the width reference: it is in the layout flow and its width never depends on this
  // component's own output. Measuring the stage instead was circular, and reading `stage.current` before the
  // ref attached left the measurement at the fallback forever.
  useLayoutEffect(() => {
    const element = card.current
    if (element === null) return
    const measure = (): void => {
      // The card's content box, minus its own padding: that is the room the graph may use.
      const style = getComputedStyle(element)
      const inner = element.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
      setStageWidth(inner > 0 ? inner : element.clientWidth)
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [forest === null])

  // Every relative without a timeline in its row is a fetch target. Firing them after the first layout keeps the
  // card's own render free of network work.
  const cold = forest?.nodes.filter(node => !node.isCurrent && node.head === null && !landed.has(node.id)).map(node => node.id) ?? []
  const coldKey = cold.join(',')
  useEffect(() => {
    if (coldKey === '') return
    let live = true
    for (const id of coldKey.split(',')) {
      const fetch = makeDetailFetcher(id)
      if (fetch === undefined) continue
      void fetch().then((detail) => {
        if (!live || detail === null) return
        // A cold relative's detail is a slim head plus the step collections, so the same merge the timeline
        // store uses turns it into the snapshot the node needs for its composition.
        const head = detail.head
        if (head === undefined) return
        const snapshot = mergeTimeline(head, detail)
        setLanded((previous) => {
          if (previous.get(id) === snapshot) return previous
          return new Map(previous).set(id, snapshot)
        })
      }).catch(() => {})
    }
    return () => { live = false }
  }, [coldKey])

  if (forest === null) {
    return h(Card, { t, team, count: team.count },
      h('div', { className: 'cb-empty' }, t('agents.solo')))
  }

  // Until the first measurement lands (and in a layout-less environment such as jsdom), assume a wide card:
  // the previous 240px floor made a 25-node family stack one card per row, 3,700px tall.
  const layout = layoutForest(forest, stageWidth > 0 ? stageWidth : 900)
  // Hovering a card lights its ancestor chain and its whole subtree; every other link fades to background.
  const lit = hoverId === null ? null : lineageOf(forest, hoverId)
  const litEdges = lit === null ? null : new Set(forest.edges
    .filter(edge => lit.has(edge.from) && lit.has(edge.to))
    .map(edge => `${edge.from}->${edge.to}`))
  const hovered = hoverId === null ? null : forest.nodes.find(node => node.id === hoverId) ?? null
  const current = forest.nodes.find(node => node.isCurrent)
  const running = forest.nodes.filter(node => node.running).length

  return h(Card, {
    frame: card,
    t,
    team,
    count: team.count,
    running,
    total: forest.nodes.length,
    ...(current?.billed !== null && current?.billed !== undefined ? { tokens: current.billed } : {}),
  },
    h('div', {
      ref: stage,
      className: `cb-agent-stage${hoverId !== null ? ' cb-agent-focus' : ''}`,
      style: { height: `${layout.height}px` },
      onMouseLeave: () => { setHoverId(null) },
    },
      h('div', {
        className: 'cb-agent-canvas',
        style: { width: `${layout.width}px`, height: `${layout.height}px` },
      },
      // Edges first: they must sit under the cards.
      forest.solo
        ? null
        : h('svg', { className: 'cb-agent-edges', viewBox: `0 0 ${layout.width} ${layout.height}`, 'aria-hidden': 'true' },
          layout.edges.map(edge => {
            const key = `${edge.from}->${edge.to}`
            const on = litEdges === null || litEdges.has(key)
            return h('path', {
              key,
              className: `cb-agent-edge${on && litEdges !== null ? ' cb-agent-edge-on' : ''}`,
              d: edge.path,
              fill: 'none',
              stroke: on ? 'var(--dsw-alias-label-tertiary)' : 'var(--dsw-alias-border-l2)',
              'stroke-width': 1.5,
              'stroke-dasharray': '2 7',
            })
          })),
      layout.placed.map(entry => h(AgentCard, {
        key: entry.node.id,
        t,
        node: entry.node,
        left: entry.left,
        top: entry.top,
        width: entry.width,
        current: entry.node.isCurrent,
        dim: lit !== null && !lit.has(entry.node.id),
        onHover: setHoverId,
        onOpen,
      })),
      forest.overflow > 0
        ? h('div', { className: 'cb-agent-overflow' }, t('agents.more', { n: formatCount(forest.overflow) }))
        : null)),
    forest.solo ? h('div', { className: 'cb-agent-solo-note' }, t('agents.solo')) : null,
    // The inspector mirrors whichever node the pointer is on: its occupancy, its slices, and the verb that
    // opens it. With nothing hovered it explains the card instead of leaving a hole.
    hovered !== null
      ? h(Inspector, { t, node: hovered, onOpen })
      : h('div', { className: 'cb-agent-solo-note' }, t('agents.hint')),
  )
}

/** The card frame and its header facts. */
function Card(props: {
  /** The card frame, measured by the graph to size its grid. */
  frame?: { current: HTMLDivElement | null }
  t: Translate
  team: { ledger: unknown; count: number }
  count: number
  running?: number
  total?: number
  tokens?: number
  /** Supplied as the third `h()` argument, so it is optional in the props type. */
  children?: ReactElement | ReactElement[] | null
}): ReactElement {
  const { t, count } = props
  return h('div', { className: 'cb-card cb-agent-card', ref: props.frame },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('agents.title')),
      h('span', { className: 'cb-card-sub' }, t('agents.sub')),
      h('div', { className: 'cb-agent-chips' },
        props.running !== undefined ? h('span', { className: 'cb-agent-chip' }, t('agents.chip.running', { n: formatCount(props.running) })) : null,
        (props.total ?? 0) > 1 ? h('span', { className: 'cb-agent-chip' }, t('agents.chip.count', { n: formatCount(props.total ?? 0) })) : null,
        props.tokens !== undefined ? h('span', { className: 'cb-agent-chip' }, t('agents.chip.tokens', { n: formatCount(props.tokens) })) : null,
        count > 0 ? h('span', { className: 'cb-agent-chip' }, t('stats.teamSubs', { n: formatCount(count) })) : null)),
    props.children,
  )
}

/** One node card. */
function AgentCard(props: {
  t: Translate
  node: AgentNode
  left: number
  top: number
  width: number
  current: boolean
  /** Dimmed because it is outside the hovered node's lineage. */
  dim: boolean
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
}): ReactElement {
  const { t, node, left, top, width, current, dim, onHover, onOpen } = props
  const pct = node.head?.pct ?? null
  const tokens = node.billed ?? node.head?.tokens ?? null
  const identity = node.identity
  const mode = identity === null ? null : t(identity.mode === 'continuable' ? 'agents.continuable' : 'agents.oneshot')
  const segments = barSegmentsOf(node, STAGE_COLOR)
  return h('button', {
    type: 'button',
    className: `cb-agent-node${current ? ' cb-agent-node-current' : ''}${node.running ? ' cb-agent-node-running' : ''}${dim ? ' cb-agent-node-dim' : ''}`,
    style: { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${AGENT_CARD_HEIGHT}px` },
    title: node.subagent ? t('agents.open') : undefined,
    'aria-label': node.label,
    onMouseEnter: () => { onHover(node.id) },
    onFocus: () => { onHover(node.id) },
    onClick: () => { onOpen(node.id) },
  },
    h('div', { className: 'cb-agent-node-head' },
      h('span', { className: 'cb-agent-node-name' }, node.label),
      node.isCurrent ? h('span', { className: 'cb-agent-badge cb-agent-badge-current' }, t('agents.self')) : null,
      node.running ? h('span', { className: 'cb-agent-badge cb-agent-badge-running' }, t('agents.running')) : null),
    h('div', { className: 'cb-agent-node-figures' },
      h('span', { className: 'cb-agent-node-tokens' }, tokens !== null ? formatCount(tokens) : '—'),
      pct !== null ? h('span', { className: 'cb-agent-node-pct' }, `${pct}%`) : null,
      h('span', { className: 'cb-agent-node-steps' }, t('agents.steps', { n: formatCount(node.requests) }))),
    // The occupancy bar: the node's own composition, with the idle window as the remainder. The segments are
    // the same stage colours the composition card uses, so a bar here and a bar there describe the same thing.
    h('div', { className: 'cb-agent-node-bar' },
      segments.length === 0
        ? (pct !== null
          ? h('span', { className: 'cb-agent-node-fill', style: { width: `${Math.min(100, pct)}%`, background: pressureColorOf(pct) } })
          : null)
        : segments.map(segment => h('span', {
          key: segment.key,
          className: 'cb-agent-node-seg',
          style: { width: `${segment.share}%`, background: segment.color },
        }))),
    h('div', { className: 'cb-agent-node-foot' },
      mode !== null ? h('span', { className: 'cb-agent-node-mode' }, mode) : null,
      node.durationMs !== null ? h('span', { className: 'cb-agent-node-time' }, formatDurationCompact(node.durationMs)) : null,
      node.completed ? h('span', { className: 'cb-agent-node-done' }, '✓') : null),
  )
}


/**
 * The hover inspector: the node's identity, its occupancy, the composition of its bar, and the verb that opens
 * its session. It mirrors whichever card the pointer is on, so the graph stays one interactive surface rather
 * than a field of buttons whose details live elsewhere.
 */
function Inspector(props: { t: Translate; node: AgentNode; onOpen: (id: string) => void }): ReactElement {
  const { t, node, onOpen } = props
  const head = node.head
  const segments = barSegmentsOf(node, STAGE_COLOR)
  return h('div', { className: 'cb-agent-inspector' },
    h('div', { className: 'cb-agent-inspector-row' },
      h('span', { className: 'cb-agent-inspector-name' }, node.label),
      node.isCurrent ? h('span', { className: 'cb-agent-badge' }, t('agents.self')) : null,
      node.running
        ? h('span', { className: 'cb-agent-badge cb-agent-badge-running' }, t('agents.running'))
        : node.completed ? h('span', { className: 'cb-agent-badge' }, t('agents.done')) : null,
      head !== null && head.pct !== null
        ? h('span', { className: 'cb-agent-inspector-stats' }, `${formatCount(head.tokens)} · ${head.pct}%`)
        : head !== null ? h('span', { className: 'cb-agent-inspector-stats' }, formatCount(head.tokens)) : null,
      // Every node is openable, including the current one: that is how a reader returns to the centre column
      // after wandering into a relative.
      h('button', {
        type: 'button',
        className: 'cb-agent-inspector-open',
        onClick: () => { onOpen(node.id) },
      }, t('agents.open'))),
    // The same slices the bar draws, named: the bar shows the proportion, this row says what it is.
    segments.length > 0
      ? h('div', { className: 'cb-agent-inspector-parts' }, segments.map(segment => h('span', { key: segment.key, className: 'cb-agent-part' },
        h('i', { style: { background: segment.color } }),
        h('span', null, segment.key === 'free' ? t('agents.free') : stageLabel(t, segment.key)),
        h('em', null, `${Math.round(segment.share)}%`))))
      : null,
  )
}

/** The billed token total of a snapshot's own ledger. */
function billedOf(snapshot: Snapshot): number {
  let total = 0
  for (const models of Object.values(snapshot.cost ?? {})) {
    for (const entry of Object.values(models)) {
      if (entry.peak !== undefined) total += entry.peak.uncached + entry.peak.cacheRead + entry.peak.cacheWrite + entry.peak.output
      if (entry.off !== undefined) total += entry.off.uncached + entry.off.cacheRead + entry.off.cacheWrite + entry.off.output
    }
  }
  return total
}


