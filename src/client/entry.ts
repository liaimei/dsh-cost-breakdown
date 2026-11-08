/**
 * The plugin's browser-half entry: every registration, in the order the harness must see it.
 *
 * One rule shapes the whole file: only `slots` and `locale` are **hard** injects. Everything else is
 * either a deferred `ctx.inject` or a validated read at the call site, so a deployment with services
 * trimmed still assembles this bundle — a hard inject on a missing service would leave the fiber
 * permanently pending and take every surface down with it.
 *
 * The registration order is load-bearing in three places:
 *   1. the dictionaries go first, because every later registration may pass `locale` and expects the
 *      namespace to resolve before its first render;
 *   2. the rate tables are published before any cost-rendering surface mounts, so the first frame prices
 *      with the user's own rates rather than the registry fallback;
 *   3. the settings store is bound before the placement switch evaluates, or the first mount would read
 *      the schema defaults instead of the persisted preference.
 */

import { createElement as h, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { SidebarMark } from './ui/mark'
import { DICT_EN, DICT_ZH } from './i18n/dict'
import type { Translate } from './i18n/dict'
import { createPreferencesStore, SETTINGS_NAMESPACE } from './shell/preferences'
import { readRelayTable, setRelayTableReady } from './data/relayPrices'
import type { ConfigFormService, PreferencesStore } from './shell/preferences'
import { watchPlacement } from './shell/placement'
import { watchSidebarTab } from './shell/sidebar'
import type { ClientContext, ContextSeatProps } from './shell/contracts'
import { setRateTables } from './shell/rateTables'
import { watchHistoryFaces } from './data/history'
import { ContextView } from './ui/context/ContextView'
import { registerContextCommand } from './ui/context/command'
import { ContextModal } from './ui/context/Modal'
import { modalStoreOf } from './ui/context/modalStore'
import { makeJumpButton } from './ui/context/jumpButton'
import { DockReadout } from './ui/dock/DockReadout'
import { TurnSpend } from './ui/turnSpend'
import { InsightsPage } from './ui/insights/InsightsPage'
import { PluginSettingsCard } from './ui/settings'

/** Locale namespace **and** the `plugins.bundle.config` seat key: the Plugins page looks that seat up by
 * package name. */
const NAMESPACE = 'dsh-cost-breakdown'

/** The plugin name the loader prints, also the client-module id. */
const NAME = 'dsh-cost-breakdown'

/** Hard dependency list: the fiber mounts only where both services exist. */
const INJECT = ['slots', 'locale'] as const

const TAB_ID = 'context'
const JUMP_ID = 'context-jump'
const DOCK_ID = 'context-cost'
const TURN_SPEND_ID = 'turn-spend'
const MODAL_ID = 'context-modal'

/** The seat the framework hands a slot component: a session id plus whatever the seat injects. */
type Seat = { sessionId?: string } & Record<string, unknown>

/** A modal store face, as the overlay seat injects it. */
interface ModalFlag {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  set(open: boolean): void
}

/** The whole browser half. */
function apply(ctx: ClientContext): void {
  // (a) Dictionaries first: later registrations may tag themselves with this namespace.
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh: DICT_ZH, en: DICT_EN }), 'dsh-cost-breakdown: dictionaries')
  const t: Translate = ctx.locale.bind(NAMESPACE)

  // (b) The settings handle; schema defaults hold until the host scope attaches.
  const preferences = createPreferencesStore()

  // (b2) The gateway's history paging face, through a declarative inject: the context browser reads a
  // message's full content from the durable log, anchored at one seq, which the detail window does not ship.
  watchHistoryFaces(ctx)

  // (c0) The relay's published price list, read once per mount. A relay resells other vendors' models,
  // so the public registry cannot price it; this table is what makes its models priceable without the
  // user typing every rate. The read is independent of the settings: a failure simply leaves the relay
  // unpriceable, which the platform card states outright.
  ctx.effect(() => {
    readRelayTable((value) => { setRelayTableReady(value) })
    return () => {}
  }, 'dsh-cost-breakdown: relay prices')

  // (c) User rate tables plus the settings binding, through one deferred inject: a deployment without
  // `configForms` keeps the schema defaults and the registry fallback rates.
  ctx.inject(['configForms'], (injected) => {
    const scoped = injected as ClientContext & { configForms?: ConfigFormService }
    const forms = scoped.configForms
    if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
    const scope = forms.get(SETTINGS_NAMESPACE)
    const sync = (): void => {
      const snapshot = scope.getSnapshot()
      const value = snapshot.value !== null && typeof snapshot.value === 'object'
        ? snapshot.value as Record<string, unknown>
        : {}
      setRateTables({ money: value.thirdPartyRates, credits: value.creditRates })
    }
    sync()
    scoped.effect(() => scope.subscribe(sync), 'dsh-cost-breakdown: rate tables')
    scoped.effect(() => preferences.attach(scope), 'dsh-cost-breakdown: config forms')
  })

  // (d) The two placements: one component, two seats, re-evaluated on every preference write.
  const BoundContext = (props: Seat): ReactElement => h(ContextView, { ...props, t, ctx, preferences })
  ctx.effect(() => watchPlacement(preferences, {
    tab: () => ctx.slots.inject('conversation.view', () => ctx.slots.register(
      // Order 20 renders to the right of Chat (0) and Trajectory (10).
      { name: 'conversation.view', id: TAB_ID, order: 20, locale: NAMESPACE, label: () => t('tab') },
      (props: Seat) => h(BoundContext, props),
    )),
    sidebar: () => watchSidebarTab(ctx, (props: ContextSeatProps) => h(BoundContext, props as unknown as Seat), t, NAMESPACE),
  }), 'dsh-cost-breakdown: placement')

  // (e) Chat → Context jump, after the bundled feedback entry (10) and still inside the icon row.
  const JumpButton = makeJumpButton(ctx, t)
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
    { name: 'conversation.chat.assistant-actions', id: JUMP_ID, order: 20, locale: NAMESPACE },
    (props: Seat) => h(JumpButton, props as unknown as ContextSeatProps),
  ))

  /** The active locale, read defensively: a trimmed locale service has no `getLocale`. */
  const localeOf = (): string => {
    try {
      return ctx.locale.getLocale?.().active ?? 'en'
    } catch {
      return 'en'
    }
  }

  // (f) The composer-row readout: independent of the right sidebar on purpose, so a harness without that
  // column still shows it.
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: DOCK_ID, order: 10, locale: NAMESPACE },
    (props: Seat) => h(DockReadout, { ...props, t, locale: localeOf, preferences }),
  ))

  // (g) The per-turn spend pill on the reply tail.
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
    { name: 'conversation.chat.assistant-actions', id: TURN_SPEND_ID, order: 30, locale: NAMESPACE },
    (props: Seat) => h(TurnSpend, { ...props, t, locale: localeOf }),
  ))

  // (h) The `/context` command and its modal. The modal is mounted per session with its own open flag
  // injected as a hook seat.
  registerContextCommand(ctx, t)
  ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register(
    {
      name: 'conversation.input.overlay',
      id: MODAL_ID,
      order: 10,
      locale: NAMESPACE,
      inject: (sessionId = '') => ({ hooks: { contextModal: modalStoreOf(sessionId) } }),
    },
    (props: Seat) => h(ContextModalShell, { ...props, t, ctx }),
  ))

  // (i) The Insights page: the panel and its sidebar entry mount and unmount with the preference.
  watchInsightsPage(ctx, preferences, t)

  // (j) The Plugins-page config card. The seat key is the package name because that is how the Plugins
  // page looks it up.
  ctx.inject(['configForms'], (injected) => {
    const scoped = injected as ClientContext & { configForms?: ConfigFormService }
    const forms = scoped.configForms
    if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
    scoped.effect(() => forms.whileServed([SETTINGS_NAMESPACE], () => scoped.slots.inject(
      'plugins.bundle.config',
      () => scoped.slots.register(
        {
          name: 'plugins.bundle.config',
          key: NAMESPACE,
          locale: NAMESPACE,
          inject: () => ({ hooks: { preferences: preferences.store }, set: preferences.set, store: preferences }),
        },
        (props: Seat) => h(PluginSettingsCard, { ...props, t }),
      ),
    ) as () => void), 'dsh-cost-breakdown: plugins-page card')
  })
}

/** The modal shell: it reads its open flag from the injected hook seat and flips it back through the
 * per-session store, so the entry never has to know which session opened it. */
function ContextModalShell(props: ContextSeatProps & { t: Translate; ctx: ClientContext }): ReactElement | null {
  const seat = props as unknown as { hooks?: { contextModal?: ModalFlag } }
  const store = seat.hooks?.contextModal
  const open = useOpenFlag(store)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  return h(ContextModal, { ...props, open, sessionId, onClose: () => { store?.set(false) } })
}

/** Subscribe to a modal store's boolean; absent seat ⇒ permanently closed, so a trimmed host still renders
 * the overlay (just never open) instead of crashing. */
function useOpenFlag(store: ModalFlag | undefined): boolean {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (store === undefined) return
    const update = (): void => { setOpen(store.getSnapshot()) }
    update()
    return store.subscribe(update)
  }, [store])
  return open
}

/** Mount the Insights page and its sidebar row while the preference says show. */
function watchInsightsPage(ctx: ClientContext, preferences: PreferencesStore, t: Translate): void {
  ctx.effect(() => {
    let mounted = false
    let disposers: Array<() => void> = []
    const mount = (show: boolean): void => {
      // Idempotent: unrelated preference writes notify too, and a remount would double the registrations.
      if (show === mounted) return
      mounted = show
      if (show) {
        disposers = [
          ctx.slots.inject('main', () => ctx.slots.register(
            { name: 'main', key: NAMESPACE, locale: NAMESPACE },
            (props: Seat) => h(InsightsPage, { ...props, t, ctx, preferences }),
          )),
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
            // The shell prints this label verbatim (it never consults the plugin dictionary), so the
            // row name must come from a function here; without it the sidebar falls back to the id,
            // which prints the package name instead of 「统计」.
            { name: 'sidebar.panellist', id: NAMESPACE, order: 20, locale: NAMESPACE, label: () => t('ov.title') },
            (props: Seat) => h(InsightsRow, { size: typeof props.size === 'number' ? props.size : undefined }),
          )),
        ].filter((dispose): dispose is () => void => typeof dispose === 'function')
      } else {
        // LIFO, so a later registration cannot outlive the one it depended on.
        for (const dispose of [...disposers].reverse()) dispose()
        disposers = []
      }
    }
    mount(preferences.get().insightsEntry === 'show')
    const unsubscribe = preferences.store.subscribe(() => { mount(preferences.get().insightsEntry === 'show') })
    return () => {
      unsubscribe()
      for (const dispose of [...disposers].reverse()) dispose()
      disposers = []
    }
  }, 'dsh-cost-breakdown: insight page')
}

/** The sidebar panel-list glyph: the shell owns that row's label and active state. */
function InsightsRow({ size }: { size?: number }): ReactElement {
  return h(SidebarMark, { size })
}

/**
 * The browser half's faces, exported for the bundle entry to publish as `module.exports`.
 *
 * The assignment deliberately lives in `index.ts` rather than here: the bundler may wrap an imported
 * module in its own lazy initializer, and a `module.exports` write performed there would target that
 * wrapper's module object rather than the one the loader reads.
 */
export { apply, NAME as name, INJECT as inject }

/** Re-exported for type consumers: the seat types are part of this bundle's compile contract. */
export type { ClientContext, ContextSeatProps }
