/**
 * Timing: the step lifecycle, user waits, the time strip's span painting, and the TTFT / decode
 * accounting.
 *
 * The model is a tiny state machine over the durable log:
 *
 * - `step/start` opens **one** slot (steps are sequential in a well-formed log; a hostile
 *   interleaved log just loses durations rather than corrupting anything).
 * - `assistant/message` prices the wait/generation split from the slot plus the embedded stream,
 *   and paints the model's own slices.
 * - `step/end` closes the slot: wall time, active time (wall minus the clamped union of user
 *   waits), and the final gapless tiling of the whole step window.
 *
 * Everything is measured from log timestamps, never from the clock, so the fold stays a pure
 * function of the log and a replay reproduces identical numbers.
 */

import type { TimingSegment, TimingTotals } from '../../wire/model'
import { addDecode, addToolTiming, DECODE_KINDS, durationBetween, ensureTiming } from './metering'
import type { FoldDraft, StepWait, TimelineEvent, TimelineState } from './state'
import { decodeSlicesOfStream, decodeTallyOfStream, firstTokenTimeOfStream } from './streams'

/** The tool whose settled result *is* the user's answer, and therefore a user wait. */
export const ANSWER_TOOL = 'ask_user_question'

/** Open a step: arm the slot and drop every working accumulator of a superseded step. */
export function openStep(draft: FoldDraft, event: TimelineEvent): void {
  draft.next.stepStart = { time: event.time }
  delete draft.next.stepSpans
  delete draft.next.stepWaits
  delete draft.next.stepApprovals
  delete draft.next.stepRequestSeq
}

/**
 * Record the first token an attempt observed.
 *
 * A model attempt that settles no surface message still embeds its stream, and the harness's own
 * stats fold lands its first token on the open step. Doing the same keeps a real TTFT across step
 * retries instead of dropping the whole wait into the card's residue bucket.
 *
 * @returns whether the slot was stamped (a caller that returns the same reference otherwise).
 */
export function stampAttempt(draft: FoldDraft, stream: unknown): boolean {
  const slot = draft.previous.stepStart
  if (slot === undefined || slot.firstToken !== undefined) return false
  const first = firstTokenTimeOfStream(stream)
  if (first === undefined) return false
  draft.next.stepStart = { time: slot.time, firstToken: first }
  return true
}

/** Arm a pending approval wait. Only a wait inside an open step can ever be priced. */
export function armApproval(draft: FoldDraft, id: unknown, time: number): boolean {
  if (draft.previous.stepStart === undefined || typeof id !== 'string') return false
  draft.next.stepApprovals = { ...draft.previous.stepApprovals, [id]: time }
  return true
}

/** Close an armed approval into a user wait covering `[asked, decided]`. */
export function settleApproval(draft: FoldDraft, id: unknown, time: number): boolean {
  const pending = draft.previous.stepApprovals
  const askedAt = typeof id === 'string' ? pending?.[id] : undefined
  if (pending === undefined || askedAt === undefined) return false
  draft.next.stepWaits = [...(draft.previous.stepWaits ?? []), { start: askedAt, end: time }]
  const kept: Record<string, number> = {}
  for (const key of Object.keys(pending)) {
    if (key !== id) kept[key] = pending[key]
  }
  if (Object.keys(kept).length > 0) draft.next.stepApprovals = kept
  else delete draft.next.stepApprovals
  return true
}

/** Record the whole window of an answered question as one user wait. */
export function recordAnswerWait(draft: FoldDraft, start: number, end: number): void {
  if (draft.previous.stepStart === undefined) return
  draft.next.stepWaits = [...(draft.previous.stepWaits ?? []), { start, end }]
}

/**
 * Close the open step.
 *
 * @returns whether there was a step to close at all (an unpaired `step/end` is uninteresting and
 *          must leave the state reference untouched).
 */
export function closeStep(draft: FoldDraft, event: TimelineEvent): boolean {
  const slot = draft.previous.stepStart
  if (slot === undefined) return false
  const end = event.time
  const timing = ensureTiming(draft.next)
  const wall = durationBetween(slot.time, end)
  timing.wallMs += wall

  const activeMs = wall - clampedWaitMs(draft.previous, slot.time, end)
  stampActiveTime(draft, activeMs)
  flushSpans(draft, slot.time, end)

  // Delete the working slots; an own `undefined` property would break the cache write.
  delete draft.next.stepStart
  delete draft.next.stepSpans
  delete draft.next.stepWaits
  delete draft.next.stepApprovals
  delete draft.next.stepRequestSeq
  return true
}

/**
 * The total user-wait milliseconds inside `[start, end]`.
 *
 * Closed waits and still-pending approvals are merged as a **clamped union**: two waits that overlap
 * (a parallel question and an approval, say) must be subtracted once, not twice, or active time
 * could go negative. Sorting by `(start, end)` and walking a cursor left-to-right does exactly that.
 */
function clampedWaitMs(state: TimelineState, start: number, end: number): number {
  const waits: StepWait[] = [...(state.stepWaits ?? [])]
  // A crashed decision leaves its pair dangling; closing it at the step's own instant is the only
  // defensible reading, and it keeps the window from being charged as active work.
  const pending = state.stepApprovals
  if (pending !== undefined) {
    for (const id of Object.keys(pending)) waits.push({ start: pending[id], end })
  }
  waits.sort((left, right) => (left.start - right.start) || (left.end - right.end))
  let total = 0
  let cursor = start
  for (const wait of waits) {
    const from = Math.max(cursor, wait.start)
    const to = Math.min(wait.end, end)
    if (to > from) {
      total += to - from
      cursor = to
    }
  }
  return total
}

/**
 * Stamp the step's active time onto the request record it submitted.
 *
 * The guard is the record's seq: a hostile refold that lost that row simply skips the stamp instead
 * of writing onto whatever record happens to be last.
 */
function stampActiveTime(draft: FoldDraft, activeMs: number): void {
  const targetSeq = draft.previous.stepRequestSeq
  if (targetSeq === undefined) return
  const requests = draft.next.requests
  const last = requests.at(-1)
  if (last === undefined || last.seq !== targetSeq) return
  requests[requests.length - 1] = { ...last, activeMs }
}

/**
 * Paint the step window and flush it onto `spans`.
 *
 * Slices are clamped to the step window, sorted, then merged **first-come-wins**: overlapping
 * slices (parallel tool runs) paint their union once rather than double-counting wall time. Every
 * leftover hole is filled with `other`, so the flushed run always tiles `[start, end]` gaplessly.
 * A zero-width step (a hostile timestamp) flushes nothing at all.
 */
function flushSpans(draft: FoldDraft, start: number, end: number): void {
  const painted: TimingSegment[] = []
  for (const span of draft.previous.stepSpans ?? []) {
    const from = Math.max(start, span.start)
    const to = Math.min(end, span.end)
    if (to > from) painted.push({ kind: span.kind, start: from, end: to })
  }
  painted.sort((left, right) => (left.start - right.start) || (left.end - right.end))
  const flushed: TimingSegment[] = [...draft.previous.spans]
  let cursor = start
  for (const span of painted) {
    const from = Math.max(cursor, span.start)
    if (span.end <= from) continue
    if (from > cursor) flushed.push({ kind: 'other', start: cursor, end: from })
    flushed.push({ kind: span.kind, start: from, end: span.end })
    cursor = span.end
  }
  if (end > cursor) flushed.push({ kind: 'other', start: cursor, end })
  draft.next.spans = flushed
}

/** The decode anchors one assistant message contributes to the open step. */
interface DecodeWindow {
  /** The earliest observable instant: the first token, or the earliest block marker before it. */
  start: number
  /** The ordered decode slices to paint. */
  slices: { kind: TimingSegment['kind']; start: number; end: number }[]
  /** The per-bucket span/block tallies. */
  tally: ReturnType<typeof decodeTallyOfStream>
}

/**
 * Resolve where the wait ends and generation begins.
 *
 * The boundary is the first **observable** instant, which is sometimes a block marker rather than a
 * token: a fully redacted reasoning block leaves a marker but no chunk, and anchoring on the token
 * would charge that interval to the wait *and* to the reasoning row, doubling it past 100 %.
 */
function decodeWindowOf(stream: unknown, endTime: number, firstToken: number | undefined): DecodeWindow | null {
  if (firstToken === undefined) return null
  const slices = decodeSlicesOfStream(stream, endTime)
  let start = firstToken
  for (const slice of slices) start = Math.min(start, slice.start)
  return { start, slices, tally: decodeTallyOfStream(stream, endTime) }
}

/**
 * Price the wait/generation split of the open step from the message's embedded stream, and paint
 * the model's own slices.
 *
 * `usage` output is `null` when the provider reported no readable output bucket; the throughput
 * pair then stays absent rather than reporting tokens per second of nothing.
 */
export function applyMessageTiming(
  draft: FoldDraft,
  event: TimelineEvent,
  stream: unknown,
  outputTokens: number | null,
): void {
  const timing = ensureTiming(draft.next)
  timing.calls += 1
  const slot = draft.previous.stepStart
  if (slot === undefined) return
  const firstToken = slot.firstToken ?? firstTokenTimeOfStream(stream)
  const window = decodeWindowOf(stream, event.time, firstToken)
  // A stream with no token at all (an aborted step) is not attributable: leave it to the residue.
  if (window === null || firstToken === undefined) return

  timing.ttftMs += durationBetween(slot.time, window.start)
  timing.genMs += durationBetween(window.start, event.time)
  // The strip's model slices: the silent wait first, then the decode blocks in stream order, all
  // measured from the same boundary so the rows, the donut and the strip read one window.
  const modelSpans: TimingSegment[] = [{ kind: 'ttft', start: slot.time, end: window.start }]
  for (const slice of window.slices) {
    const to = Math.min(event.time, slice.end)
    if (to <= slice.start) continue
    const from = modelSpans.length === 1 ? window.start : slice.start
    modelSpans.push({ kind: slice.kind, start: from, end: to })
  }
  draft.next.stepSpans = [...(draft.previous.stepSpans ?? []), ...modelSpans]

  // Throughput is only priced when both halves are known, matching the harness's own stats fold.
  if (outputTokens !== null) {
    timing.speedMs = (timing.speedMs ?? 0) + durationBetween(firstToken, event.time)
    timing.speedTokens = (timing.speedTokens ?? 0) + outputTokens
  }
  for (const kind of DECODE_KINDS) addDecode(timing, kind, window.tally.spans[kind], window.tally.blocks[kind])
}

/**
 * Paint one settled tool call's run window.
 *
 * The duration always lands in the totals (an unclaimed window still happened); the slice is only
 * painted when an open step can own it, because the strip draws step-internal time only.
 */
export function recordToolRun(draft: FoldDraft, timing: TimingTotals, name: string, start: number, end: number): void {
  const duration = durationBetween(start, end)
  timing.toolsMs += duration
  timing.toolCalls += 1
  addToolTiming(timing, name, duration)
  if (draft.previous.stepStart !== undefined) {
    draft.next.stepSpans = [...(draft.previous.stepSpans ?? []), { kind: 'tools', start, end }]
  }
}

/** Re-exported so the reducer's `tool/result` handler imports one timing surface. */
export { addToolTiming } from './metering'
