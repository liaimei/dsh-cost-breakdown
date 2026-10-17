/**
 * Module augmentation for this plugin's projection keys — the **state** half.
 *
 * The value half lives in `wire/augment.ts` (payload types are wire vocabulary, so they belong with
 * the wire model). The fold state, however, is entirely this layer's business: `TimelineState`,
 * `HeadersState` and `ActivityState` are host implementation shapes that never cross to the browser.
 * Declaring them here keeps `register()` typed against the real registry contract without dragging
 * host-only types into `wire/`.
 *
 * Both maps must be populated for `ctx.sessionProjections.register(...)` to accept a definition at
 * all: the registry types each key through these interfaces, and a missing entry turns every
 * registration site into a type error. Importing this module (a type-only side effect) is enough —
 * its side-effect import of the wire augmentation also installs the value half.
 */

// Type-only side effect: installs `SessionProjectionMap` for the three keys.
import type {} from '../../wire/augment'
import type { ActivityState } from './activity'
import type { HeadersState } from './headers'
import type { TimelineState } from '../fold/state'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextTimeline: TimelineState
    contextHeaders: HeadersState
    contextActivity: ActivityState
  }
}
