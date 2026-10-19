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

import { useEffect, useMemo, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { Snapshot } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { formatCount, formatDuration } from '../../i18n/format'
import { AGENT_CARD_HEIGHT, agentForestOf, layoutForest, subagentCostOf } from './agents'
import type { AgentNode, SelfStats } from './agents'
import { headlineOf } from './derive'

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
  const [stageWidth, setStageWidth] = useState(0)

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

  const forest = useMemo(
    () => agentForestOf(sessions, sessionId, self),
    [sessions, sessionId, self],
  )
  const team = useMemo(() => subagentCostOf(sessions, sessionId), [sessions, sessionId])

  // Measure the stage so the grid can spread across the card's real width; a measurless environment (jsdom,
  // the first frame) falls back to the widest layout rather than cramming every card into one slot.
  useEffect(() => {
    const element = stage.current
    if (element === null) return
    const measure = (): void => { setStageWidth(element.clientWidth) }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  if (forest === null) {
    return h(Card, { t, team, count: team.count },
      h('div', { className: 'cb-empty' }, t('agents.solo')))
  }

  const layout = layoutForest(forest, Math.max(stageWidth, 240))
  const current = forest.nodes.find(node => node.isCurrent)
  const running = forest.nodes.filter(node => node.running).length

  return h(Card, {
    t,
    team,
    count: team.count,
    running,
    total: forest.nodes.length,
    ...(current?.billed !== null && current?.billed !== undefined ? { tokens: current.billed } : {}),
  },
    h('div', { ref: stage, className: 'cb-agent-stage', style: { height: `${layout.height}px`, width: forest.solo ? '100%' : `${layout.width}px` } },
      // Edges first: they must sit under the cards.
      forest.solo
        ? null
        : h('svg', { className: 'cb-agent-edges', viewBox: `0 0 ${layout.width} ${layout.height}`, 'aria-hidden': 'true' },
          layout.edges.map(edge => h('path', {
            key: `${edge.from}->${edge.to}`,
            d: edge.path,
            fill: 'none',
            stroke: 'var(--dsw-alias-border-l2)',
            'stroke-width': 1.5,
          }))),
      layout.placed.map(entry => h(AgentCard, {
        key: entry.node.id,
        t,
        node: entry.node,
        left: entry.left,
        top: entry.top,
        width: entry.width,
        current: entry.node.isCurrent,
        onOpen,
      })),
      forest.overflow > 0
        ? h('div', { className: 'cb-agent-overflow' }, t('agents.more', { n: formatCount(forest.overflow) }))
        : null),
    forest.solo ? h('div', { className: 'cb-agent-solo-note' }, t('agents.solo')) : null,
  )
}

/** The card frame and its header facts. */
function Card(props: {
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
  return h('div', { className: 'cb-card cb-agent-card' },
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
  onOpen: (id: string) => void
}): ReactElement {
  const { t, node, left, top, width, current, onOpen } = props
  const pct = node.head?.pct ?? null
  const tokens = node.billed ?? node.head?.tokens ?? null
  const identity = node.identity
  const mode = identity === null ? null : t(identity.mode === 'continuable' ? 'agents.continuable' : 'agents.oneshot')
  return h('button', {
    type: 'button',
    className: `cb-agent-node${current ? ' cb-agent-node-current' : ''}${node.running ? ' cb-agent-node-running' : ''}`,
    style: { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${AGENT_CARD_HEIGHT}px` },
    title: node.subagent ? t('agents.open') : undefined,
    'aria-label': node.label,
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
    // The occupancy bar: the ring's own measure, so a node's fullness reads the same here as in the composer.
    h('div', { className: 'cb-agent-node-bar' },
      pct !== null ? h('span', { className: 'cb-agent-node-fill', style: { width: `${Math.min(100, pct)}%` } }) : null),
    h('div', { className: 'cb-agent-node-foot' },
      mode !== null ? h('span', { className: 'cb-agent-node-mode' }, mode) : null,
      node.durationMs !== null ? h('span', { className: 'cb-agent-node-time' }, formatDuration(node.durationMs)) : null,
      node.completed ? h('span', { className: 'cb-agent-node-done' }, '✓') : null),
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


