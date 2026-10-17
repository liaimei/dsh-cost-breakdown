/**
 * Reading the durable message events into one narrow shape, and building the ledger rows they
 * produce.
 *
 * The fold reads message payloads out of three different shapes depending on the event family
 * (`user/message` carries the message as its own payload; every other message event nests it under
 * `data.message`). Centralising that here means the surface, timing and activity paths all price the
 * same message the same way.
 *
 * The narrow type also documents what the fold is allowed to trust: nothing. The durable log is
 * untrusted input, so every field is re-proved where it is used and a malformed shape degrades to
 * "no message" rather than an exception.
 */

import type { ContentBlock, MessageSource } from '../../core/tokens'
import { injectionLabel } from '../../core/tokens'
import type { LedgerEvent, RequestRow } from '../../wire/model'
import type { StageTotals, TimelineEvent } from './state'

/** A message payload as the fold reads it. Every member is untrusted. */
export interface SurfaceMessage {
  content?: ContentBlock[]
  source?: MessageSource
  /** V4 spelling of a failed tool result. Only accepted together with the message itself. */
  isError?: unknown
  /** The call id a tool result answers; the pairing key for the tool lifecycle. */
  toolCallId?: unknown
}

/** Whether a value is a non-array object — the shape every payload read here requires. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The message payload of one durable event, or `null` when the event carries none it can read.
 *
 * A missing message is not an error: the fold's callers decide whether that means "skip this
 * event" or "this node projects nothing".
 */
export function messageOf(event: TimelineEvent): SurfaceMessage | null {
  const data = event.data
  if (data === undefined) return null
  switch (event.type) {
    case 'user/message':
      // A user message *is* the payload; there is no nesting level to unwrap.
      return isRecord(data) ? data as SurfaceMessage : null
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
    case 'tool/result': {
      const message = data.message
      return isRecord(message) ? message as SurfaceMessage : null
    }
    default:
      return null
  }
}

/** The message a surface-bearing event must carry to produce a node, or `null` when it cannot. */
export function surfaceMessageOf(event: TimelineEvent): SurfaceMessage | null {
  const message = messageOf(event)
  if (message === null) return null
  // Every surface event projects a model message from its content array; a payload without one is a
  // hostile row, and the fold skips it rather than deriving an empty message from nothing.
  if (!Array.isArray(message.content)) return null
  return message
}

/** The call id a tool result answers, when the durable source carries a non-empty string. */
export function answeredCallIdOf(message: SurfaceMessage | null): string | undefined {
  const source = message?.source as { callId?: unknown } | undefined
  const callId = source?.callId
  return typeof callId === 'string' && callId !== '' ? callId : undefined
}

/**
 * Build the request record one assistant message settles.
 *
 * The record is a snapshot of the *request* that went out, so the caller must build it **before**
 * the response node reaches the surface — that ordering is what makes `total` describe the outbound
 * composition rather than the response's own contribution.
 */
export function requestRecordOf(
  event: TimelineEvent,
  state: { systemTokens: number, toolsTokens: number, sums: StageTotals },
): RequestRow {
  const sums = state.sums
  const record: RequestRow = {
    time: event.time,
    seq: event.seq,
    system: state.systemTokens,
    tools: state.toolsTokens,
    user: sums.user,
    inject: sums.inject,
    skill: sums.skill,
    assistant: sums.assistant,
    tool: sums.tool,
    total: state.systemTokens + state.toolsTokens
      + sums.user + sums.inject + sums.skill + sums.assistant + sums.tool,
  }
  // Only real numbers are written: an absent `turn`/`step` must stay ABSENT, never become an
  // `undefined`-valued property (that fails every projection-cache write for the session).
  const turn = event.data?.turn
  if (typeof turn === 'number') record.turn = turn
  const step = event.data?.step
  if (typeof step === 'number') record.step = step
  return record
}

/**
 * The `inject` row an injected message contributes to the timeline.
 *
 * `form` is re-proved because the harness validates a source's `kind` but not its `form`; a hostile
 * non-string would otherwise ride the record into the strict wire schema on every delivery.
 */
export function injectionEventOf(event: TimelineEvent, tokens: number, source: MessageSource | undefined): LedgerEvent {
  const form = typeof source?.form === 'string' && source.form !== '' ? source.form : 'context'
  const record: LedgerEvent = { seq: event.seq, time: event.time, kind: 'inject', form, tokens }
  if (source?.kind === 'skill-invocation') {
    record.sub = 'skill'
    record.name = typeof source.name === 'string' ? source.name : '?'
    return record
  }
  const label = injectionLabel(source)
  if (label !== '') record.name = label
  const summary = source?.summary
  if (source?.form === 'notice' && typeof summary === 'string' && summary !== '') {
    record.detail = summary
  }
  return record
}

/** The `model` row a genuine model switch contributes. */
export function modelSwitchEventOf(event: TimelineEvent, from: string, to: string): LedgerEvent {
  return { seq: event.seq, time: event.time, kind: 'model', from, to }
}

/** The `mode` row of a plan-mode toggle. */
export function modeEventOf(event: TimelineEvent, active: boolean): LedgerEvent {
  return { seq: event.seq, time: event.time, kind: 'mode', name: active ? 'plan.on' : 'plan.off' }
}

/**
 * The `compaction` / `prune` row of a metering event.
 *
 * The recorded token count is the producer's *gross* shadow price; the replacement that follows
 * rewrites it to the net freed amount, so the row agrees with the drop the trend chart draws.
 */
export function compactionEventOf(event: TimelineEvent, kind: 'compaction' | 'prune'): LedgerEvent {
  const data = event.data
  const record: LedgerEvent = {
    seq: event.seq,
    time: event.time,
    kind,
    tokens: typeof data?.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
  }
  // The count mirrors the durable array verbatim (including entries the claim filter rejects): the
  // row reports what the producer claimed, not what the fold managed to use.
  if (kind === 'compaction' && Array.isArray(data?.shadowedSeqs)) {
    record.count = data.shadowedSeqs.length
  }
  return record
}

/** The `inject` row a skill load contributes once its wrapper names the skill. */
export function skillLoadEventOf(event: TimelineEvent, name: string, tokens: number): LedgerEvent {
  return {
    seq: event.seq,
    time: event.time,
    kind: 'inject',
    form: 'instructions',
    sub: 'skill',
    name,
    tokens,
  }
}
