/**
 * State → wire: the three generations of the `contextTimeline` value.
 *
 * The harness pushes a projection value on `session.list`, on every baseline and on every change
 * frame, so the size of one value is paid for by every session in the list. That is why this unit
 * has two generations of the *same* value:
 *
 * - {@link headOf} — the **slim head**: envelope scalars, precomputed counters, the newest request's
 *   billing anchor, the cost ledgers, and `detailRev`. Served while the detail route is live, so the
 *   client can fetch the heavy collections per viewing tab.
 * - {@link detailOf} — the heavy collections, served by that route: request rows, event rows, the
 *   pinned node slice, the archive, file operations and timing spans.
 * - {@link inlineOf} — head **plus** collections, for a deployment with no detail channel. The
 *   pre-split generation, still fully functional, and it must stay byte-for-byte equivalent to
 *   `{ ...headOf, ...detailOf }` so the two paths cannot drift.
 *
 * Every served value is a copy: the registry, the cache writer and the browser must never be able
 * to mutate the fold's own records through what they were served.
 *
 * The generation is chosen per serve from a liveness callback, never fixed at construction: the
 * detail route is armed asynchronously on the `connection` + `sessions` services, so the very same
 * unit must serve inline before it exists and slim afterwards.
 */

import {
  copyCallLedger, copyCostLedger,
} from '../../core/ledger'
import type {
  CallLedger, CostLedger, FileOp, LedgerEvent, NewestRequest, RequestRow, RetainedCounts,
  Snapshot, SurfaceEntry, SystemNode, TimelineDetail, TimingSegment, TimingTotals, TurnLedger,
} from '../../wire/model'
import { creditRatesForWire } from '../platform/catalog'
import type { FoldBounds } from '../settings'
import type { TimelineState } from './state'

/** The heavy half of the value, without the `rev`/`head` wrapper the detail route adds. */
export type TimelineCollections = Omit<TimelineDetail, 'rev' | 'head'>

/**
 * The envelope scalars, the live-surface aggregates and the newest request anchor.
 *
 * The detail collections are deliberately left at their empty values so a caller can spread this
 * and then splice the collections in — that is exactly how the inline generation is built.
 */
export function headOf(state: TimelineState): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.skill
    + state.sums.assistant + state.sums.tool
  const snapshot: Snapshot = {
    ok: true,
    // Optional scalars are spread only when present: an own `undefined` property would fail the
    // harness's lossless-JSON push for the whole value.
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.provider !== undefined ? { provider: state.provider } : {}),
    ...(state.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
    current: {
      system: state.systemTokens,
      tools: state.toolsTokens,
      user: state.sums.user,
      inject: state.sums.inject,
      skill: state.sums.skill,
      assistant: state.sums.assistant,
      tool: state.sums.tool,
      total: surfaceTotal + state.systemTokens + state.toolsTokens,
    },
    images: state.surface.reduce((total, node) => total + (node.imgs ?? 0), 0),
    // A call still in flight (no result yet) and a call whose result was compacted out do not count.
    // Skill loads keep their tool identity, so they still count.
    toolCalls: state.surface.reduce(
      (total, node) => (node.cat === 'tool' || (node.cat === 'skill' && node.tool !== undefined) ? total + 1 : total),
      0,
    ),
    humanInputs: state.humanInputs ?? 0,
    answers: state.answers ?? 0,
    ...(state.lastUser !== undefined ? { lastUser: state.lastUser } : {}),
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
  // The billed ledgers ride the head: they are whole-session accumulators the card prices directly,
  // and they are small relative to the collections.
  if (state.cost !== undefined) snapshot.cost = copyCostLedger(state.cost)
  if (state.calls !== undefined) snapshot.calls = copyCallLedger(state.calls)
  if (state.turnCost !== undefined) snapshot.turnCost = copyTurnLedger(state.turnCost)
  const creditRates = creditRatesForWire()
  if (creditRates !== undefined) snapshot.creditRates = creditRates
  if (state.timing !== undefined) snapshot.timing = copyTiming(state.timing)
  if (state.systems !== undefined && state.systems.length > 0) {
    snapshot.systems = state.systems.map(copySystemNode)
  }
  return snapshot
}

/** Deep-copy a turn ledger (its nested `usage` and `requests` are shared with the persisted state). */
function copyTurnLedger(ledger: TurnLedger): TurnLedger {
  const copy: TurnLedger = {}
  for (const turn of Object.keys(ledger)) {
    copy[turn] = { usage: copyCostLedger(ledger[turn].usage), requests: copyCallLedger(ledger[turn].requests) }
  }
  return copy
}

/** Copy a timing accumulator, including its nested per-name rows. */
function copyTiming(timing: TimingTotals): TimingTotals {
  const tools: TimingTotals['tools'] = {}
  for (const name of Object.keys(timing.tools)) tools[name] = { ...timing.tools[name] }
  return { ...timing, tools }
}

/** Copy one system-prompt node (nodes are shared with the persisted state). */
function copySystemNode(node: SystemNode): SystemNode {
  return { seq: node.seq, time: node.time, tokens: node.tokens }
}

/**
 * The heavy collections, with the surface sliced by the pinning rule.
 *
 * Two overflows are possible when a long session exceeds `maxNodes`: the plain tail trim, and the
 * pinned injection/skill nodes. Injection content lands on the surface **first**, so a tail-only
 * slice would drop its identity while its tokens keep counting — the browser would show token totals
 * with nothing to list. Pinning every older live inject/skill node keeps that identity addressable;
 * the dropped count excludes the pinned nodes, and `surfaceFloor` names the newest *dropped* seq so
 * the client can mark a reconstruction approximate instead of silently showing less.
 */
export function detailOf(state: TimelineState, bounds: FoldBounds): TimelineCollections {
  const requests = state.requests.map(copyRequest)
  const events = state.events.map(copyEventRow)
  attachRequestContext(requests, events)

  const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes)
  const overflow = state.surface.slice(0, overflowCount)
  const tail = state.surface.slice(overflowCount)
  const pinned = overflow.filter(node => node.cat === 'inject' || node.cat === 'skill')
  // The overflow slice precedes the tail positionally, so the concatenation stays seq-ordered.
  const nodes = pinned.length > 0 ? [...pinned, ...tail] : tail
  const collections: TimelineCollections = {
    requests,
    events,
    nodes: nodes.map(copySurfaceNode),
    droppedNodes: overflowCount - pinned.length,
    archive: state.archived.map(copySurfaceNode),
    fileOps: state.fileOps.map(copyFileOp),
    ...(state.fileOpsFloor !== undefined ? { fileOpsFloor: state.fileOpsFloor } : {}),
    spans: state.spans.map(copySpan),
  }
  if (collections.droppedNodes > 0) {
    let floor = 0
    for (const node of overflow) {
      if (node.cat !== 'inject' && node.cat !== 'skill') floor = Math.max(floor, node.seq)
    }
    collections.surfaceFloor = floor
  }
  if (state.archiveFloor !== undefined) collections.archiveFloor = state.archiveFloor
  return collections
}

/** The slim head plus the collections in place: the pre-split generation. */
export function inlineOf(state: TimelineState, bounds: FoldBounds): Snapshot {
  return { ...headOf(state), ...detailOf(state, bounds) }
}

/**
 * Attach each event row to its surrounding requests: `turn`/`step` point at the first request
 * recorded **after** the event, `fromTurn`/`fromStep` at the one before it.
 *
 * Both lists are seq-ordered, so one pointer walk is enough. The rows were copied first, which is
 * what makes this annotation safe to run on a served value.
 */
function attachRequestContext(requests: readonly RequestRow[], events: readonly LedgerEvent[]): void {
  let index = 0
  for (const event of events) {
    while (index < requests.length && requests[index].seq <= event.seq) index++
    const next = requests.at(index)
    const previous = index > 0 ? requests.at(index - 1) : undefined
    if (next !== undefined && typeof next.turn === 'number' && typeof next.step === 'number') {
      event.turn = next.turn
      event.step = next.step
    }
    if (previous !== undefined && typeof previous.turn === 'number' && typeof previous.step === 'number') {
      event.fromTurn = previous.turn
      event.fromStep = previous.step
    }
  }
}

/** The precomputed counters over the *retained* records (not the whole log). */
export function countsOf(state: TimelineState): RetainedCounts {
  const turns = new Set<number>()
  for (const record of state.requests) turns.add(record.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  // Distinct skill names among tagged inject rows; the catalog digest rides an untagged row, so it
  // never counts as a load.
  const skills = new Set<string>()
  for (const event of state.events) {
    if (event.kind === 'inject') injects++
    else if (event.kind === 'compaction') compactions++
    else if (event.kind === 'prune') prunes++
    if (event.sub === 'skill' && typeof event.name === 'string' && event.name !== '') skills.add(event.name)
  }
  return { turns: turns.size, steps: state.requests.length, injects, compactions, prunes, skills: skills.size }
}

/**
 * The split generation's head: the slim head plus the counters, the newest request anchor, and the
 * detail revision. `detailRev` is the split marker — its *presence* tells the client which
 * generation it received.
 */
export function splitHeadOf(state: TimelineState): Snapshot {
  const snapshot = headOf(state)
  snapshot.counts = countsOf(state)
  const last = state.requests.at(-1)
  if (last !== undefined) {
    const anchor: NewestRequest = { seq: last.seq, total: last.total }
    if (typeof last.prompt === 'number') anchor.prompt = last.prompt
    snapshot.last = anchor
  }
  snapshot.detailRev = state.detailRev ?? 0
  return snapshot
}

/** The full detail payload the route serves: the revision cursor, the same-cut head, collections. */
export function detailPayloadOf(state: TimelineState, bounds: FoldBounds): TimelineDetail {
  return { rev: state.detailRev ?? 0, head: splitHeadOf(state), ...detailOf(state, bounds) }
}

/** Copy one request row (rows are shared with the persisted state). */
function copyRequest(record: RequestRow): RequestRow {
  return { ...record }
}

/** Copy one event row. */
function copyEventRow(row: LedgerEvent): LedgerEvent {
  return { ...row }
}

/** Copy one surface node, including its small `calls` array. */
function copySurfaceNode(node: SurfaceEntry): SurfaceEntry {
  const copy: SurfaceEntry = { ...node }
  if (node.calls !== undefined) copy.calls = [...node.calls]
  return copy
}

/** Copy one file operation, including its nested read window. */
function copyFileOp(op: FileOp): FileOp {
  const copy: FileOp = { ...op }
  if (op.read !== undefined) copy.read = { ...op.read }
  return copy
}

/** Copy one timing span. */
function copySpan(span: TimingSegment): TimingSegment {
  return { kind: span.kind, start: span.start, end: span.end }
}

/** Re-exported so the detail route and the unit share one billed-ledger copy discipline. */
export type { CallLedger, CostLedger }
