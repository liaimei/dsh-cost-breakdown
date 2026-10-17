/**
 * The timeline reducer: one durable session event into the next {@link TimelineState}.
 *
 * Two contractual properties drive the whole shape of this module.
 *
 * **Reference discipline.** The registry gates change propagation on `Object.is`, so an event the
 * fold does not care about *must* return the persisted state unchanged. Every handler therefore runs
 * against a {@link FoldDraft}: a private shallow copy whose touched containers are cloned lazily.
 * A handler that decides it is uninterested simply never touches anything, and the draft is
 * discarded.
 *
 * **All-or-nothing.** The registry drives `apply` with no error boundary, so one throw would stall
 * this unit's feed forever and leave the browser on "loading". The whole dispatch therefore runs
 * inside one try/catch: a malformed event is discarded **entirely** (its partial edits only ever
 * landed on the private draft) and the previous reference is returned.
 *
 * Handlers are split per event family so each one reads as the rule list it implements; the
 * {@link HANDLERS} table is the dispatch.
 */

import { estimateSystemBlocks, estimateTools, firstRawText, isInjection, skillNameOf } from '../../core/tokens'
import type { MessageSource } from '../../core/tokens'
import { needsRawArgs, opsOfCall, parseCallArgs } from '../../core/ops'
import type { FileOp, SurfaceEntry } from '../../wire/model'
import type { FoldBounds } from '../settings'
import { bookSettlement, ensureTiming, settlementOf } from './metering'
import {
  answeredCallIdOf, compactionEventOf, injectionEventOf, isRecord, messageOf,
  modelSwitchEventOf, modeEventOf, requestRecordOf, skillLoadEventOf, surfaceMessageOf,
} from './records'
import {
  buildSurfaceNode, placeNode, producerLabelOf, pushSystemNode, removeSurfaceInRange,
  removeSystemInRange,
} from './surface'
import {
  applyMessageTiming, armApproval, closeStep, openStep, recordAnswerWait, recordToolRun,
  settleApproval, stampAttempt, ANSWER_TOOL,
} from './timing'
import type { FoldDraft, PendingCall, TimelineEvent, TimelineState } from './state'
import {
  countTurnRuns, draftOf, PENDING_CODE_OPS_MAX, pruneTimeline,
} from './state'
import type { decodeTallyOfStream } from './streams'

/** How one handler reports its outcome. */
type HandlerOutcome = 'changed' | 'ignored'

/** One event family's fold rule. */
type Handler = (draft: FoldDraft, event: TimelineEvent, bounds: FoldBounds) => HandlerOutcome

/** Mark the detail collections dirty: only folds that change a *served* collection call this. */
function bumpDetailRev(draft: FoldDraft): void {
  draft.next.detailRev = (draft.previous.detailRev ?? 0) + 1
}

/** Stringify an unknown argument payload; a circular value yields no arguments at all. */
function rawArgumentsOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** Append operations to the served log (the retention pass maintains `fileOpsFloor`). */
function appendFileOps(draft: FoldDraft, ops: readonly FileOp[]): void {
  for (const op of ops) draft.next.fileOps.push(op)
}

/**
 * Buffer nested Code-Mode operations under their root call id.
 *
 * A dispatch that is never settled by its parent must not be able to grow the state, so a batch that
 * would exceed the cap is dropped whole rather than partially adopted.
 */
function bufferCodeOps(draft: FoldDraft, rootCallId: string, ops: readonly FileOp[]): void {
  const pending = draft.previous.pendingCodeOps ?? {}
  let total = 0
  for (const key of Object.keys(pending)) total += pending[key].length
  if (total + ops.length > PENDING_CODE_OPS_MAX) return
  draft.next.pendingCodeOps = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), ...ops] }
}

// ---------------------------------------------------------------------------
// request/header
// ---------------------------------------------------------------------------

/**
 * A request header carries the tool list and the route for the *next* request.
 *
 * The model switch itself has no event in the log: it is a header whose model differs from the
 * previous one while the producer says `change` (a later request used a different header) or
 * `resume` (a new loop instance over an existing log). `initial` opens a session and `series` marks
 * a new message series — neither is a switch.
 */
const reduceHeader: Handler = (draft, event) => {
  const data = event.data
  const header = isRecord(data?.header) ? data.header : {}
  const tools = Array.isArray(header.tools) ? header.tools : []
  draft.touch('events')
  // The whole tool array prices as one JSON blob, matching the harness token meter.
  draft.next.toolsTokens = estimateTools(tools)
  const config = isRecord(header.config) ? header.config : undefined
  if (typeof config?.model === 'string') draft.next.model = config.model
  if (typeof config?.provider === 'string') draft.next.provider = config.provider

  const reason = data?.reason
  const previousModel = draft.previous.lastModel
  const model = draft.next.model
  if ((reason === 'change' || reason === 'resume')
    && model !== undefined && previousModel !== undefined && model !== previousModel) {
    draft.next.events.push(modelSwitchEventOf(event, previousModel, model))
    bumpDetailRev(draft)
  }
  if (model !== undefined) draft.next.lastModel = model
  return 'changed'
}

// ---------------------------------------------------------------------------
// request/context
// ---------------------------------------------------------------------------

/**
 * Route metadata for the next request: capacity and route only.
 *
 * Logged when the route, the capacity or the system-prompt update mode changes, so it updates the
 * envelope scalars but never produces a model-switch row.
 */
const reduceContext: Handler = (draft, event) => {
  const data = event.data
  draft.touch()
  if (typeof data?.contextWindow === 'number') draft.next.contextWindow = data.contextWindow
  if (typeof data?.model === 'string') draft.next.model = data.model
  if (typeof data?.provider === 'string') draft.next.provider = data.provider
  return 'changed'
}

// ---------------------------------------------------------------------------
// system/message
// ---------------------------------------------------------------------------

/**
 * The system prompt is a surface node in the harness's own ordered surface, but it is deliberately
 * outside this fold's stages: it prices `systemTokens`, the envelope figure a request total reads,
 * and putting it in `surface`/`sums` would double-count it.
 */
const reduceSystem: Handler = (draft, event) => {
  draft.touch('surface', 'sums', 'archived')
  // A system node settling here expires any armed shadow claim: the claim belonged to a
  // replacement that is not coming, and a stale claim would delete nodes later.
  delete draft.next.pendingShadowedSeqs
  delete draft.next.pendingShadowEventSeq
  removeSystemInRange(draft, event)
  // Defensive: dsh never claims ordinary surface nodes here, but removing them keeps `surface` and
  // `sums` consistent if a hostile log does.
  if (removeSurfaceInRange(draft, event) > 0) bumpDetailRev(draft)
  const message = messageOf(event)
  pushSystemNode(draft, {
    seq: event.seq,
    time: event.time,
    tokens: estimateSystemBlocks(message?.content),
  })
  return 'changed'
}

// ---------------------------------------------------------------------------
// tool/call and tool/ptc-dispatch
// ---------------------------------------------------------------------------

/**
 * Arm the call ledger so the matching result can name its tool and price its run.
 *
 * Raw arguments are kept only for tools whose arguments the fold actually reads (file tools and
 * `run_code`), which keeps huge shell payloads out of the persisted state.
 */
const reduceToolCall: Handler = (draft, event) => {
  const data = event.data
  const callId = data?.callId
  const name = data?.name
  if (typeof callId !== 'string' || typeof name !== 'string') return 'ignored'
  draft.touch('callNames')
  const argsRaw = needsRawArgs(name) ? rawArgumentsOf(data?.arguments) : undefined
  const entry: PendingCall = { name, start: event.time }
  if (argsRaw !== undefined) entry.argsRaw = argsRaw
  draft.next.callNames[callId] = entry
  return 'changed'
}

/**
 * A nested Code-Mode dispatch settling inside a `run_code` program.
 *
 * These arrive before their root call settles and carry no result meta, so their read windows and
 * per-file search attribution fall back to the call arguments. They buffer by root call id and are
 * flushed when that result lands, anchored to the result's own seq.
 */
const reduceCodeDispatch: Handler = (draft, event) => {
  const data = event.data
  const rootCallId = data?.rootCallId
  const name = data?.name
  if (typeof rootCallId !== 'string' || typeof name !== 'string') return 'ignored'
  // Same gate as `tool/call`, minus the `run_code` branch: a nested dispatch is never a root.
  const argsRaw = needsRawArgs(name) ? rawArgumentsOf(data?.arguments) : undefined
  const ops = opsOfCall({
    seq: event.seq,
    time: event.time,
    tool: name,
    argsRaw,
    err: data?.isError === true,
  })
  if (ops.length === 0) return 'ignored'
  draft.touch()
  bufferCodeOps(draft, rootCallId, ops)
  return 'changed'
}

// ---------------------------------------------------------------------------
// step lifecycle and approvals
// ---------------------------------------------------------------------------

/** Open a step, superseding any stale slot from an unpaired predecessor. */
const reduceStepStart: Handler = (draft, event) => {
  draft.touch()
  openStep(draft, event)
  return 'changed'
}

/**
 * Close the step: wall/active time, the span flush, and the working-slot cleanup.
 *
 * Nothing in the outer envelope changed and no working slot did either — an unpaired `step/end`
 * must leave the state reference untouched.
 */
const reduceStepEnd: Handler = (draft, event) => {
  if (draft.previous.stepStart === undefined) return 'ignored'
  // `timing` is created here, so it must be cloned; `requests` only when a stamp target is armed.
  const clones: ('timing' | 'requests')[] = draft.previous.stepRequestSeq === undefined
    ? ['timing']
    : ['timing', 'requests']
  draft.touch(...clones)
  closeStep(draft, event)
  bumpDetailRev(draft)
  return 'changed'
}

/** Arm a pending approval wait. A question outside a step prices nothing. */
const reduceApprovalAsked: Handler = (draft, event) => {
  if (!armApproval(draft, event.data?.id, event.time)) return 'ignored'
  draft.touch()
  return 'changed'
}

/** Close an answered approval into a user wait. An unmatched decision prices nothing. */
const reduceApprovalDecided: Handler = (draft, event) => {
  if (!settleApproval(draft, event.data?.id, event.time)) return 'ignored'
  draft.touch()
  return 'changed'
}

/** Stamp the open step with the first token an attempt observed. */
const reduceAttempt: Handler = (draft, event) => {
  if (!stampAttempt(draft, event.data?.stream)) return 'ignored'
  draft.touch()
  return 'changed'
}

// ---------------------------------------------------------------------------
// user/message and developer/message
// ---------------------------------------------------------------------------

/**
 * A user message is either a human input or an injected context block; the source decides which,
 * and a skill invocation or catalog digest gets its own stage so it is billed and displayed
 * separately from ordinary injection.
 */
const reduceUserMessage: Handler = (draft, event) => {
  const message = surfaceMessageOf(event)
  if (message === null) return 'ignored'
  draft.touch('surface', 'sums', 'archived', 'events')
  bumpDetailRev(draft)
  const node = buildSurfaceNode(event, event.type, message)
  placeNode(draft, event, node)
  if (isInjection(message.source)) {
    draft.next.events.push(injectionEventOf(event, node.tokens, message.source))
    stampProducer(node, message.source)
  } else {
    draft.next.humanInputs = (draft.next.humanInputs ?? 0) + 1
    // Last textual message wins: an image-only input keeps the previous line.
    if (node.text !== undefined && node.text !== '') draft.next.lastUser = node.text
  }
  return 'changed'
}

/**
 * A developer message is always an injection: the agent loop logs these when the effective tool
 * registry changes, and the model sees them. An empty one still keeps its surface position (priced
 * 0), which is why it is not skipped.
 */
const reduceDeveloperMessage: Handler = (draft, event) => {
  const message = messageOf(event)
  if (message === null || !Array.isArray(message.content)) return 'ignored'
  draft.touch('surface', 'sums', 'archived', 'events')
  bumpDetailRev(draft)
  const node = buildSurfaceNode(event, event.type, message)
  placeNode(draft, event, node)
  draft.next.events.push(injectionEventOf(event, node.tokens, message.source))
  stampProducer(node, message.source)
  return 'changed'
}

/**
 * Stamp the producer label on both the surface node and (implicitly) its event row, so the browser
 * shows the same identity in the row list and the surface tree.
 *
 * Skill invocations are skipped: their `skill` field already names them, and a second label would
 * show two different names for one row.
 */
function stampProducer(node: SurfaceEntry, source: MessageSource | undefined): void {
  if (source?.kind === 'skill-invocation') return
  const label = producerLabelOf(source)
  if (label !== '') node.name = label
}

// ---------------------------------------------------------------------------
// tool/result
// ---------------------------------------------------------------------------

/**
 * A settled tool call.
 *
 * Ordering is load-bearing. The pending call and any buffered Code-Mode operations are read from
 * the **previous** state before the surface placement consumes the call ledger; the request node is
 * placed before the file-op flush so the flush can anchor nested operations to this result's seq.
 */
const reduceToolResult: Handler = (draft, event) => {
  const message = surfaceMessageOf(event)
  if (message === null) return 'ignored'
  const callId = answeredCallIdOf(message)
  const pending = callId !== undefined ? draft.previous.callNames[callId] : undefined
  const buffered = callId !== undefined ? draft.previous.pendingCodeOps?.[callId] : undefined
  const data = event.data

  draft.touch('surface', 'sums', 'archived', 'events', 'fileOps', 'timing')
  bumpDetailRev(draft)
  const node = buildSurfaceNode(event, event.type, message, { tool: pending?.name })
  consumeCall(draft, callId)
  placeNode(draft, event, node)
  stampProducer(node, message.source)

  // An answered question *is* a human input, and its whole tool window is user wait time.
  if (node.tool === ANSWER_TOOL) {
    draft.next.humanInputs = (draft.next.humanInputs ?? 0) + 1
  }
  if (pending?.name === ANSWER_TOOL) recordAnswerWait(draft, pending.start, event.time)

  if (pending !== undefined) {
    const timing = ensureTiming(draft.next)
    recordToolRun(draft, timing, pending.name, pending.start, event.time)
    appendFileOps(draft, opsOfCall({
      seq: event.seq,
      time: event.time,
      tool: pending.name,
      argsRaw: pending.argsRaw,
      meta: data?.meta,
      err: message.isError === true,
    }))
  }
  flushCodeOps(draft, callId, buffered, pending, event.seq)

  retagSkillLoad(draft, event, node, message)
  return 'changed'
}

/** Consume the paired call entry, rebuilding the map without the used id. */
function consumeCall(draft: FoldDraft, callId: string | undefined): void {
  if (callId === undefined) return
  const kept: Record<string, PendingCall> = {}
  for (const key of Object.keys(draft.next.callNames)) {
    if (key !== callId) kept[key] = draft.next.callNames[key]
  }
  draft.next.callNames = kept
}

/**
 * Flush a settled `run_code` root call's buffered nested operations.
 *
 * Each carries the program description from the root call's arguments, so the file card can say
 * *what the model was trying to do* rather than just which files moved.
 */
function flushCodeOps(
  draft: FoldDraft,
  callId: string | undefined,
  buffered: readonly FileOp[] | undefined,
  pending: PendingCall | undefined,
  parentSeq: number,
): void {
  if (callId === undefined || buffered === undefined || buffered.length === 0) return
  const description = parseCallArgs(pending?.argsRaw)?.description
  const program = typeof description === 'string' && description !== '' ? description : undefined
  appendFileOps(draft, buffered.map(op => ({
    ...op,
    // The nesting anchor is the root call's own result row: the file card joins nested operations
    // to the `run_code` node they ran under.
    parent: parentSeq,
    ...(program !== undefined ? { program } : {}),
  })))
  const kept: Record<string, FileOp[]> = {}
  for (const key of Object.keys(draft.next.pendingCodeOps ?? {})) {
    if (key !== callId) kept[key] = (draft.next.pendingCodeOps ?? {})[key]
  }
  if (Object.keys(kept).length > 0) draft.next.pendingCodeOps = kept
  else delete draft.next.pendingCodeOps
}

/**
 * Re-bucket a `skill` tool result from `tool` to `skill`.
 *
 * The loaded skill's name is recovered from the rendered `<skill_content name="…">` wrapper rather
 * than from the call envelope, so a load still identifies itself when the `tool/call` event has
 * already scrolled out of a replay window. The wrapper alone is trusted here because a missed tag is
 * worse than a content-derived guess — and the activity ledger is the one that requires the pairing.
 */
function retagSkillLoad(draft: FoldDraft, event: TimelineEvent, node: SurfaceEntry, message: { content?: unknown }): void {
  if (node.tool !== 'skill' && node.tool !== undefined) return
  const name = skillNameOfIn(message)
  if (name === '') return
  node.skill = name
  if (node.tool === undefined) node.tool = 'skill'
  draft.next.sums.tool -= node.tokens
  node.cat = 'skill'
  draft.next.sums.skill += node.tokens
  draft.next.events.push(skillLoadEventOf(event, name, node.tokens))
}

/**
 * The skill name inside a loaded skill's rendered result text.
 *
 * The text must be read verbatim (no truncation, no whitespace collapsing) — the name lives inside
 * the raw `<skill_content name="…">` wrapper.
 */
function skillNameOfIn(message: { content?: unknown }): string {
  return skillNameOf(firstRawText(message.content))
}

// ---------------------------------------------------------------------------
// assistant/message
// ---------------------------------------------------------------------------

/**
 * A settled model call.
 *
 * The request record is built **before** the response joins the surface: it is a snapshot of the
 * request that went out, and `total` must describe the outbound composition rather than including
 * the reply's own tokens.
 */
const reduceAssistantMessage: Handler = (draft, event, bounds) => {
  const message = surfaceMessageOf(event)
  if (message === null) return 'ignored'
  const data = event.data
  draft.touch('surface', 'sums', 'archived', 'events', 'requests', 'timing')
  bumpDetailRev(draft)
  const record = requestRecordOf(event, draft.next)
  // `step/end` stamps this record's active time, so the slot must be armed while it is the tail.
  if (draft.previous.stepStart !== undefined) draft.next.stepRequestSeq = record.seq

  const settlement = settlementOf(data?.usage)
  if (settlement !== null) {
    record.prompt = settlement.prompt
    if (settlement.cacheRead !== null) record.cacheRead = settlement.cacheRead
    if (settlement.output !== null) record.output = settlement.output
    bookSettlement(draft.next, {
      time: event.time,
      provider: draft.next.provider ?? '',
      model: draft.next.model,
      holidays: bounds.holidays,
      turn: record.turn,
    }, settlement.buckets)
  }
  draft.next.requests.push(record)
  updateTurnRuns(draft, record)

  applyMessageTiming(draft, event, data?.stream, settlement?.output ?? null)

  const node = buildSurfaceNode(event, event.type, message)
  placeNode(draft, event, node)
  // Only a reply that actually says something counts; a tool-only dispatch does not.
  if (node.text !== undefined) draft.next.answers = (draft.next.answers ?? 0) + 1
  return 'changed'
}

/**
 * Maintain the incremental turn-run ledger.
 *
 * A run opens whenever the record's `turn` differs from the previous record's. A restored cache row
 * written before this field existed recomputes its base from a full scan once, which is why the
 * fallback is `countTurnRuns(previous.requests)` rather than zero.
 */
function updateTurnRuns(draft: FoldDraft, record: { turn?: number }): void {
  const base = draft.previous.turnRuns ?? countTurnRuns(draft.previous.requests)
  const last = draft.previous.requests.at(-1)
  const opened = last === undefined
    ? (record.turn !== undefined ? 1 : 0)
    : (record.turn === last.turn ? 0 : 1)
  draft.next.turnRuns = base + opened
}

// ---------------------------------------------------------------------------
// seed boundary, plan mode, compaction
// ---------------------------------------------------------------------------

/**
 * The fork/seed boundary.
 *
 * A *tagged* marker (`inherited: true`) means everything before it is a verbatim replay of the
 * parent log's prefix, whose settlements the parent already paid for. Clearing the cost ledgers
 * here keeps the child's totals to its own work. An untagged marker is an ordinary resume/replay
 * boundary and must leave the reference untouched — otherwise every resume would wipe history.
 */
const reduceSeedBoundary: Handler = (draft, event) => {
  if (event.data?.inherited !== true) return 'ignored'
  draft.touch()
  // `{}` rather than deletion: an absent ledger and an empty one mean different things to the head.
  draft.next.cost = {}
  draft.next.turnCost = {}
  return 'changed'
}

/** Plan mode adds guidance to every request while it is on, so the toggle is worth a row. */
const reducePlanMode: Handler = (draft, event) => {
  const active = event.data?.active
  if (typeof active !== 'boolean') return 'ignored'
  draft.touch('events')
  draft.next.events.push(modeEventOf(event, active))
  bumpDetailRev(draft)
  return 'changed'
}

/**
 * A compaction or prune.
 *
 * The following replacement declares exactly which nodes it shadows, so the event arms that claim
 * for the next surface event to consume. The recorded price is the producer's gross claim for now;
 * the replacement rewrites it to the net amount freed.
 */
const reduceCompaction: Handler = (draft, event) => {
  draft.touch('events')
  bumpDetailRev(draft)
  const data = event.data
  if (Array.isArray(data?.shadowedSeqs)) {
    draft.next.pendingShadowedSeqs = data.shadowedSeqs.filter((value): value is number => typeof value === 'number')
    draft.next.pendingShadowEventSeq = event.seq
  }
  draft.next.events.push(compactionEventOf(event, event.type === 'compaction/summary' ? 'compaction' : 'prune'))
  return 'changed'
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** The event-family dispatch table. Everything absent from it is not this fold's business. */
const HANDLERS: Readonly<Record<string, Handler>> = {
  'request/header': reduceHeader,
  'request/context': reduceContext,
  'system/message': reduceSystem,
  'tool/call': reduceToolCall,
  'tool/ptc-dispatch': reduceCodeDispatch,
  'assistant/attempt': reduceAttempt,
  'step/start': reduceStepStart,
  'step/end': reduceStepEnd,
  'approval/asked': reduceApprovalAsked,
  'approval/decided': reduceApprovalDecided,
  'user/message': reduceUserMessage,
  'developer/message': reduceDeveloperMessage,
  'tool/result': reduceToolResult,
  'assistant/message': reduceAssistantMessage,
  'session/end-seed': reduceSeedBoundary,
  'plan/mode': reducePlanMode,
  'compaction/summary': reduceCompaction,
  'compaction/prune': reduceCompaction,
}

/**
 * Fold one durable event into the next state.
 *
 * Never throws, never mutates the input, and returns the **same reference** when the event changes
 * nothing. That last property is not an optimization: the registry uses it to decide whether to
 * publish, and a spurious new reference would push a frame for every event in the log.
 */
export function reduceTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  const handler = HANDLERS[event.type]
  if (handler === undefined) return state
  const draft = draftOf(state)
  try {
    if (handler(draft, event, bounds) === 'ignored') return state
  } catch {
    // Unreachable for a well-formed log; the guard exists so a hostile one cannot take the unit
    // down. All partial edits landed on the private draft, so discarding it is a clean rollback.
    return state
  }
  pruneTimeline(draft.next, bounds)
  return draft.next
}

/** Decode tallies are re-exported for consumers that need the type without the module. */
export type { decodeTallyOfStream }
