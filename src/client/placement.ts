/** Context 视图的放置开关：按用户的 `defaultPlacement` 偏好项决定由哪些
 *  注册承载它——对话标签页、右侧 Sidebar 面板，还是两者都要。 */

import type { ContextSettings } from './settings'
import type { DefaultPlacement } from '../shared/types'

/** 放置偏好项要在其中二选一的**两个**注册宿主；每次调用即挂载
 *  （并返回其清理函数），且只在该座位被需要时调用。 */
export interface PlacementMounts {
  tab(): unknown
  sidebar(): unknown
}

/** 用 `defaultPlacement` 驱动两个注册宿主，并在每次设置写入时重新求值：
 *  挂载状态无需刷新即可切换，返回的清理函数会先退订，
 *  这样一次待处理的设置跳动就无法重新挂载正在拆除的座位。 */
export function watchPlacement(settings: ContextSettings, mounts: PlacementMounts): () => void {
  let tab: (() => void) | undefined
  let sidebar: (() => void) | undefined
  /** 挂载宿主可能什么都不返回（slot 服务被裁剪）：视作已清理，
   *  而不是当成一个待调用的清理函数。 */
  const own = (result: unknown): (() => void) | undefined =>
    typeof result === 'function' ? result as () => void : undefined
  const mount = (placement: DefaultPlacement): void => {
    // 'all' 两者都要，'tab' 只要对话标签页，'sidebar' 只要那一列。
    const wantTab = placement !== 'sidebar'
    const wantSidebar = placement !== 'tab'
    if (wantTab && tab === undefined) tab = own(mounts.tab())
    if (!wantTab && tab !== undefined) { tab(); tab = undefined }
    if (wantSidebar && sidebar === undefined) sidebar = own(mounts.sidebar())
    if (!wantSidebar && sidebar !== undefined) { sidebar(); sidebar = undefined }
  }
  mount(settings.defaultPlacement())
  // 在首次挂载**之后**才订阅：否则落在两者之间的设置写入会造成
  // 重复挂载——`mount` 虽是幂等的，但两次调用并非原子。
  const unsubscribe = settings.store.subscribe(() => { mount(settings.defaultPlacement()) })
  return () => {
    unsubscribe()
    tab?.()
    sidebar?.()
    tab = undefined
    sidebar = undefined
  }
}
