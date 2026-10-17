/**
 * The user preferences this plugin exposes, bound to the host's config-form scope.
 *
 * The host settings namespace is the loader **row id** (`cost-breakdown`), not the package name:
 * `dsh-settings` derives the namespace from `entry.options.id`. Renaming it silently moves every
 * persisted preference, so the two strings are deliberately declared separately.
 *
 * When the surface is absent, read-only, or serves garbage, every getter falls back to the schema
 * default. A configuration problem must never hide a surface.
 */

import type {
  DeltaBase, DurationCurve, FileSort, Granularity, InsightsEntry, Placement, Preferences, PreferenceKey,
  ToolSort, TrendMode,
} from '../../wire/model'

/** The bound form scope shape this module consumes (a structural subset of `ctx.configForms`). */
export interface SettingsScope {
  getSnapshot(): { status: string; value: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** The `ctx.configForms` service face. */
export interface ConfigFormService {
  get(namespace: string): SettingsScope
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

/** The host namespace these preferences live under: the loader row id. */
export const SETTINGS_NAMESPACE = 'cost-breakdown'

/** A whole, ready-to-use preference set. Every field is defaulted, so no consumer ever has to
 * derive a fallback. Replaced as a unit on change, which is what makes it safe to compare by
 * reference in `useSyncExternalStore`. */
export interface PreferencesState extends Preferences {
  /** `loading` before the first host partition lands; `unavailable` when no form is served. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the host would accept a write. */
  writable: boolean
}

/** Schema defaults: what a deployment without any settings surface uses for its whole life. They
 * are the widest options (show everything, placement `all`, writes refused). */
const DEFAULTS: Omit<PreferencesState, 'status' | 'writable'> = {
  defaultPlacement: 'all',
  defaultGranularity: 'step',
  defaultTrendMode: 'total',
  defaultDeltaBase: 'step',
  defaultToolSort: 'count',
  defaultFileSort: 'count',
  insightsEntry: 'show',
  defaultDurationCurve: 'show',
}

type PartialPrefs = Partial<Preferences>

/** Wash one raw scope value. Each field is checked against its own closed vocabulary, so a value
 * this build does not know is dropped here instead of reaching a component. A field the host never
 * served stays absent, which the caller distinguishes from a served-but-unknown value. */
function prefsOf(value: unknown): PartialPrefs {
  const raw = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const out: PartialPrefs = {}
  const placement = raw.defaultPlacement
  if (placement === 'all' || placement === 'tab' || placement === 'sidebar') out.defaultPlacement = placement
  const granularity = raw.defaultGranularity
  if (granularity === 'step' || granularity === 'turn') out.defaultGranularity = granularity
  const mode = raw.defaultTrendMode
  if (mode === 'total' || mode === 'delta') out.defaultTrendMode = mode
  const deltaBase = raw.defaultDeltaBase
  if (deltaBase === 'step' || deltaBase === 'turn') out.defaultDeltaBase = deltaBase
  const toolSort = raw.defaultToolSort
  if (toolSort === 'size' || toolSort === 'count' || toolSort === 'name') out.defaultToolSort = toolSort
  const fileSort = raw.defaultFileSort
  if (fileSort === 'count' || fileSort === 'latest' || fileSort === 'path') out.defaultFileSort = fileSort
  const insights = raw.insightsEntry
  if (insights === 'show' || insights === 'hide') out.insightsEntry = insights
  const curve = raw.defaultDurationCurve
  if (curve === 'show' || curve === 'hide') out.defaultDurationCurve = curve
  return out
}

/** One observable seat plus direct getters and the host binding. */
export interface PreferencesStore {
  /** The seat components mount as `usePreferences`. */
  readonly store: { subscribe(listener: () => void): () => void; getSnapshot(): PreferencesState }
  get(): PreferencesState
  /** Bind the host scope. Returns the scope subscription's disposer. */
  attach(scope: SettingsScope): () => void
  /** Persist one preference. Echoes locally first so the card reacts immediately. */
  set(field: PreferenceKey, value: string): void
}

/** Build the store at its schema defaults (no host scope yet). */
export function createPreferencesStore(): PreferencesStore {
  let state: PreferencesState = { ...DEFAULTS, status: 'loading', writable: false }
  let scope: SettingsScope | undefined
  const listeners = new Set<() => void>()

  /** Publish only on a real change: `useSyncExternalStore` compares by reference, so publishing an
   * equal-but-new object would re-render every preference consumer on every host tick. */
  const publish = (next: PreferencesState): void => {
    const same = next.status === state.status
      && next.writable === state.writable
      && (Object.keys(DEFAULTS) as PreferenceKey[]).every(key => next[key] === state[key])
    if (same) return
    state = next
    for (const listener of listeners) listener()
  }

  /** Fold a bound scope's snapshot into the state. Returns the two preferences whose **absence** is
   * meaningful: there, `undefined` means the host refused or never carried the field, which is what
   * the write-rollback path keys on. */
  const sync = (bound: SettingsScope): Pick<PartialPrefs, 'defaultPlacement' | 'insightsEntry'> => {
    const snapshot = bound.getSnapshot()
    const prefs = prefsOf(snapshot.value)
    const raw = snapshot.value !== null && typeof snapshot.value === 'object'
      ? snapshot.value as Record<string, unknown>
      : undefined
    // Fail open: a field this build does not understand degrades to its default; a field the
    // partition never carried keeps the current value.
    publish({
      status: snapshot.status === 'ready' || snapshot.status === 'unavailable' ? snapshot.status : 'loading',
      defaultPlacement: prefs.defaultPlacement ?? (raw?.defaultPlacement === undefined ? state.defaultPlacement : 'all'),
      defaultGranularity: prefs.defaultGranularity ?? state.defaultGranularity,
      defaultTrendMode: prefs.defaultTrendMode ?? state.defaultTrendMode,
      defaultDeltaBase: prefs.defaultDeltaBase ?? state.defaultDeltaBase,
      defaultToolSort: prefs.defaultToolSort ?? state.defaultToolSort,
      defaultFileSort: prefs.defaultFileSort ?? state.defaultFileSort,
      insightsEntry: prefs.insightsEntry ?? (raw?.insightsEntry === undefined ? state.insightsEntry : 'show'),
      defaultDurationCurve: prefs.defaultDurationCurve ?? (raw?.defaultDurationCurve === undefined ? state.defaultDurationCurve : 'show'),
      writable: snapshot.writable,
    })
    return { defaultPlacement: prefs.defaultPlacement, insightsEntry: prefs.insightsEntry }
  }

  return {
    store: {
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => state,
    },
    get: () => state,
    attach(bound) {
      scope = bound
      // Sync before subscribing: the scope's first snapshot is authoritative, and subscribing first
      // could interleave a partial state with the first read.
      sync(bound)
      return bound.subscribe(() => { sync(bound) })
    },
    set(field, value) {
      // Echo locally first: the card must react now rather than after a scope round trip, and
      // `publish`'s reference gate keeps an unchanged value from re-rendering.
      publish({ ...state, ...prefsOf({ [field]: value }) } as PreferencesState)
      const bound = scope
      if (bound === undefined) return
      // The scope write **rejects** on transport failure (only the queue tail stays fulfilled), so
      // never leave it dangling: roll the optimistic echo back to the scope's truth.
      void bound.set(field, value).catch(() => {
        const truth = sync(bound)
        // A failed persist must not let an unlanded echo hide a surface.
        if (field === 'defaultPlacement' && truth.defaultPlacement === undefined) {
          publish({ ...state, defaultPlacement: 'all' })
        }
        if (field === 'insightsEntry' && truth.insightsEntry === undefined) {
          publish({ ...state, insightsEntry: 'show' })
        }
      })
    },
  }
}

/** Narrow the vocabulary types the settings card needs when it builds its field table. */
export type { DeltaBase, DurationCurve, FileSort, Granularity, InsightsEntry, Placement, ToolSort, TrendMode }
