/// <reference types="node" />
/**
 * `POST /api/dsh-cost-breakdown/backfill` — the one-shot projection prewarm.
 *
 * The session list exposes only persisted cache rows, so a session folded before a unit existed
 * (or whose cached row predates the unit's `stateVersion`) has no usable row until it becomes
 * active again: the heatmap stays blank and cards keep their no-data hint. The cache's own cold
 * ladder (`sessionProjectionCache.coldSnapshot`) closes exactly that gap — read the stored log
 * once, seed the units from the cached rows, fold the remainder, write the refreshed checkpoints
 * back.
 *
 * The sweep runs when the client's Insights page first asks for it, **not at startup**: running
 * at boot would cold-read the whole corpus on every boot whether or not the page is ever opened.
 * It runs at most once per process and skips live sessions (they fold themselves, and a cold
 * write would race their own checkpoint).
 *
 * Contractually optional: a deployment without the connection route or the cold-path services
 * never arms the sweep. A log the harness refuses to migrate is a permanent source problem, so
 * its per-session detail drops to `debug` while the pass still ends with summary `info` lines.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ColdReadGate } from './cold'
import {
  type ConnectionFace,
  asRecord,
  messageOf,
  registerPostRoute,
  replyJson,
  routePath,
} from './router'

/** The prewarm trigger route, inside the authenticated `/api` fence. */
export const BACKFILL_ROUTE = routePath('backfill')

/** Every log line this plugin emits carries this prefix; only this module logs at all. */
const LOG_PREFIX = 'dsh-cost-breakdown:'

/** Throttle between sessions: each cold read decodes a whole log, and back-to-back reads under
 * sustained pressure would stall the host's own client handshake. */
const YIELD_MS = 100

/** The `name` family the persistence seam raises for a log it cannot explain. Matched by prefix so
 * no dsh error class has to be imported. */
const UNSUPPORTED_FORMAT = 'SessionFormatUnsupported'

/** The prewarm must leave these two units serviceable; both present means the session is folded. */
const PROBE_KEYS = ['contextActivity', 'contextTimeline'] as const

/** The corpus listing interface consumed here. */
interface SessionQueryFace {
  listSessions?(signal?: AbortSignal): Promise<unknown>
}

/** The two cold-path methods of the projection cache (re-verified at every use). */
interface ProjectionCacheFace {
  cachedSnapshot?(meta: unknown, keys?: readonly string[]): unknown
  coldSnapshot?(header: unknown, inheritedEventCount: unknown, events: readonly unknown[]): unknown
}

/** One persistence read handle. */
interface ReadHandleFace {
  header: unknown
  inheritedEventCount: unknown
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<unknown>
  close(): Promise<void>
}

/** The persistence read seam. */
interface PersistenceFace {
  open?(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleFace>
}

/** A durable session event, narrowed to what the cold fold and the tail repair read. */
interface DurableEvent {
  type?: unknown
  seq?: unknown
  time?: unknown
  data?: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: unknown
}

/** A session header, narrowed to the two identifiers this pass needs. */
interface HeaderFace {
  id: string
  cwd?: unknown
}

/**
 * Re-verify one list item as a session header; `null` drops the item, so a hostile or truncated
 * list row can never seed a read.
 */
function headerOf(record: unknown): HeaderFace | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header as unknown as HeaderFace
}

/** Whether the cache already serves both probe keys for this session — then both the hot path
 * and this sweep can skip it. A throwing probe reads as missing. */
function servesRows(cache: ProjectionCacheFace, header: HeaderFace): boolean {
  try {
    // An unseeded session has no inherited prefix (cut point 0); a seeded header's real cut is
    // only known while reading the log below, so this probe misses and the session takes the cold
    // path. Version-expired rows read as missing for the same reason.
    const block = asRecord(cache.cachedSnapshot?.(header, PROBE_KEYS))
    const values = asRecord(block?.values)
    return values !== null && values.contextActivity !== undefined && values.contextTimeline !== undefined
  } catch {
    return false
  }
}

/** Whether a session is live (it folds itself — a cold write would race its checkpoint). A
 * throwing registry skips conservatively: leave a row unfolded rather than overwrite a possibly
 * live session. */
function isLive(sessions: Record<string, unknown> | null, id: string): boolean {
  const get = sessions?.get
  if (typeof get !== 'function') return false
  try {
    return (get as (id: string) => unknown).call(sessions, id) !== undefined
  } catch {
    return true
  }
}

/** Whether a thrown error says the log format is unreadable (not migratable), matched by the
 * error's `name` prefix so no dsh error class is imported. */
function isUnsupportedFormat(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith(UNSUPPORTED_FORMAT)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------------- */
/* Tail repair: synthesise the closers of an interrupted turn                */
/* ------------------------------------------------------------------------- */

/**
 * Wording of the synthetic error tool results, keyed by whether the call start was recorded.
 * Copied from the harness's own crash-recovery repair so a folded interrupted log produces the
 * same transcript the harness would have produced on reload.
 */
const CLOSER_TEXT = {
  started: 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.',
  notStarted: 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.',
}

/** Recovery codes carried on the synthetic tool results, matching the harness's constants. */
const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'
const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/** One pending tool call inside the open tail turn. */
interface PendingCall {
  step: number
  callSeq?: number
}

/**
 * Synthesise the events that close an open tail turn, mirroring the harness's own
 * `interruptedTurnClosers`.
 *
 * This is a cold read of a log that may end mid-turn (a crash tail). Folding that log as-is
 * leaves the final turn open, so its settlement never books and the day's ledger under-counts.
 * The harness's repair path appends exactly these closers on reload; the sweep must do the same
 * before folding, or the prewarmed rows disagree with the rows the session will produce once it
 * is resumed.
 *
 * Shapes follow the durable dialect exactly: unmatched calls in the open step get synthetic error
 * results (in transcript order), then `step/end` if a step is open, then a `turn/end` carrying the
 * `interrupted` reason. Sequences continue the log and timestamps reuse the last real event, so
 * the synthesis is deterministic and never invents a future time. A balanced or empty log
 * produces nothing.
 *
 * @param events - the stored log, possibly ending inside an open turn.
 * @returns synthetic events to append, in order; empty when the log is already balanced.
 */
export function tailClosers(events: readonly DurableEvent[]): DurableEvent[] {
  let openTurn: number | null = null
  let openStep: number | null = null
  // Reset at each turn boundary so earlier calls cannot leak into the tail repair.
  const pending = new Map<string, PendingCall>()
  for (const event of events) {
    const data = asRecord(event.data)
    switch (event.type) {
      case 'turn/start':
        openTurn = typeof data?.turn === 'number' ? data.turn : null
        openStep = null
        pending.clear()
        break
      case 'turn/end':
        openTurn = null
        openStep = null
        pending.clear()
        break
      case 'step/start':
        openStep = typeof data?.step === 'number' ? data.step : null
        break
      case 'step/end':
        pending.clear()
        openStep = null
        break
      case 'assistant/message': {
        // The assistant message carries the tool-call blocks; each stays pending until a
        // `tool/result` with the same call id is logged.
        const content = asRecord(data?.message)?.content
        const step = typeof data?.step === 'number' ? data.step : null
        if (!Array.isArray(content) || step === null) break
        for (const block of content) {
          const record = asRecord(block)
          if (record?.type !== 'tool-call' || typeof record.id !== 'string') continue
          pending.set(record.id, { step })
        }
        break
      }
      case 'tool/call': {
        const callId = data?.callId
        if (typeof callId !== 'string') break
        const entry = pending.get(callId)
        // Cite the `tool/call` seq from the synthetic result.
        if (entry !== undefined && typeof event.seq === 'number') entry.callSeq = event.seq
        break
      }
      case 'tool/result': {
        const callId = asRecord(asRecord(data?.message)?.source)?.callId
        if (typeof callId === 'string') pending.delete(callId)
        break
      }
      default:
        break
    }
  }
  const last = events.at(-1)
  if (openTurn === null || last === undefined) return []
  let seq = typeof last.seq === 'number' ? last.seq + 1 : 0
  const time = typeof last.time === 'number' ? last.time : 0
  const closers: DurableEvent[] = []
  // Close calls before their step; Map insertion order preserves transcript order.
  for (const [callId, { step, callSeq }] of pending) {
    const started = callSeq !== undefined
    // The synthetic event's own seq; the message id embeds it, so a re-run over the same log
    // produces byte-identical closers.
    const eventSeq = seq++
    closers.push({
      type: 'tool/result',
      seq: eventSeq,
      time,
      data: {
        turn: openTurn,
        step,
        message: {
          id: `interrupted-tool-result-${callId}-${eventSeq}`,
          role: 'tool',
          toolCallId: callId,
          isError: true,
          source: { kind: 'tool', callId },
          content: [{ type: 'text', text: started ? CLOSER_TEXT.started : CLOSER_TEXT.notStarted }],
        },
        error: started
          ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
          : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
      },
      surfaceOp: 'append',
      ...started ? { sourceEventSeqs: [callSeq] } : {},
    })
  }
  // Close an open step before the turn: a `turn/end` while a step is open is an invariant
  // violation, so the step boundary must be synthesized first.
  if (openStep !== null) {
    closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } })
  }
  closers.push({ type: 'turn/end', seq: seq++, time, data: { turn: openTurn, reason: { kind: 'interrupted' } } })
  return closers
}

/* ------------------------------------------------------------------------- */
/* The sweep                                                                  */
/* ------------------------------------------------------------------------- */

/** One cold log read result; the handle's header is authoritative. */
interface ColdLog {
  header: unknown
  inheritedEventCount: unknown
  events: DurableEvent[]
}

/** Read one stored log through its handle, aligning with the harness's cold-session reader. */
async function readColdLog(persistence: PersistenceFace, id: string, signal: AbortSignal): Promise<ColdLog> {
  const open = persistence.open
  if (typeof open !== 'function') throw new Error('sessionPersistence.open is not callable')
  const handle = await open.call(persistence, id, 'read', { signal })
  let events: readonly DurableEvent[]
  try {
    const raw: unknown = await handle.read(0, undefined, { signal })
    // A hostile persistence result reads as an empty log, never as a throw.
    const result = asRecord(raw)?.events
    events = Array.isArray(result) ? result as DurableEvent[] : []
  } catch (error) {
    try {
      await handle.close()
    } catch {
      // The read failure is the one that matters.
    }
    throw error
  }
  await handle.close()
  return {
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    // The tail repair runs before the cache sees the events: an interrupted final turn must be
    // closed for the fold to settle it, exactly as a reload would.
    events: [...events, ...tailClosers(events)],
  }
}

/** Sleep one throttle interval. */
function yieldToHost(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, YIELD_MS))
}

/**
 * Arm the prewarm behind its trigger route. The route flips `requested` when the page first
 * opens; the runner sets `launch` once its four cold-path services exist. Whichever arrives
 * second starts the single pass.
 *
 * @returns a disposer that aborts both fibers (unloading the plugin cancels the sweep).
 */
export function watchActivityBackfill(ctx: Context, coldReads: ColdReadGate): () => void {
  let requested = false
  let started = false
  let launch: (() => void) | null = null
  const tryLaunch = (): void => {
    if (!requested || started || launch === null) return
    started = true
    launch()
  }

  const routeFiber = ctx.inject(['connection'], (c) => {
    const handler = (): Response => {
      requested = true
      tryLaunch()
      return replyJson({ ok: true })
    }
    registerPostRoute(
      c,
      c.get('connection') as ConnectionFace | undefined,
      BACKFILL_ROUTE,
      handler,
      'dsh-cost-breakdown: backfill route',
    )
  })

  const runnerFiber = ctx.inject(
    ['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'],
    (raw) => {
      const injected = raw as unknown as Record<string, unknown>
      const query = asRecord(injected.sessionQuery)
      const cache = asRecord(injected.sessionProjectionCache)
      const persistence = asRecord(injected.sessionPersistence)
      if (typeof query?.listSessions !== 'function') return
      if (typeof cache?.cachedSnapshot !== 'function' || typeof cache.coldSnapshot !== 'function') return
      if (typeof persistence?.open !== 'function') return
      const sessions = asRecord(injected.sessions)

      const abort = new AbortController()
      const run = async (): Promise<void> => {
        const listed = await (query as unknown as SessionQueryFace).listSessions?.(abort.signal)
        if (!Array.isArray(listed)) return
        let folded = 0
        let refused = 0
        let paused = false
        for (const record of listed) {
          if (abort.signal.aborted) return
          const header = headerOf(record)
          // A header without a workspace cannot address a session: skip it.
          if (header === null || typeof header.cwd !== 'string') continue
          if (isLive(sessions, header.id)) continue
          if (servesRows(cache as unknown as ProjectionCacheFace, header)) continue
          try {
            const admitted = await coldReads.admit(async () => {
              const log = await readColdLog(persistence as unknown as PersistenceFace, header.id, abort.signal)
              // The handle's header is authoritative (fixed when it was opened); the list row was
              // only the probe that got us here.
              ;(cache.coldSnapshot as (h: unknown, n: unknown, e: readonly unknown[]) => unknown)
                .call(cache, log.header, log.inheritedEventCount, log.events)
              return true
            })
            if (admitted === undefined) {
              // Pressure will not clear within one throttle interval; probing session by session
              // would only delay the host's own work.
              paused = true
              break
            }
            folded++
          } catch (error) {
            if (isUnsupportedFormat(error)) {
              // A permanent source problem: per-session detail drops to debug, and the summary
              // below is the only above-debug record of this pass.
              refused++
              ctx.logger.debug(`${LOG_PREFIX} projection backfill skipped "${header.id}" (${messageOf(error)})`)
            } else {
              ctx.logger.warn(`${LOG_PREFIX} projection backfill skipped "${header.id}" (${messageOf(error)})`)
            }
          }
          await yieldToHost()
        }
        if (folded > 0) ctx.logger.info(`${LOG_PREFIX} projection rows backfilled for ${folded} session(s)`)
        if (paused) {
          ctx.logger.info(`${LOG_PREFIX} projection backfill stopped early under heap pressure (remaining sessions refold on their next live activity)`)
        }
        if (refused > 0) {
          ctx.logger.info(`${LOG_PREFIX} projection backfill skipped ${refused} session(s) (legacy log format is not migratable; sources left unchanged)`)
        }
      }
      launch = () => {
        void run().catch((error: unknown) => {
          if (!abort.signal.aborted) {
            ctx.logger.warn(`${LOG_PREFIX} projection backfill stopped early (${messageOf(error)})`)
          }
        })
      }
      tryLaunch()
      return () => {
        abort.abort()
      }
    },
  )

  return () => {
    for (const fiber of [routeFiber, runnerFiber]) {
      const handle = fiber as unknown as { dispose?: () => unknown } | undefined
      void handle?.dispose?.()
    }
  }
}
