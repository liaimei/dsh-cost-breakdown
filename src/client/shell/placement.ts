/**
 * The placement switch: which registrations carry the Context view.
 *
 * The `defaultPlacement` preference decides between the conversation tab, the right-sidebar pane, or
 * both. Re-evaluated on every settings write, so the switch takes effect without a reload, and the
 * returned disposer unsubscribes **first** so a pending settings tick cannot remount a seat that is
 * being torn down.
 */

import type { Placement } from '../../wire/model'
import type { PreferencesStore } from './preferences'

/** The two registration hosts to choose between. Each call mounts (and returns its cleanup), and is
 * only invoked when that seat is wanted. */
export interface PlacementMounts {
  tab(): unknown
  sidebar(): unknown
}

/** A mount host may return nothing at all (a trimmed slot service): treat that as already clean
 * rather than as a disposer to call. */
function disposerOf(result: unknown): (() => void) | undefined {
  return typeof result === 'function' ? result as () => void : undefined
}

/** Drive the two mounts from the placement preference. */
export function watchPlacement(store: PreferencesStore, mounts: PlacementMounts): () => void {
  let tab: (() => void) | undefined
  let sidebar: (() => void) | undefined
  const mount = (placement: Placement): void => {
    // `all` wants both, `tab` only the conversation tab, `sidebar` only that column.
    const wantTab = placement !== 'sidebar'
    const wantSidebar = placement !== 'tab'
    if (wantTab && tab === undefined) tab = disposerOf(mounts.tab())
    if (!wantTab && tab !== undefined) {
      tab()
      tab = undefined
    }
    if (wantSidebar && sidebar === undefined) sidebar = disposerOf(mounts.sidebar())
    if (!wantSidebar && sidebar !== undefined) {
      sidebar()
      sidebar = undefined
    }
  }
  mount(store.get().defaultPlacement)
  // Subscribe **after** the first mount: a settings write landing in between would otherwise produce a
  // duplicate mount — `mount` is idempotent, but the two calls are not atomic.
  const unsubscribe = store.store.subscribe(() => { mount(store.get().defaultPlacement) })
  return () => {
    unsubscribe()
    tab?.()
    sidebar?.()
    tab = undefined
    sidebar = undefined
  }
}
