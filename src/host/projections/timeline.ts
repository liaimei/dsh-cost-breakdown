/**
 * The `contextTimeline` projection unit — the plugin's primary data plane.
 *
 * The harness drives this unit itself: one `apply` per committed `session/event`, checkpointed by
 * the projection cache, and pushed to the browser through the standard `useProjection` seat. So this
 * module holds no subscriptions and never touches the client — it is pure init/apply/view plus the
 * state and view schemas.
 *
 * **Two wire generations, one unit.** The heavy collections (requests, events, the node slice, file
 * operations, spans) are served per viewing client by the detail route, which keeps them off every
 * `session.list` row and every pushed frame. The value therefore has a slim and an inline generation,
 * chosen **per serve** from the channel-liveness callback: the route is armed asynchronously on the
 * `connection` + `sessions` services, so before it exists the unit must serve the fully inline value
 * or the Context tab would hang on "loading" forever. Both generations fold the same state and
 * validate against the same schema, so the split only changes the view.
 *
 * `stateVersion` is 29: bumping it discards every persisted cache row and refolds them from the
 * durable log, so it may only move when the state shape or the fold semantics change — never for a
 * field the log can still recompute. 29 records the period-routing change: peak/off-peak is decided
 * by **model** (every model on the official list splits by period whichever route carried it), so rows
 * folded under the old route-keyed rule would otherwise keep mis-pricing proxied usage forever.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { timelineStateSchema, timelineViewSchema } from '../../wire/schema'
import type { Snapshot } from '../../wire/model'
import { reduceTimeline } from '../fold/reducer'
import { emptyTimeline } from '../fold/state'
import type { TimelineEvent, TimelineState } from '../fold/state'
import { inlineOf, splitHeadOf } from '../fold/wire'
import { resolveBounds } from '../settings'
import type { Config, FoldBounds } from '../settings'
// Type-only side effect: installs this plugin's projection-key augmentation.
import type {} from './augment'

/** The projection key this unit owns. */
export const TIMELINE_KEY = 'contextTimeline' as const

/**
 * The unit's persisted-state version. Bumping invalidates every cached row for this key and refolds
 * from the log — safe but not free, because an idle session has no refresh channel and its key would
 * stay empty until it goes live again.
 */
export const TIMELINE_STATE_VERSION = 29

/** Whether the detail channel is live right now; re-read on every serve. */
export type SlimProbe = () => boolean

/**
 * Build the unit.
 *
 * @param config - the loader row's config; bounds are resolved once here, so a remote edit takes
 *                 effect when the row remounts rather than mid-fold.
 * @param slim - per-serve liveness probe of the detail channel.
 */
export function createTimelineUnit(
  config: Config,
  slim: SlimProbe,
): ProjectionDefinition<typeof TIMELINE_KEY, TimelineState> {
  const bounds: FoldBounds = resolveBounds(config)
  return {
    key: TIMELINE_KEY,
    stateSchema: timelineStateSchema,
    // The empty log: no header, no inherited prefix, and this fold observes neither.
    init: () => emptyTimeline(),
    apply: (state: TimelineState, event: SessionEvent) => reduceTimeline(
      state,
      event as unknown as TimelineEvent,
      bounds,
    ),
    wire: {
      viewSchema: timelineViewSchema,
      // The generation follows the detail channel's liveness, so one deployment can serve both.
      view: (state: TimelineState): Snapshot => (slim() ? splitHeadOf(state) : inlineOf(state, bounds)),
    },
    stateVersion: TIMELINE_STATE_VERSION,
  }
}
