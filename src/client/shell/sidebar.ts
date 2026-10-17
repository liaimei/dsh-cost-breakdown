/**
 * The right-sidebar Context tab.
 *
 * It reuses the same view component the conversation tab mounts: `sidebar.right.pane.tab` is a
 * session-scoped seat delivering the same framework kit as `conversation.view`, so the pane and the
 * tab are one component over one data path.
 *
 * Optional by contract: `ctx.sidebarRightTabs` can be trimmed from a deployment, so this registration
 * rides a deferred inject (the plugin's hard injects stay `slots` + `locale`) and the plugin fiber can
 * never hang. The registry is defended too: a throwing `register`, or a taken id/kind, costs only this
 * sidebar tab.
 */

import type { ReactElement } from 'react'
import type { ClientContext, ContextSeatProps, SidebarTabsFace } from './contracts'
import type { Translate } from '../i18n/dict'
import { makeTabTitle } from '../ui/mark'

/** This tab kind's identity inside the sidebar tab system (also the key of its body seat). */
export const SIDEBAR_ID = 'dsh-cost-breakdown'

/** Namespaced rather than a bare `context`: the registry throws when a kind collides with another
 * registration in the same non-coexisting band, and a foreign plugin may well own `context`. */
export const SIDEBAR_KIND = 'dsh-cost-breakdown'

/** Guide-pill position: after the bundled Files entry (order 10). */
const GUIDE_ORDER = 20

/** The view component this registration mounts. Its `host: 'sidebar'` prop is the only switch the
 * view branches on, so one component serves both seats. */
export type ContextViewComponent = (props: ContextSeatProps) => ReactElement | null

/**
 * @returns the deferred inject's disposer; an empty function when the face returns no handle.
 */
export function watchSidebarTab(
  ctx: ClientContext,
  View: ContextViewComponent,
  t: Translate,
  namespace: string,
): () => void {
  const fiber = ctx.inject(['sidebarRightTabs'], (raw) => {
    const injected = raw as unknown as ClientContext & { sidebarRightTabs?: SidebarTabsFace }
    const disposers: Array<() => void> = []
    /** Only a function counts as a disposer: a registry may return nothing at all. */
    const own = (result: unknown): void => {
      if (typeof result === 'function') disposers.push(result as () => void)
    }
    try {
      const tabs = injected.sidebarRightTabs
      if (tabs === undefined || typeof tabs.register !== 'function') return
      own(tabs.register({
        id: SIDEBAR_ID,
        kind: SIDEBAR_KIND,
        // This column answers a different question from the conversation tab (it leads with spend),
        // so it carries its own name — sharing one would make readers expect the same view.
        title: () => t('sidebar.title'),
        guide: [{
          order: GUIDE_ORDER,
          title: () => t('sidebar.title'),
          description: () => t('sidebar.guideDescription'),
          icon: undefined,
        }],
      }))
      own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab', key: SIDEBAR_ID, locale: namespace },
        (props: { sessionId?: string } & Record<string, unknown>) => View({ ...props, host: 'sidebar' }),
      )))
      // Mounted under the kind id, so the kit dispatches it only for that kind's tabs.
      own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: SIDEBAR_ID },
        makeTabTitle(t, 'sidebar.title'),
      )))
    } catch {
      for (const dispose of disposers) dispose()
      return undefined
    }
    // The inject callback's own disposer owns every registration; cordis unloads them with the
    // injected fiber.
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
  // Re-validate at runtime: a harness face may return no handle at all.
  const handle = fiber as { dispose?: () => unknown } | undefined
  return () => { void handle?.dispose?.() }
}
