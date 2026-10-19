/**
 * The agent family behind the network card: a pure model derived from the session-list snapshot.
 *
 * The snapshot already carries everything the graph needs — each row's parent, its projections, its running
 * state — so this module folds it into the current session's family: the subtree under the topmost known
 * ancestor, per-node statistics, and a depth/DFS layout.
 *
 * Three rules are load-bearing and each one fixes a visible bug:
 *
 * 1. **Anchor on the topmost known ancestor, not on the current session.** Otherwise opening a sub-agent
 *    shows a leaf instead of the team it belongs to.
 * 2. **Sibling order follows the parent's `subagentCatalog`** — the harness's own spawn order, which is what
 *    its sub-agent header dialog shows. Only when neither sibling has a catalog rank does the activity
 *    heuristic (running first, then newest, then id) apply.
 * 3. **Cycle-safe.** The row graph is untrusted wire data; a duplicated or circular `parentId` chain must not
 *    loop or double-count.
 */

import { mergeLedgers } from '../../data/cost'
import { headlineOf } from '../context/derive'
import type { Headline } from '../context/derive'
import type { CostLedger } from '../../../wire/model'
import { snapshotOf } from '../../shell/washers'

/** The slice of the session-list row this model reads. Every field except the flags is optional: a missing
 * field must not fail the whole fold. */
export interface AgentRow {
  title?: string
  displayTitle?: string
  parentId?: string
  origin?: string
  running: boolean
  blank: boolean
  updatedAt: number
  projections?: Record<string, unknown>
}

/** The sub-agent identity projection: its mode and its durable label. `mode` is the discriminator with no
 * default, so a future harness mode reads as "no identity" rather than as a usable node. */
export interface AgentIdentity {
  mode: 'one-shot' | 'continuable'
  label?: string
}

/** One node's rendering inputs. `billed` is the metered token total; the ledger is only ever read for its
 * token volume — this card lives on a token-only surface and never prints a price. */
export interface AgentStats {
  head: Headline | null
  requests: number
  billed: number | null
  ledger: CostLedger | null
  durationMs: number | null
  identity: AgentIdentity | null
}

/** The current session's live statistics, which are fresher than any list row. */
export interface SelfStats {
  head: Headline | null
  billed: number | null
  requests: number
  ledger?: CostLedger | null
  durationMs?: number | null
}

/** One placed node: its statistics plus the tree/edge facts the renderer needs. */
export interface AgentNode extends AgentStats {
  id: string
  label: string
  parentId?: string
  depth: number
  /** Which first-level subtree this node belongs to (-1 for the root) — it decides the family's hue. */
  family: number
  isCurrent: boolean
  running: boolean
  completed: boolean
  subagent: boolean
}

/** The family, arranged into a renderable graph. `solo` marks a degenerate one-node family, so the card can
 * drop the edge layer entirely instead of drawing an empty canvas. */
export interface AgentForest {
  /** DFS pre-order: every parent precedes its children. */
  nodes: AgentNode[]
  edges: Array<{ from: string; to: string }>
  overflow: number
  solo: boolean
}

/** Beyond this many nodes the card stops being readable; the rest collapses into one overflow note. */
export const AGENT_TREE_LIMIT = 25

/** Fixed card height in px — the stylesheet's `.cb-agent-card-node` height matches it, so an edge leaving a
 * card's bottom edge and entering the next card's top edge always lands on the card boundary. */
export const AGENT_CARD_HEIGHT = 104

/** Horizontal slot width: every card fills its slot minus the gutter, so no card can crowd its neighbour. */
export const AGENT_SLOT_MAX = 276
export const AGENT_SLOT_MIN = 150
const CARD_GUTTER = 12
/** One grid column's width. Fixed, so a card is the same size on every level. */
const AGENT_SLOT_W = 190
/** Vertical step between levels: the card plus the 40px lane reserved for edges below it. */
const LEVEL_HEIGHT = AGENT_CARD_HEIGHT + 40
const PAD_Y = 48

/** Narrow one raw list row; a non-record row is skipped. */
export function agentRowOf(value: unknown): AgentRow | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const projections = record.projectionValues !== null && typeof record.projectionValues === 'object'
    ? record.projectionValues as Record<string, unknown>
    : null
  return {
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    ...(typeof record.displayTitle === 'string' ? { displayTitle: record.displayTitle } : {}),
    ...(typeof record.parentId === 'string' ? { parentId: record.parentId } : {}),
    ...(typeof record.origin === 'string' ? { origin: record.origin } : {}),
    running: record.running === true,
    blank: record.blank === true,
    updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
    ...(projections !== null ? { projections } : {}),
  }
}

/** The sub-agent descriptor. */
export function agentIdentityOf(value: unknown): AgentIdentity | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record.mode !== 'one-shot' && record.mode !== 'continuable') return null
  return {
    mode: record.mode,
    ...(typeof record.label === 'string' && record.label !== '' ? { label: record.label } : {}),
  }
}

/** Fold the `subagentTiming` projection into one duration: settled time plus the currently open interval.
 * The open interval is floored at 0 because `through` can trail `since` mid-fold; a non-positive total is
 * `null` (a zero duration is not a figure worth printing). */
export function agentDurationOf(value: unknown): number | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const settled = typeof record.settledMs === 'number' && Number.isFinite(record.settledMs) ? record.settledMs : 0
  const active = record.active !== null && typeof record.active === 'object'
    ? record.active as Record<string, unknown>
    : null
  const since = active !== null && typeof active.since === 'number' ? active.since : 0
  const through = active !== null && typeof active.through === 'number' ? active.through : 0
  const open = active !== null ? Math.max(0, through - since) : 0
  const total = settled + open
  return total > 0 ? total : null
}

/** The harness's own completion signal: the last turn closed cleanly after the sub-agent descriptor ended.
 * A running session is never complete, whatever it last returned. */
export function agentCompletedOf(value: unknown): boolean {
  return value !== null && typeof value === 'object'
    && (value as { lastTurnCompleted?: unknown }).lastTurnCompleted === true
}

/** Fold one row's projections into renderable statistics. The plugin's own timeline comes first; a row that
 * only carries pressure still yields an occupancy ring, just without the slices. */
export function agentStatsOf(projections: Record<string, unknown> | undefined): AgentStats {
  const timeline = snapshotOf(projections?.contextTimeline)
  const ledger = timeline?.cost ?? null
  const billed = ledger === null ? null : billedTokensOf(ledger)
  return {
    head: timeline === null ? null : headlineOf(timeline),
    // The split generation's head carries precomputed counters; an inline row counts its served records.
    requests: timeline !== null ? (timeline.counts?.steps ?? timeline.requests.length) : 0,
    billed,
    ledger,
    durationMs: agentDurationOf(projections?.subagentTiming),
    identity: agentIdentityOf(projections?.subagent),
  }
}

/** The billed token total of a ledger. */
function billedTokensOf(ledger: CostLedger): number {
  let total = 0
  for (const models of Object.values(ledger)) {
    for (const entry of Object.values(models)) {
      if (entry.peak !== undefined) total += entry.peak.uncached + entry.peak.cacheRead + entry.peak.cacheWrite + entry.peak.output
      if (entry.off !== undefined) total += entry.off.uncached + entry.off.cacheRead + entry.off.cacheWrite + entry.off.output
    }
  }
  return total
}

/** Spawn order from the parent's `subagentCatalog` — the harness's own sibling ordering. A malformed entry is
 * dropped; a missing or empty catalog returns `null`, and the caller keeps its activity heuristic. */
export function catalogOrderOf(projections: Record<string, unknown> | undefined): Map<string, number> | null {
  const catalog = projections?.subagentCatalog
  if (!Array.isArray(catalog)) return null
  const order = new Map<string, number>()
  for (const entry of catalog) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id === '') continue
    if (!order.has(record.id)) order.set(record.id, order.size)
  }
  return order.size > 0 ? order : null
}

/**
 * Build the current session's agent family.
 *
 * Returns `null` only when the snapshot itself is unreadable; a session the list has not materialised yet is
 * synthesised as an empty row so the graph still anchors on it.
 */
export function agentForestOf(snapshot: unknown, currentId: string | undefined, self?: SelfStats): AgentForest | null {
  const root = snapshot !== null && typeof snapshot === 'object'
    ? (snapshot as { byId?: unknown }).byId
    : undefined
  if (root === null || typeof root !== 'object' || currentId === undefined || currentId === '') return null
  const byId = root as Record<string, unknown>

  const rows = new Map<string, AgentRow>()
  for (const key of Object.keys(byId)) {
    const row = agentRowOf(byId[key])
    // A blank placeholder (never used) is not an agent — but the current session is always kept.
    if (row !== null && (!row.blank || key === currentId)) rows.set(key, row)
  }
  if (!rows.has(currentId)) {
    rows.set(currentId, { running: false, blank: false, updatedAt: 0 })
  }

  // The topmost known ancestor; a cycle anchors at the first repeated id.
  let anchor = currentId
  const chain = new Set<string>([currentId])
  for (;;) {
    const parent = rows.get(anchor)?.parentId
    if (parent === undefined || !rows.has(parent) || chain.has(parent)) break
    chain.add(parent)
    anchor = parent
  }
  const anchorRow = rows.get(anchor)
  if (anchorRow === undefined) return null

  const childrenOf = new Map<string, string[]>()
  for (const [id, row] of rows) {
    if (row.parentId === undefined || !rows.has(row.parentId)) continue
    const list = childrenOf.get(row.parentId) ?? []
    list.push(id)
    childrenOf.set(row.parentId, list)
  }
  for (const [parentId, kids] of childrenOf) {
    // With a catalog, sibling order is the parent's spawn order; uncatalogued children sort after the
    // catalogued ones. Without a catalog, the activity heuristic applies to the whole group.
    const order = catalogOrderOf(rows.get(parentId)?.projections)
    kids.sort((left, right) => {
      const leftRank = order?.get(left)
      const rightRank = order?.get(right)
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1
        if (rightRank === undefined) return -1
        return leftRank - rightRank
      }
      const runDelta = Number(rows.get(right)?.running === true) - Number(rows.get(left)?.running === true)
      if (runDelta !== 0) return runDelta
      const timeDelta = (rows.get(right)?.updatedAt ?? 0) - (rows.get(left)?.updatedAt ?? 0)
      return timeDelta !== 0 ? timeDelta : (left < right ? -1 : 1)
    })
  }

  // Measure the family first: the cap truncates the traversal, so the overflow note must be computed before
  // it can shorten the walk.
  const measure = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    let total = 1
    for (const kid of childrenOf.get(id) ?? []) total += measure(kid, seen)
    return total
  }
  const total = measure(anchor, new Set())

  const nodes: AgentNode[] = []
  const edges: Array<{ from: string; to: string }> = []
  const visit = (id: string, row: AgentRow, parentId: string | undefined, depth: number, seen: Set<string>, family: number): void => {
    if (seen.has(id) || nodes.length >= AGENT_TREE_LIMIT) return
    seen.add(id)
    const stats = agentStatsOf(row.projections)
    if (id === currentId && self !== undefined) {
      // The live self statistics win over the row's: the row may be seconds stale.
      stats.head = self.head ?? stats.head
      stats.billed = self.billed ?? stats.billed
      stats.requests = self.requests > 0 ? self.requests : stats.requests
      stats.ledger = self.ledger ?? stats.ledger
      stats.durationMs = self.durationMs ?? stats.durationMs
    }
    const subagent = row.origin === 'subagent' || stats.identity !== null
    nodes.push({
      ...stats,
      id,
      label: stats.identity?.label ?? row.title ?? row.displayTitle ?? id,
      ...(parentId !== undefined ? { parentId } : {}),
      depth,
      family,
      isCurrent: id === currentId,
      running: row.running,
      // Completion follows the harness's own dialog rule: only a stopped agent can be complete, and the
      // signal is a cleanly closed last sub-agent turn. A non-sub-agent session carries no such projection,
      // so its own folded step count stands in.
      completed: !row.running && (agentCompletedOf(row.projections?.subagentTiming) || (!subagent && stats.requests > 0)),
      subagent,
    })
    if (parentId !== undefined) edges.push({ from: parentId, to: id })
    const kids = childrenOf.get(id) ?? []
    kids.forEach((kid, index) => {
      // A root child's index becomes its family id; deeper nodes inherit it, so each first-level subtree has
      // one hue however deep it goes.
      visit(kid, rows.get(kid) as AgentRow, id, depth + 1, seen, depth === 0 ? index : family)
    })
  }
  visit(anchor, anchorRow, undefined, 0, new Set(), -1)

  return { nodes, edges, overflow: Math.max(0, total - nodes.length), solo: nodes.length === 1 }
}

/** One node's slot in the stage. */
export interface PlacedNode {
  node: AgentNode
  /** Slot index within its depth level, and the level's total slot count. */
  column: number
  columns: number
  left: number
  top: number
  width: number
}

/** A laid-out graph: the placed cards, the edge paths between them, and the stage size. */
export interface AgentLayout {
  placed: PlacedNode[]
  edges: Array<{ from: string; to: string; path: string }>
  width: number
  height: number
  slot: number
}

/**
 * Lay the family out.
 *
 * Cards sit on a grid: one slot per node, slots distributed evenly across the stage so the graph reads as a
 * grid rather than as cards that sized themselves. `stageWidth` comes from the card's measured width; the slot
 * width is clamped between the two bounds so a narrow sidebar still gets readable cards.
 */
export function layoutForest(forest: AgentForest, stageWidth: number): AgentLayout {
  const levels = new Map<number, AgentNode[]>()
  for (const node of forest.nodes) {
    const list = levels.get(node.depth) ?? []
    list.push(node)
    levels.set(node.depth, list)
  }

  // A level wraps into as many rows as the card needs. A real family is one root with a couple of children and
  // then two dozen grandchildren, so a single row per level overflowed the card by 2,200px. Each level therefore
  // gets its own block of rows, and the level's rows are centred within it.
  const slot = AGENT_SLOT_W
  const perRow = Math.max(1, Math.floor(Math.max(stageWidth, AGENT_SLOT_MIN) / slot))
  const width = Math.max(stageWidth, slot * Math.min(perRow, maxLevelSize(levels)))

  const placed: PlacedNode[] = []
  /** The y where the next level's first row starts; each level advances by its own row count. */
  let cursorY = PAD_Y
  const depthOrder = [...levels.keys()].sort((a, b) => a - b)
  for (const depth of depthOrder) {
    const list = levels.get(depth) as AgentNode[]
    const rows = Math.ceil(list.length / perRow)
    list.forEach((node, index) => {
      const row = Math.floor(index / perRow)
      const column = index % perRow
      const inRow = Math.min(perRow, list.length - row * perRow)
      const rowWidth = inRow * slot
      placed.push({
        node,
        column,
        columns: inRow,
        left: Math.round((width - rowWidth) / 2) + column * slot + CARD_GUTTER / 2,
        top: cursorY + row * LEVEL_HEIGHT,
        width: slot - CARD_GUTTER,
      })
    })
    cursorY += rows * LEVEL_HEIGHT
  }

  const byId = new Map(placed.map(entry => [entry.node.id, entry]))
  const edges: AgentLayout['edges'] = []
  for (const edge of forest.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    // A cubic curve from the parent's bottom edge to the child's top edge. The 40px reserved below every card
    // is the curve's lane: with a wrapped level the curve can start below the parent and land above the child
    // without crossing any card, because a level only begins after the previous one's lanes have ended.
    const x1 = from.left + from.width / 2
    const y1 = from.top + AGENT_CARD_HEIGHT
    const x2 = to.left + to.width / 2
    const y2 = to.top
    const midY = (y1 + y2) / 2
    edges.push({ from: edge.from, to: edge.to, path: `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}` })
  }

  const height = cursorY + PAD_Y
  return { placed, edges, width, height, slot }
}

/** The largest number of nodes on any one level. */
function maxLevelSize(levels: ReadonlyMap<number, readonly AgentNode[]>): number {
  let widest = 1
  for (const list of levels.values()) if (list.length > widest) widest = list.length
  return widest
}

/** Fold the current session's sub-agent subtree cost (the team figure on the summary panel). The current
 * session itself is never included — the caller already holds its own usage. Cycle-safe by a `seen` set,
 * because the row graph is untrusted. */
export function subagentCostOf(snapshot: unknown, currentId: string | undefined): { ledger: CostLedger | null; count: number } {
  const root = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { byId?: unknown }).byId : undefined
  if (root === null || typeof root !== 'object' || currentId === undefined || currentId === '') {
    return { ledger: null, count: 0 }
  }
  const byId = root as Record<string, unknown>
  const childrenOf = new Map<string, string[]>()
  for (const key of Object.keys(byId)) {
    const row = agentRowOf(byId[key])
    if (row === null || row.blank || row.parentId === undefined) continue
    const list = childrenOf.get(row.parentId) ?? []
    list.push(key)
    childrenOf.set(row.parentId, list)
  }
  let ledger: CostLedger | null = null
  let count = 0
  const seen = new Set<string>([currentId])
  const queue = [currentId]
  for (let index = 0; index < queue.length; index++) {
    for (const kid of childrenOf.get(queue[index]) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      queue.push(kid)
      const stats = agentStatsOf(agentRowOf(byId[kid])?.projections)
      if (stats.ledger !== null) ledger = mergeLedgers(ledger, stats.ledger)
      count++
    }
  }
  return { ledger, count }
}

/** Re-exported so the card can render a node's occupancy without a second import site. */
export type { Headline }

/** The lineage of one node: its ancestor chain plus its whole subtree, as a set of ids. Hovering a card lights
 * exactly these, and dims every other link — which is what makes a wide family readable.
 *
 * Cycle-safe: the row graph is untrusted, and both walks carry their own `seen` set.
 */
export function lineageOf(forest: AgentForest, id: string): Set<string> {
  const lit = new Set<string>()
  const byId = new Map(forest.nodes.map(node => [node.id, node]))
  // Ancestors, walking up the single `parentId` field.
  let cursor: string | undefined = id
  while (cursor !== undefined && !lit.has(cursor)) {
    lit.add(cursor)
    cursor = byId.get(cursor)?.parentId
  }
  // Descendants, walking down the edge list breadth-first.
  const childrenOf = new Map<string, string[]>()
  for (const edge of forest.edges) {
    const list = childrenOf.get(edge.from) ?? []
    list.push(edge.to)
    childrenOf.set(edge.from, list)
  }
  const queue = [id]
  const seen = new Set<string>([id])
  for (let index = 0; index < queue.length; index++) {
    for (const child of childrenOf.get(queue[index]) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      lit.add(child)
      queue.push(child)
    }
  }
  return lit
}

/** The occupancy colour of a node, from its percentage: green while there is room, amber as it fills, red when
 * the next turn will not fit. `null` (no occupancy reported) is the neutral slate. */
export function pressureColorOf(pct: number | null): string {
  if (pct === null) return 'var(--cb-ctx-slate)'
  if (pct >= 90) return 'var(--cb-ctx-pink)'
  if (pct >= 75) return 'var(--cb-ctx-orange)'
  if (pct >= 50) return 'var(--cb-ctx-amber)'
  return 'var(--cb-ctx-green)'
}

/** A node's bar segments: the context composition, with the idle window as the remainder. */
export function barSegmentsOf(node: AgentNode, colors: Readonly<Record<string, string>>): Array<{ key: string; share: number; color: string }> {
  const head = node.head
  if (head === null || head.tokens <= 0) return []
  const total = head.window !== undefined && head.window > 0 ? Math.max(head.window, head.tokens) : head.tokens
  const segments: Array<{ key: string; share: number; color: string }> = []
  for (const part of head.parts) {
    if (part.value <= 0) continue
    segments.push({ key: part.key, share: (part.value / total) * 100, color: colors[part.key] ?? 'var(--cb-ctx-slate)' })
  }
  const used = segments.reduce((sum, segment) => sum + segment.share, 0)
  if (used < 100) segments.push({ key: 'free', share: 100 - used, color: 'transparent' })
  return segments
}

/** A compact duration: `1h 04m`, `3m 20s`, `12s`. */
export function formatDurationCompact(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}
