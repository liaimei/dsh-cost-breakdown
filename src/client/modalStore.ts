/** /context 模态框按 session 记录的打开状态 store，外加延迟的 token 消费守卫；
 *  放在模块级，使状态能在遮罩层重挂载后存活。 */

import type { TokenSpan } from './services'

/** 某个 session 的模态框订阅的可观察打开标志；每个 session id 一个实例，
 *  由命令、遮罩层与关闭路径共用。 */
export interface ModalStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  set(open: boolean): void
}

// 从不驱逐：映射很小（用户打开过的每个 session 一个布尔值），让它与页面同寿命
// 正是遮罩层能在 session 中途重挂载而不丢打开状态的原因。
const stores = new Map<string, ModalStore>()

/** 该 session 的 store，首次使用时创建。 */
export function modalStoreOf(sessionId: string): ModalStore {
  const existing = stores.get(sessionId)
  if (existing !== undefined) return existing
  let open = false
  const listeners = new Set<() => void>()
  const store: ModalStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => open,
    set(next) {
      // 同一引用即退出：`useSyncExternalStore` 每次通知都会重渲染，
      // 而关闭路径可能在 store 已经关闭时再次触发。
      if (next === open) return
      open = next
      for (const listener of listeners) listener()
    },
  }
  stores.set(sessionId, store)
  return store
}

// 每条打开路径都记录输入外壳能理解的守卫——挑选走 span CAS，回车走裸 token 相等——
// 关闭路径则派发 `slash/input-consume-token`；过期的守卫会软失败。

/** 输入外壳在消费用户挑中的 token 之前必须核对的内容。之所以有两种，
 *  是因为两条打开路径掌握的信息不同：挑选带着草稿版本号
 *  （span 可能此后已移动），回车匹配只带字面那一行。 */
export type ConsumeGuard =
  | { kind: 'span'; span: TokenSpan }
  | { kind: 'bare-token'; token: string }

// 每个 session 一个守卫，每次打开都会覆盖：只有最近一次打开才可消费。
const pendingConsume = new Map<string, ConsumeGuard>()

/** 记录即将渲染的那次打开所用的守卫。 */
export function setPendingConsume(sessionId: string, guard: ConsumeGuard): void {
  pendingConsume.set(sessionId, guard)
}

/** 只消费一次：同一 session 的第二次关闭必须什么都找不到，
 *  token 因此绝不会被派发两次。 */
export function takePendingConsume(sessionId: string): ConsumeGuard | undefined {
  const guard = pendingConsume.get(sessionId)
  if (guard !== undefined) pendingConsume.delete(sessionId)
  return guard
}
