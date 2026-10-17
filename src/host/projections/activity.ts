/**
 * The `contextActivity` projection unit — the per-local-day ledger behind the Insights heatmap and
 * the trailing-7-day chart.
 *
 * The timeline unit prices the *current* context; it cannot draw a per-day chart. This unit folds the
 * same committed event stream into a ledger keyed by the machine's local calendar day:
 *
 * - one completed settlement adds one request, its four billed buckets, and its priced buckets under
 *   `(provider, model, period)`;
 * - a settlement is attributed to the day the **open step started**, falling back to its own instant,
 *   and the peak/off-peak split uses the same instant — so a long request that crosses midnight lands
 *   on the day it began, matching what the user saw;
 * - skill loads are counted per day, from two distinct gestures (`/name` invocation envelopes and
 *   paired `skill` tool results).
 *
 * `stateVersion` is 6: the per-day pricing record moved to model-keyed peak/off-peak. Later events
 * cannot recompute already-folded days, so an upgrade discards the rows and the Insights prewarm
 * cold-folds them again.
 */

import { dayKeyOf } from '../../core/day'
import { skillNameOf } from '../../core/tokens'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ActivityLedger, BucketTotals, CostLedger, LedgerDay } from '../../wire/model'
import { activityStateSchema, activityViewSchema } from '../../wire/schema'
import { copyCostLedger } from '../../core/ledger'
import { bookUsage } from '../../core/ledger'
import { isRecord } from '../fold/records'
import { periodAt, settlementOf, settlementTokens } from '../fold/metering'
// Type-only side effect: installs this plugin's projection-key augmentation.
import type {} from './augment'

/** The projection key this unit owns. */
export const ACTIVITY_KEY = 'contextActivity' as const

/** Pinned at 6: per-day records changed their peak/off-peak rule. */
export const ACTIVITY_STATE_VERSION = 6

/** How many days to retain: a bit more than a year of an actively used session. */
export const ACTIVITY_MAX_DAYS = 400

/** Per-day skill-name cap; a hostile replay could otherwise add one name per injection. */
export const ACTIVITY_MAX_SKILLS = 100

/** How many dispatched `skill` calls may wait for their result. */
export const ACTIVITY_MAX_PENDING_CALLS = 100

/** The activity unit's persisted state: the day ledger plus the in-flight route and skill slots. */
export interface ActivityState {
  days: Record<string, LedgerDay>
  /** The route in force (the last header config wins); every settlement prices against it. */
  model?: string
  provider?: string
  /** The open step's start instant, armed by `step/start` and cleared by `step/end`. */
  stepStart?: number
  /**
   * Pending `skill` tool call ids awaiting their result.
   *
   * The pairing is the trust anchor for the tool-result path: a document that merely quotes a
   * `<skill_content name="…">` wrapper must not be booked as a load.
   */
  skillCalls?: string[]
}

/** Write one day's entry back into the ledger, evicting the oldest keys past the cap. */
function withDay(state: ActivityState, key: string, day: LedgerDay): ActivityState {
  let days: Record<string, LedgerDay> = { ...state.days, [key]: day }
  const keys = Object.keys(days)
  if (keys.length > ACTIVITY_MAX_DAYS) {
    // Day keys sort chronologically, so lexical order is the eviction order. The map is rebuilt
    // rather than `delete`d key by key: repeated deletes degrade the object into dictionary mode.
    keys.sort()
    const dropped = new Set(keys.slice(0, keys.length - ACTIVITY_MAX_DAYS))
    days = Object.fromEntries(Object.entries(days).filter(([entryKey]) => !dropped.has(entryKey)))
  }
  return { ...state, days }
}

/**
 * Book one skill load onto its day.
 *
 * The count increments and `last` takes the maximum, so a replay or an out-of-order fold cannot walk
 * a timestamp backwards. A day that already holds {@link ACTIVITY_MAX_SKILLS} distinct names keeps
 * counting the names it has but refuses new ones.
 */
function bookSkillLoad(state: ActivityState, name: string, time: number): ActivityState {
  const key = dayKeyOf(time)
  if (key === null) return state
  const previous = state.days[key]
  const existing = previous?.skills?.[name]
  if (existing === undefined
    && previous?.skills !== undefined
    && Object.keys(previous.skills).length >= ACTIVITY_MAX_SKILLS) return state
  const skills = {
    ...previous?.skills,
    [name]: {
      n: (existing?.n ?? 0) + 1,
      last: existing === undefined ? time : Math.max(existing.last, time),
    },
  }
  const day: LedgerDay = {
    tokens: previous?.tokens ?? 0,
    requests: previous?.requests ?? 0,
    ...(previous?.cost !== undefined ? { cost: previous.cost } : {}),
    skills,
  }
  return withDay(state, key, day)
}

/**
 * The skill name a `/name` invocation gesture carries.
 *
 * Only the durable `skill-invocation` envelope counts as an invocation; everything else reads as "no
 * load", because a user message quoting skill markup is not a load.
 */
function invokedSkillOf(event: SessionEvent): string {
  const data = event.data as { source?: unknown; message?: unknown } | null | undefined
  // A developer message nests the payload one level deeper than a user message does.
  const carrier = event.type === 'developer/message' ? data?.message : data
  if (!isRecord(carrier)) return ''
  const source = carrier.source
  if (!isRecord(source)) return ''
  return source.kind === 'skill-invocation' && typeof source.name === 'string' ? source.name : ''
}

/**
 * The call id a settled tool result answers.
 *
 * The top-level `toolCallId` is the canonical spelling; the durable source envelope's `callId` is the
 * fallback. Neither being a non-empty string means the result is unpaired, so it books no load.
 */
function resultCallIdOf(message: unknown): string | null {
  if (!isRecord(message)) return null
  if (typeof message.toolCallId === 'string' && message.toolCallId !== '') return message.toolCallId
  const source = message.source
  if (!isRecord(source)) return null
  const callId = source.callId
  return typeof callId === 'string' && callId !== '' ? callId : null
}

/** Book a priced settlement into a day's ledger, cloning only the touched path. */
function pricedDay(day: LedgerDay | undefined, key: string, state: ActivityState, initiated: number, buckets: BucketTotals, holidays: readonly string[]): ActivityState {
  let cost: CostLedger | undefined = day?.cost
  // A settlement without a known route still counts its tokens and requests; it is never priced by
  // a guessed model or provider.
  if (state.model !== undefined) {
    const provider = state.provider ?? ''
    cost = bookUsage(cost ?? {}, provider, state.model, periodAt(initiated, provider, state.model, holidays), buckets)
  }
  const entry: LedgerDay = {
    tokens: (day?.tokens ?? 0) + settlementTokens(buckets),
    requests: (day?.requests ?? 0) + 1,
    ...(cost !== undefined ? { cost } : {}),
    // The day's skill tally rides by reference; every mutation copies along its own path.
    ...(day?.skills !== undefined ? { skills: day.skills } : {}),
  }
  return withDay(state, key, entry)
}

/**
 * Fold one committed event into the ledger.
 *
 * Every path returns the **same reference** when nothing changed, which is what keeps the registry
 * from publishing a frame per event.
 */
export function reduceActivity(
  state: ActivityState,
  event: SessionEvent,
  holidays: readonly string[],
): ActivityState {
  switch (event.type) {
    case 'request/header': {
      const data = event.data as { header?: { config?: unknown } | null } | undefined
      const config = data?.header?.config
      if (!isRecord(config)) return state
      const model = typeof config.model === 'string' ? config.model : undefined
      const provider = typeof config.provider === 'string' ? config.provider : undefined
      const nextModel = model ?? state.model
      const nextProvider = provider ?? state.provider
      if (nextModel === state.model && nextProvider === state.provider) return state
      return {
        ...state,
        ...(nextModel !== undefined ? { model: nextModel } : {}),
        ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
      }
    }
    case 'step/start': {
      if (!Number.isFinite(event.time)) return state
      return state.stepStart === event.time ? state : { ...state, stepStart: event.time }
    }
    case 'step/end': {
      if (state.stepStart === undefined) return state
      // Delete rather than assign `undefined`: an own undefined property breaks the cache write.
      const next = { ...state }
      delete next.stepStart
      return next
    }
    case 'session/end-seed': {
      // A tagged fork/seed boundary: everything before it is the parent's inherited prefix, already
      // accounted on the parent. The route and step slots go with it, so an armed step inherited from
      // the parent cannot charge the child's first settlement to a parent day.
      if ((event.data as { inherited?: unknown } | undefined)?.inherited !== true) return state
      return { days: {} }
    }
    case 'user/message':
    case 'developer/message': {
      const name = invokedSkillOf(event)
      return name === '' ? state : bookSkillLoad(state, name, event.time)
    }
    case 'tool/call': {
      // Arm the pairing claim for a dispatched `skill` call; the result path only trusts the wrapper
      // underneath this claim.
      const data = event.data as { callId?: unknown; name?: unknown } | undefined
      const callId = data?.callId
      if (data?.name !== 'skill' || typeof callId !== 'string' || callId === '') return state
      const pending = state.skillCalls ?? []
      if (pending.includes(callId)) return state
      return { ...state, skillCalls: [...pending, callId].slice(-ACTIVITY_MAX_PENDING_CALLS) }
    }
    case 'tool/result': {
      // The model-driven load path: a `skill` tool result renders the instructions behind the
      // `<skill_content name="…">` wrapper. An unpaired result books nothing, and the claim is
      // consumed exactly once whether or not the wrapper is there.
      const message = (event.data as { message?: unknown } | undefined)?.message
      const callId = resultCallIdOf(message)
      const pending = state.skillCalls
      if (callId === null || pending === undefined || !pending.includes(callId)) return state
      const remaining = pending.filter(id => id !== callId)
      const next: ActivityState = { ...state }
      if (remaining.length > 0) next.skillCalls = remaining
      else delete next.skillCalls
      const name = skillNameOfIn(message)
      return name === '' ? next : bookSkillLoad(next, name, event.time)
    }
    case 'assistant/message': {
      // Attribute the settlement to the open step's start, so a request spanning midnight stays on
      // the day it began. The slot stays armed: a second settlement in the same step still reads it.
      const initiated = state.stepStart ?? event.time
      const key = dayKeyOf(initiated)
      if (key === null) return state
      const settlement = settlementOf((event.data as { usage?: unknown } | undefined)?.usage)
      const day = state.days[key]
      if (settlement === null) {
        // Still a completed request: tokens stay flat, but the request is counted.
        const entry: LedgerDay = {
          tokens: day?.tokens ?? 0,
          requests: (day?.requests ?? 0) + 1,
          ...(day?.cost !== undefined ? { cost: day.cost } : {}),
          ...(day?.skills !== undefined ? { skills: day.skills } : {}),
        }
        return withDay(state, key, entry)
      }
      return pricedDay(day, key, state, initiated, settlement.buckets, holidays)
    }
    default:
      return state
  }
}

/** The skill name inside a loaded skill's rendered result text (verbatim, never truncated). */
function skillNameOfIn(message: unknown): string {
  if (!isRecord(message) || !Array.isArray(message.content)) return ''
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string' || block.text === '') continue
    return skillNameOf(block.text)
  }
  return ''
}

/**
 * Build the unit.
 *
 * @param holidays - the resolved holiday table; a settlement's period split reads it, so it is
 *                   captured at construction like every other bound.
 */
export function createActivityUnit(
  holidays: readonly string[],
): ProjectionDefinition<typeof ACTIVITY_KEY, ActivityState> {
  return {
    key: ACTIVITY_KEY,
    stateSchema: activityStateSchema,
    init: () => ({ days: {} }),
    apply: (state: ActivityState, event: SessionEvent) => reduceActivity(state, event, holidays),
    wire: {
      viewSchema: activityViewSchema,
      // The view copies the ledger and every nested record, so neither the registry nor the cache
      // writer can mutate the fold's own rows; the fold itself copies along each mutated path.
      view: (state: ActivityState): ActivityLedger => ({
        days: Object.fromEntries(Object.entries(state.days).map(([key, day]) => [key, {
          ...day,
          // Conditional spreads: an own `undefined` property fails the lossless-JSON push.
          ...(day.cost !== undefined ? { cost: copyCostLedger(day.cost) } : {}),
          ...(day.skills !== undefined
            ? { skills: Object.fromEntries(Object.entries(day.skills).map(([name, tally]) => [name, { ...tally }])) }
            : {}),
        }])),
      }),
    },
    stateVersion: ACTIVITY_STATE_VERSION,
  }
}
