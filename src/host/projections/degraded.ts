/**
 * The degraded units a below-baseline harness gets instead of the real fold.
 *
 * A harness older than the supported baseline has a log dialect and seam interfaces outside the
 * compatibility matrix, so folding it would produce wrong numbers rather than no numbers. These
 * units fold nothing — `apply` is the identity on an opaque empty state — and serve a frozen payload,
 * the same reference on every call so the registry sees no change.
 *
 * The timeline payload carries an `unsupported` gate record: the detected version and the baseline,
 * which is everything the client needs to render the blank card and its upgrade notice.
 *
 * They also carry the pre-0.1.1 `schema` + `view` aliases. Those harnesses' registries read the
 * top-level pair rather than `stateSchema` + `wire`, and this gate is the plugin's entire behaviour
 * there, so it must remain serviceable.
 *
 * `stateVersion` is fixed at 1: on the way down a timeline row refolds and the headers row seeds as
 * empty, and on the way up the degraded rows are discarded or rejected and both refold from the log.
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BASELINE_RELEASE } from '../../core/version'
import { activityViewSchema, headerViewSchema, timelineViewSchema } from '../../wire/schema'
import type { ActivityLedger, HeaderTimeline, Snapshot } from '../../wire/model'
// Type-only side effect: installs this plugin's projection-key augmentation.
import type {} from './augment'

/** The degraded units' state version (all three share it; none of them folds anything). */
export const DEGRADED_STATE_VERSION = 1

/**
 * An opaque fold state: the gate folds nothing, so any cached row may seed it. Strip mode (not
 * strict) on purpose — an old row's fields are irrelevant, not wrong.
 */
const degradedStateSchema = z.object({})
type DegradedState = z.infer<typeof degradedStateSchema>

/**
 * The registry contract a degraded unit satisfies structurally.
 *
 * Deliberately **not** parameterised by `SessionProjectionStateMap`: the gate's state is an opaque
 * `{}` that intentionally belongs to none of this plugin's keys (it folds nothing), so typing it
 * against the real map would be a lie. The entry point registers it through a widened call, exactly
 * like the legacy `as never` cast did — the concrete object is still what lands in the registry.
 *
 * The `schema`/`view` pair is the pre-0.1.1 registry contract: those harnesses read the top-level
 * aliases rather than `stateSchema` + `wire`, and this gate is the plugin's entire behaviour there.
 */
export interface DegradedUnit<K extends string, V> {
  key: K
  stateSchema: z.ZodType<DegradedState>
  init(): DegradedState
  apply(state: DegradedState, event: SessionEvent): DegradedState
  wire: { viewSchema: z.ZodType<V>; view(state: DegradedState): V }
  schema: z.ZodType<V>
  view(state: DegradedState): V
  stateVersion: number
}

/** Build one gate unit. All three share the identity fold and the frozen value; only the key, schema
 * and payload differ. */
function degradedUnit<K extends string, V>(
  key: K,
  viewSchema: z.ZodType<V>,
  value: V,
): DegradedUnit<K, V> {
  const view = (): V => value
  return {
    key,
    stateSchema: degradedStateSchema,
    init: () => ({}),
    apply: (state: DegradedState, _event: SessionEvent) => state,
    wire: { viewSchema, view },
    // Pre-0.1.1 registries read these two instead of `stateSchema` + `wire`.
    schema: viewSchema,
    view,
    stateVersion: DEGRADED_STATE_VERSION,
  }
}

/**
 * The all-zero timeline value for a below-baseline harness.
 *
 * @param current - the version the probe detected; shown next to {@link BASELINE_RELEASE} in the
 *                  upgrade notice.
 */
export function createDegradedTimeline(current: string): DegradedUnit<'contextTimeline', Snapshot> {
  return degradedUnit('contextTimeline', timelineViewSchema, {
    ok: true,
    unsupported: { current, minimum: BASELINE_RELEASE },
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  })
}

/** An empty headers value: no epoch was decoded, so the client draws no header rows. */
export function createDegradedHeaders(): DegradedUnit<'contextHeaders', HeaderTimeline> {
  return degradedUnit('contextHeaders', headerViewSchema, { headers: [] })
}

/** An empty activity ledger: the heatmap shows no day rather than a stale one. */
export function createDegradedActivity(): DegradedUnit<'contextActivity', ActivityLedger> {
  return degradedUnit('contextActivity', activityViewSchema, { days: {} })
}
