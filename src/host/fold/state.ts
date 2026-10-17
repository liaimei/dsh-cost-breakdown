/**
 * The timeline fold's persisted state: its shape, its constructor, and retention.
 *
 * This is exactly the value the harness projection cache checkpoints, so two properties are
 * contractual rather than stylistic:
 *
 * 1. **Plain JSON.** An own property holding `undefined` makes the cache write fail for the whole
 *    session — including the `title` row that populates the session list — so every optional
 *    field stays *absent* until it has a value, and clearing one means deleting it.
 * 2. **Bounded.** The fold replays an untrusted log, so every collection here has a cap applied by
 *    {@link pruneTimeline}; the caps themselves come from the resolved row configuration.
 *
 * The state is never mutated in place by the reducer. Each interesting event works on a private
 * copy whose touched containers are cloned individually (see {@link FoldDraft}), which is what
 * lets `apply` return the persisted reference unchanged for events it does not care about.
 */

import type {
  CallLedger, CostLedger, FileOp, LedgerEvent, RequestRow, SurfaceEntry,
  SystemNode, TimingSegment, TimingTotals, TurnLedger, Stage,
} from '../../wire/model'
import type { FoldBounds } from '../settings'

/** Caps that are implementation vocabulary rather than user configuration. */
/** Keep the newest handful of system nodes: only the last non-empty one prices the prompt. */
export const SYSTEM_NODES_MAX = 8
/** A log that dispatches nested operations but never settles the root call cannot grow past this. */
export const PENDING_CODE_OPS_MAX = 200
/** The time strip cannot draw more slices than this, and none of them are ever read again. */
export const TIMING_SPANS_MAX = 2_000

/**
 * The envelope the fold consumes.
 *
 * The harness core's `SessionEvent` union does not cover the plugin-contributed event families
 * this fold reads (`compaction/*` comes from another package), and the fold must not depend on
 * those packages to learn their payloads. Hence a structural envelope: the reducer reads shapes,
 * never the probed harness version.
 */
export interface TimelineEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: unknown
}

/** An open user wait inside the running step. */
export interface StepWait {
  start: number
  end: number
}

/** The currently running step: its start instant, and the first token if one has been observed. */
export interface OpenStep {
  time: number
  firstToken?: number
}

/** A tool call that has been dispatched but not settled yet. */
export interface PendingCall {
  name: string
  start: number
  /** Raw arguments, kept only for tools whose arguments the fold will read. */
  argsRaw?: string
}

/** Live-token price per stage; always the exact per-stage sum of {@link TimelineState.surface}. */
export type StageTotals = Record<Stage, number>

/** The timeline fold's whole persisted state. */
export interface TimelineState {
  /** Model-visible surface, oldest first. */
  surface: SurfaceEntry[]
  /** Per-stage sum of the live surface; kept in step with `surface` on every mutation. */
  sums: StageTotals
  /** Effective system-prompt price: the last live system node with a positive count. */
  systemTokens: number
  /** Live system-prompt nodes, oldest first, capped at {@link SYSTEM_NODES_MAX}. */
  systems?: SystemNode[]
  /** Price of the latest request header's tool list. */
  toolsTokens: number
  model?: string
  provider?: string
  /** The switch detector: `model` after the previous header. Never cleared. */
  lastModel?: string
  contextWindow?: number
  /** Retained request records, oldest first. */
  requests: RequestRow[]
  /** Run count of `requests`, maintained incrementally at the single append point. */
  turnRuns?: number
  /** Compaction / prune / inject / model / mode rows, oldest first. */
  events: LedgerEvent[]
  /** Surface nodes removed by a replacement, as copies stamped with `gone`. */
  archived: SurfaceEntry[]
  /** Whole-session billed buckets. Never trimmed, so pricing always covers the whole log. */
  cost?: CostLedger
  /** Per-turn ledger, written by the same settlement as `cost`. */
  turnCost?: TurnLedger
  /** Whole-session request counts per (provider, model) — what per-request billing needs. */
  calls?: CallLedger
  /** Whole-session human-input counter; never trimmed. */
  humanInputs?: number
  /** Whole-session reply counter; never trimmed. */
  answers?: number
  /** Newest human message as a bounded single line. Last textual one wins. */
  lastUser?: string
  /** Newest `gone` dropped from `archived` by retention. */
  archiveFloor?: number
  /** Bumped by every fold that changes a served detail collection. */
  detailRev?: number
  /** Whole-session timing totals. */
  timing?: TimingTotals
  /** The open step, if any. Exactly one slot: steps are sequential in a well-formed log. */
  stepStart?: OpenStep
  /** Closed user-wait intervals inside the open step. */
  stepWaits?: StepWait[]
  /** Pending approval waits (request id → `approval/asked` instant). */
  stepApprovals?: Record<string, number>
  /** Seq of the request record `step/end` stamps `activeMs` onto. */
  stepRequestSeq?: number
  /** Flushed timing slices of completed steps, oldest first. */
  spans: TimingSegment[]
  /** Painting accumulators of the open step, flushed at `step/end`. */
  stepSpans?: TimingSegment[]
  /** Dispatched-but-unsettled tool calls, keyed by call id. */
  callNames: Record<string, PendingCall>
  /** Surface nodes the next replacement is declared to shadow, armed by a metering event. */
  pendingShadowedSeqs?: number[]
  /** Seq of the metering event that armed the claim; its `tokens` is rewritten net on the shadow path. */
  pendingShadowEventSeq?: number
  /** Derived file-operation log, oldest first. */
  fileOps: FileOp[]
  /** Newest dropped operation seq: the coverage watermark the file card renders. */
  fileOpsFloor?: number
  /** Nested Code-Mode operations buffered by their root call id until the parent settles. */
  pendingCodeOps?: Record<string, FileOp[]>
}

/** A blank state. `turnRuns` starts at 0 so the first prune reads the ledger, not an empty array. */
export function emptyTimeline(): TimelineState {
  return {
    surface: [],
    sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    systemTokens: 0,
    toolsTokens: 0,
    requests: [],
    turnRuns: 0,
    events: [],
    archived: [],
    callNames: {},
    fileOps: [],
    spans: [],
  }
}

/** Containers a handler may mutate in place; each must be cloned before it is written. */
export type ContainerKey =
  | 'surface' | 'sums' | 'requests' | 'events' | 'archived' | 'callNames' | 'fileOps' | 'timing'

/**
 * One event's private working state.
 *
 * A handler lists exactly the containers it intends to write; everything unlisted keeps sharing
 * the persisted previous state and therefore must never be written in place. Cloning `timing`
 * also clones its nested `tools` map, since that map is the one nested container the accumulators
 * mutate (`timing.tools[name].calls`).
 */
export interface FoldDraft {
  readonly previous: TimelineState
  readonly next: TimelineState
  /** Clone the named containers into `next` (idempotent). Returns `next` for chaining. */
  touch(...keys: readonly ContainerKey[]): TimelineState
}

/** Open a draft over a persisted state. Nothing is copied until {@link FoldDraft.touch}. */
export function draftOf(previous: TimelineState): FoldDraft {
  const next: TimelineState = { ...previous }
  const cloned = new Set<ContainerKey>()
  const touch = (...keys: readonly ContainerKey[]): TimelineState => {
    for (const key of keys) {
      if (cloned.has(key)) continue
      cloned.add(key)
      switch (key) {
        case 'surface': next.surface = [...previous.surface]; break
        case 'sums': next.sums = { ...previous.sums }; break
        case 'requests': next.requests = [...previous.requests]; break
        case 'events': next.events = [...previous.events]; break
        case 'archived': next.archived = [...previous.archived]; break
        case 'callNames': next.callNames = { ...previous.callNames }; break
        case 'fileOps': next.fileOps = [...previous.fileOps]; break
        case 'timing':
          // Absent stays absent: an own `undefined` property would fail every cache write.
          // `tools` is replaced wholesale by the accumulators, so it needs no pre-clone here,
          // but cloning it keeps a handler that mutates it in place honest.
          if (previous.timing !== undefined) {
            next.timing = { ...previous.timing, tools: { ...previous.timing.tools } }
          }
          break
      }
    }
    return next
  }
  return { previous, next, touch }
}

/** How many turn runs a record list holds: one per `turn` change. Turn-less records form one run. */
export function countTurnRuns(requests: readonly RequestRow[]): number {
  let runs = 0
  let previousTurn: number | undefined
  for (const record of requests) {
    if (record.turn !== previousTurn) {
      runs++
      previousTurn = record.turn
    }
  }
  return runs
}

/**
 * The newest `maxTurns` whole runs, scanning back to front so an over-long array costs one pass.
 *
 * Trimming is by **run**, never by step count: cutting at the step threshold would oscillate
 * (trim to N, regrow to the threshold, trim again) because a single turn can add many steps.
 */
export function trimToLastTurns(requests: readonly RequestRow[], maxTurns: number): RequestRow[] {
  let runs = 0
  let start = requests.length
  let previousTurn: number | undefined
  for (let index = requests.length - 1; index >= 0; index--) {
    const turn = requests[index].turn
    if (turn !== previousTurn) {
      if (runs >= maxTurns) break
      runs++
      previousTurn = turn
    }
    start = index
  }
  return requests.slice(start)
}

/**
 * Apply every retention cap to a state that has finished folding one event.
 *
 * Order is load-bearing: the archive prune reads the *post-trim* oldest retained request seq, so
 * the request trims must run first.
 *
 * Mutates the draft's private copy — callers must pass a state they own.
 */
export function pruneTimeline(state: TimelineState, bounds: FoldBounds): void {
  // A cache row restored from a build that predates the incremental ledger has no `turnRuns`;
  // recompute once here rather than treat the run count as zero and never trim.
  state.turnRuns = state.turnRuns ?? countTurnRuns(state.requests)
  if (state.turnRuns > bounds.maxKeptTurns) {
    state.requests = trimToLastTurns(state.requests, bounds.maxKeptTurns)
    state.turnRuns = countTurnRuns(state.requests)
  }
  // Pathological single-turn sessions: the run trim cannot cut inside a turn, so a hard step cap
  // backstops it.
  if (state.requests.length > bounds.maxRequestSteps) {
    state.requests = state.requests.slice(-bounds.maxRequestSteps)
    state.turnRuns = countTurnRuns(state.requests)
  }
  if (state.events.length > bounds.maxEvents) state.events = state.events.slice(-bounds.maxEvents)
  if (state.spans.length > TIMING_SPANS_MAX) state.spans = state.spans.slice(-TIMING_SPANS_MAX)
  if (state.fileOps.length > bounds.maxFileOps) {
    const drop = state.fileOps.length - bounds.maxFileOps
    // The newest dropped seq is the coverage watermark: the card can say its log starts here.
    state.fileOpsFloor = Math.max(state.fileOpsFloor ?? 0, state.fileOps[drop - 1].seq)
    state.fileOps = state.fileOps.slice(drop)
  }
  pruneArchive(state, bounds)
}

/**
 * Drop archived nodes that can no longer belong to a retained step, then apply the archive cap.
 *
 * A removed node is only addressable through a replacement its own step recorded, so once the
 * request list no longer reaches back to the removal it is dead weight. Entries leave in removal
 * order, which makes the last dropped `gone` the newest dropped seq — the archive floor.
 */
function pruneArchive(state: TimelineState, bounds: FoldBounds): void {
  if (state.archived.length === 0) return
  let drop = 0
  const oldestRetained = state.requests.length > 0 ? state.requests[0].seq : undefined
  if (oldestRetained !== undefined) {
    // A restored legacy entry without `gone` is never dropped by the request window.
    while (drop < state.archived.length && (state.archived[drop].gone ?? Infinity) <= oldestRetained) drop++
  }
  if (state.archived.length - drop > bounds.maxArchiveNodes) {
    drop = state.archived.length - bounds.maxArchiveNodes
  }
  if (drop === 0) return
  const floor = state.archived[drop - 1].gone
  if (floor !== undefined) state.archiveFloor = Math.max(state.archiveFloor ?? 0, floor)
  state.archived = state.archived.slice(drop)
}
