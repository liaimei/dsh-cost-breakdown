/**
 * The loader row's configuration schema, plus the resolved fold bounds every consumer takes.
 *
 * Two consumers read this one schema, and they want different things from it:
 *  - Cordis validates the row's `config:` block through the Standard-Schema face *before*
 *    `apply` runs, so a malformed bound must fail loudly at load time.
 *  - The harness Config form derives the Plugins-page controls from the same schema, and only
 *    fields marked `.volatile()` are offered as live-editable preferences.
 *
 * Hence schemastery rather than zod: it is the one schema library both consumers speak. The
 * namespace is the loader row id (`cost-breakdown`), not the package name — see `plugin.ts`.
 *
 * Everything here is resolved **once** at assembly time. A remote config edit therefore takes
 * effect when the loader row remounts, never mid-fold: retention bounds captured per unit must
 * not change underneath a state that was already trimmed against the old ones.
 */

import z from '@deepseek-ai/schemastery'
import { DEFAULT_HOLIDAYS, normaliseHolidays } from '../core/clock'
import type { PreferenceKey, Preferences } from '../wire/model'

/**
 * The shipped retention limits and the built-in holiday calendar. Every field may be overridden
 * per loader row, and the schema defaults are derived from this object so the two can never drift.
 */
export const DEFAULT_BOUNDS = {
  maxRequestSteps: 1500,
  /** Newest whole-turn window. Trimming happens on turn boundaries, never mid-turn. */
  maxKeptTurns: 300,
  maxEvents: 400,
  /** Pathological-session backstop only: the whole node slice rides every push (~150 B/node). */
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
  /** Chinese public holidays (Beijing dates) that bill off-peak all day. */
  holidays: [...DEFAULT_HOLIDAYS] as string[],
}

/** Resolved retention limits, derived from {@link DEFAULT_BOUNDS} so the types agree. */
export type FoldBounds = typeof DEFAULT_BOUNDS

/**
 * Raw row configuration: any retention bound plus any display preference, all optional because
 * the schema fills the rest. Consumers never read fields directly — they call
 * {@link resolveBounds}, so a field added here cannot silently miss a default.
 */
export type Config = Partial<FoldBounds> & Partial<Preferences>

/**
 * Mark a field as live-editable when the harness's schemastery ships `.volatile()`.
 *
 * The modifier appeared in a later schemastery line; calling it unconditionally would throw on
 * the older lines the compatibility matrix still admits. Degrading to an ordinary field is the
 * right fallback there: the preference still persists, it just rides the remount path instead of
 * the live-submit path.
 */
export function volatileField<S extends z>(field: S): S {
  const volatile = (field as unknown as { volatile?: () => S }).volatile
  return typeof volatile === 'function' ? volatile.call(field) : field
}

/** A positive whole number of items to retain. Zero, negatives and fractions must be rejected. */
function count(defaultValue: number) {
  return z.number().min(1).step(1).default(defaultValue)
}

/**
 * The row schema: retention bounds plus the volatile display preferences.
 *
 * Every enum union and the holiday array are `.loose()` on purpose. A persisted preference from
 * a newer build, or a hand-edited `cordis.patch.yml`, must degrade to the default instead of
 * failing the entry load — a failed load removes the whole plugin, not just the one field.
 */
export const Config = z.object({
  maxRequestSteps: count(DEFAULT_BOUNDS.maxRequestSteps),
  maxKeptTurns: count(DEFAULT_BOUNDS.maxKeptTurns),
  maxEvents: count(DEFAULT_BOUNDS.maxEvents),
  maxNodes: count(DEFAULT_BOUNDS.maxNodes),
  maxArchiveNodes: count(DEFAULT_BOUNDS.maxArchiveNodes),
  maxFileOps: count(DEFAULT_BOUNDS.maxFileOps),
  holidays: z.array(z.string()).default([...DEFAULT_HOLIDAYS] as string[]).loose(),

  defaultPlacement: volatileField(z.union(['all', 'tab', 'sidebar']).default('all').loose()),
  defaultGranularity: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultTrendMode: volatileField(z.union(['total', 'delta']).default('total').loose()),
  defaultDeltaBase: volatileField(z.union(['step', 'turn']).default('step').loose()),
  defaultToolSort: volatileField(z.union(['size', 'count', 'name']).default('count').loose()),
  defaultFileSort: volatileField(z.union(['count', 'latest', 'path']).default('count').loose()),
  insightsEntry: volatileField(z.union(['show', 'hide']).default('show').loose()),
  defaultDurationCurve: volatileField(z.union(['show', 'hide']).default('show').loose()),
})

/** Every preference key, in schema order. Derived so a rename cannot leave one behind. */
export const PREFERENCE_KEYS: readonly PreferenceKey[] = [
  'defaultPlacement',
  'defaultGranularity',
  'defaultTrendMode',
  'defaultDeltaBase',
  'defaultToolSort',
  'defaultFileSort',
  'insightsEntry',
  'defaultDurationCurve',
]

/**
 * Apply every default and narrow the holiday table.
 *
 * Called once per consumer at assembly time. The holiday narrowing is the subtle half: an empty
 * or malformed table must fall back to the built-in calendar rather than mean "no holidays",
 * because "no holidays" would bill every public holiday at the peak rate and silently double
 * those days. `normaliseHolidays` returning `undefined` is exactly that signal.
 */
export function resolveBounds(config: Config | undefined): FoldBounds {
  const resolved = Config(config ?? {}) as FoldBounds & Record<string, unknown>
  return {
    maxRequestSteps: resolved.maxRequestSteps,
    maxKeptTurns: resolved.maxKeptTurns,
    maxEvents: resolved.maxEvents,
    maxNodes: resolved.maxNodes,
    maxArchiveNodes: resolved.maxArchiveNodes,
    maxFileOps: resolved.maxFileOps,
    holidays: normaliseHolidays(resolved.holidays) ?? [...DEFAULT_HOLIDAYS],
  }
}
