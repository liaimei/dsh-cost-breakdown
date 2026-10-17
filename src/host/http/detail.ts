/// <reference types="node" />
/**
 * `POST /api/dsh-cost-breakdown/detail` — the on-demand heavy collections.
 *
 * The timeline projection's wire value is a slim head (envelope scalars plus counters); the
 * heavy collections are served here instead, per viewing client, and only while its Context tab
 * or the `/context` modal is open. That keeps a full surface tree off every `session.list` row
 * and off every pushed frame.
 *
 * Two resolutions, in order:
 * 1. **Live session** — read the registry's current fold state directly
 *    (`sessionProjections.stateOf`). No second fold, and the state is never mutated.
 * 2. **Cold session** — observe its immutable log through `sessionQuery`, fold from an empty
 *    state, and always dispose the observation. The read runs through the shared cold-read gate
 *    because it materialises the whole log; a gate refusal answers the same typed `null` as "this
 *    session cannot be observed".
 *
 * The route is armed lazily on `connection` + `sessions`, so mount order does not matter. The
 * returned gate is `live` exactly while the route is registered, and the timeline unit re-reads
 * it on every serve — that is what flips the wire generation.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the registry's `declare module '@deepseek-ai/cordis'` augmentation, which
// is what puts `ctx.sessionProjections` on the context without importing the service itself.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: installs the projection-key augmentation and gives the payload names one home.
import type { TimelineDetail } from '../../wire'
import { emptyTimeline } from '../fold/state'
import type { TimelineState } from '../fold/state'
import { reduceTimeline } from '../fold/reducer'
import { detailPayloadOf } from '../fold/wire'
import type { FoldBounds } from '../settings'
import type { ColdReadGate } from './cold'
import {
  BAD_REQUEST_CODE,
  INTERNAL_ERROR_CODE,
  type ConnectionFace,
  asRecord,
  disposeResource,
  messageOf,
  readJsonBody,
  registerPostRoute,
  replyFailure,
  replyValue,
  routePath,
} from './router'

/** The detail route, inside the authenticated `/api` fence. */
export const DETAIL_ROUTE = routePath('detail')

/**
 * The detail channel's liveness marker. The timeline unit's view reads it on every serve: `true`
 * while the route is registered, `false` once the connection/sessions services unload.
 */
export interface DetailChannelGate {
  readonly live: boolean
}

/** The `sessions` service slice used here (a strict live-store read). */
interface SessionsFace {
  get?(id: string): unknown
}

/** A prepared observation of a cold session's log. */
interface SessionQueryFace {
  observeSession?(id: string, options?: unknown): Promise<unknown>
}

/** The registry read used for a live session; the fold state is ours, so the shape is asserted. */
interface ProjectionStateFace {
  stateOf?(session: unknown, key: string): unknown
}

/** The timeline projection key this route reads. */
const TIMELINE_KEY = 'contextTimeline'

/**
 * Fold a cold log from an empty state. The observation is disposed in a `finally` so a throwing
 * fold cannot leak it.
 */
async function coldDetail(
  observe: (id: string, options: unknown) => Promise<unknown>,
  sessionId: string,
  bounds: FoldBounds,
): Promise<TimelineDetail | null> {
  const observation = await observe(sessionId, { projectionMode: 'none' })
  try {
    const events = asRecord(observation)?.events
    if (!Array.isArray(events)) return null
    let state = emptyTimeline()
    for (const event of events) state = reduceTimeline(state, event as never, bounds)
    return detailPayloadOf(state, bounds)
  } finally {
    await disposeResource(observation)
  }
}

/**
 * Arm the detail route once both `connection` and `sessions` are present. Either service
 * unloading takes the route down and closes the gate.
 */
export function watchDetailChannel(
  ctx: Context,
  bounds: FoldBounds,
  coldReads: ColdReadGate,
): DetailChannelGate {
  const gate = { live: false }
  ctx.inject(['connection', 'sessions'], (c) => {
    const sessions = c.get('sessions') as SessionsFace | undefined
    // Bind at read time: an unbound hand-off would lose `this` on the real store.
    const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
    if (getSession === undefined) return

    const handler = async (request: Request): Promise<Response> => {
      const body = await readJsonBody(request)
      if (!body.ok) return replyFailure(BAD_REQUEST_CODE, 'body is not JSON')
      const sessionId = asRecord(body.value)?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        return replyFailure(BAD_REQUEST_CODE, 'missing sessionId')
      }
      try {
        const session = getSession(sessionId)
        if (session !== undefined && session !== null) {
          // Live session: serve the registry's current fold state — never fold a second time.
          const projections = ctx.sessionProjections as unknown as ProjectionStateFace
          const state = typeof projections.stateOf === 'function'
            ? projections.stateOf(session, TIMELINE_KEY)
            : undefined
          if (state === undefined || state === null) return replyValue(null)
          return replyValue(detailPayloadOf(state as TimelineState, bounds))
        }
        // Cold session: observe and fold its immutable log through the shared gate. A refusal
        // (heap pressure) resolves `undefined`, which is the same typed null as "unobservable".
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        if (observe === undefined) return replyValue(null)
        // Bind the (possibly detached) method through a wrapper so the call keeps the face.
        const value = await coldReads.admit(
          async () => coldDetail((id, options) => observe(id, options), sessionId, bounds),
        )
        return replyValue(value ?? null)
      } catch (error) {
        return replyFailure(INTERNAL_ERROR_CODE, messageOf(error))
      }
    }

    if (!registerPostRoute(
      c,
      c.get('connection') as ConnectionFace | undefined,
      DETAIL_ROUTE,
      handler,
      'dsh-cost-breakdown: detail route',
    )) return
    gate.live = true
    return () => {
      gate.live = false
    }
  })
  return gate
}
