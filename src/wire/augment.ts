/**
 * Module augmentation: this plugin's three projection keys, as the harness registry sees them.
 *
 * The augmentation is split from the payload types on purpose. `model.ts` is pure data; this file
 * is the **declaration** that those payloads are projection values, which is what makes
 * `ctx.sessionProjections.register(...)` and `useProjection('contextTimeline')` type-check at all.
 *
 * Importing this module (a type-only side-effect import) is what installs the augmentation, so the
 * package barrel re-exports it and every consumer goes through the barrel.
 *
 * The three key strings are frozen: dropping or renaming one makes the host's value vanish from
 * every client snapshot with no error anywhere. Missing `contextTimeline` means the host half is not
 * installed; missing `contextHeaders` / `contextActivity` means an older host (empty heatmap).
 */

import type { ActivityLedger, HeaderTimeline, Snapshot } from './model'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    contextTimeline: Snapshot
    contextHeaders: HeaderTimeline
    contextActivity: ActivityLedger
  }
}
