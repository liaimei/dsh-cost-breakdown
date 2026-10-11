/** Context Insights 页：两个注册共用同一个 id——页面挂在布局根带键的 `main`
 * slot 上（带键条目的切换使页面的挂载本身就是「打开」），shell 拥有的侧栏行挂在
 * `sidebar.panellist` 上。`insightsEntry` 偏好项为这一对把关：'hide' 会把两者一起卸载，
 * 页面因此失去入口；每次挂载掌管自己的清理函数。 */

import { createElement as h } from 'react'
import { InsightPanelIcon } from './icon'
import type { Translate } from './i18n'
import type { ContextSettings, InsightsEntry } from './settings'
import type { ClientCtx } from './services'

/** 侧栏条目与其打开的 `main` 面板共用的 id——像右侧 Sidebar 的
 *  kind 一样带命名空间，任何随附或外来面板都不会与它冲突。 */
export const INSIGHT_PANEL_ID = 'dsh-cost-breakdown'

/** 侧栏行的位置：排在随附的 Plugins（0）与 Automation tasks（10）条目之后。 */
export const INSIGHT_PANEL_ORDER = 20

/**
 * 在偏好项要求展示期间挂载页面及其侧栏条目。
 * @returns 该 watcher 的清理函数（退订并卸载任何仍存活的挂载）。
 */
export function watchInsightPage(
  ctx: ClientCtx,
  settings: ContextSettings,
  page: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  t: Translate,
  ns: string,
): () => void {
  let mounted = false
  const disposers: (() => void)[] = []
  const own = (result: unknown): void => {
    if (typeof result === 'function') disposers.push(result as () => void)
  }
  const mount = (): void => {
    // 注册在布局根带键的 `main` slot 下：带键条目在其键被选中时挂载，
    // 因此打开页面**就是**侧栏行切换到它。两个注册都经由
    // `slots.inject`，其返回值即清理函数。
    own(ctx.slots.inject('main', () => ctx.slots.register(
      { name: 'main', key: INSIGHT_PANEL_ID, locale: ns },
      page,
    )))
    own(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
      { name: 'sidebar.panellist', id: INSIGHT_PANEL_ID, order: INSIGHT_PANEL_ORDER, label: () => t('ov.title'), locale: ns },
      // 宿主份额只是图标的 size（该行的 active 标志不会被读取）；
      // 注册表的组件类型把它放宽为通用 slot props。
      props => h(InsightPanelIcon, { size: typeof props.size === 'number' ? props.size : undefined }),
    )))
  }
  const unmount = (): void => {
    // 后进先出：标题/图标注册位于面板自身注册的内部，
    // 因此必须先于它卸载。
    while (disposers.length > 0) disposers.pop()?.()
  }
  const applyEntry = (entry: InsightsEntry): void => {
    // 靠 `mounted` 标志保持幂等：未改变条目的设置写入同样会发出
    // 通知，重复挂载会泄漏此前的注册。
    if (entry === 'show' && !mounted) {
      mounted = true
      mount()
    } else if (entry === 'hide' && mounted) {
      mounted = false
      unmount()
    }
  }
  applyEntry(settings.insightsEntry())
  const unsubscribe = settings.store.subscribe(() => { applyEntry(settings.insightsEntry()) })
  return () => {
    unsubscribe()
    if (mounted) {
      mounted = false
      unmount()
    }
  }
}
