/**
 * 右侧 Sidebar 的 Context 标签页。它原样复用 Context 对话视图组件：
 * `sidebar.right.pane.tab` 是与 `conversation.view` 交付同一套框架标准 kit 的
 * session 作用域座位，因此面板与标签页是同一个组件、同一条数据通路。
 *
 * 契约上属于可选：`ctx.sidebarRightTabs` 可能被裁剪，因此该注册搭乘延迟
 * inject（插件的硬性 inject 仍只有 `slots` + `locale`），插件 fiber 永不挂起。恶意的
 * 注册表已被防护：`register` 抛错或 id/kind 被占用，代价仅是这个侧栏标签页。
 */

import { ContextIcon, makeContextTabTitle } from './icon'
import type { ClientCtx, ContextViewProps, SidebarTabsFace } from './services'
import type { Translate } from './i18n'

/** 该标签页类型在侧栏标签系统里的标识（同时也是其主体座位的键）。 */
export const SIDEBAR_CONTEXT_ID = 'dsh-cost-breakdown'

/** 带命名空间而不是裸的 `context`：当 kind 与另一条注册在同一非共存带内
 * 冲突时注册表会抛错，而外来插件很可能正占着 `context`。 */
export const SIDEBAR_CONTEXT_KIND = 'dsh-cost-breakdown'

/** 引导胶囊的位置：排在随附的 Files 条目（order 10）之后。 */
const GUIDE_ORDER = 20

/** @returns 延迟 inject 的清理函数；面孔不返回句柄时为空操作。 */
export function watchSidebarContextTab(
  ctx: ClientCtx,
  view: (props: ContextViewProps) => unknown,
  t: Translate,
  ns: string,
): () => void {
  const fiber = ctx.inject(['sidebarRightTabs'], (raw) => {
    const injected = raw as unknown as ClientCtx & { sidebarRightTabs?: SidebarTabsFace }
    const disposers: (() => void)[] = []
    /** 只有函数才算清理函数：注册表可能什么都不返回。 */
    const own = (result: unknown): void => {
      if (typeof result === 'function') disposers.push(result as () => void)
    }
    try {
      const tabs = injected.sidebarRightTabs
      if (tabs === undefined || typeof tabs.register !== 'function') return
      own(tabs.register({
        id: SIDEBAR_CONTEXT_ID,
        kind: SIDEBAR_CONTEXT_KIND,
        // 这一列只讲平台消费，与对话区那个只讲上下文的标签页已经不是同一件事，
        // 因此各用其名——同名会让用户以为点开的是同一份视图。
        title: () => t('sidebar.title'),
        guide: [{
          order: GUIDE_ORDER,
          title: () => t('sidebar.title'),
          description: () => t('sidebar.guideDescription'),
          icon: ContextIcon,
        }],
      }))
      own(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab', key: SIDEBAR_CONTEXT_ID, locale: ns },
        (props: { sessionId?: string } & Record<string, unknown>) => view({ ...props, host: 'sidebar' }),
      )))
      // 挂在类型 id 之下，kit 因此只为该类型的标签页派发它。
      own(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
        { name: 'sidebar.right.pane.tab.title', key: SIDEBAR_CONTEXT_ID },
        makeContextTabTitle(t, 'sidebar.title'),
      )))
    } catch {
      for (const dispose of disposers) dispose()
      return undefined
    }
    // inject 回调自己的清理函数掌管全部注册；cordis 会随被注入的 fiber 一起卸载它们。
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
  // 运行时再校验一次：harness 面孔可能完全不返回句柄。
  const handle = fiber as { dispose?: () => unknown } | undefined
  return () => { void handle?.dispose?.() }
}
