/** session 列表各消费方共用的 sessions 订阅管道：list 快照的 React 座位，
 * 外加一个页面级缓存，每个 session id 保存一个「在途或已敲定」的精简 head
 * promise，这样坏掉的亲属不会随每次快照跳动重试，
 * 所有消费方也共用同一次抓取。 */

import { useCallback, useSyncExternalStore } from 'react'
import type { ContextTimeline } from '../shared/types'
import type { SessionsFaceLike } from './agentTree'
import { makeDetailFetcher } from './timelineSource'

/** Agent 网络卡片为不带 `contextTimeline` 投影的列表行
 *  （冷亲属）读取精简 head 的访问器。 */
export interface AgentHeads {
  headOf(id: string): Promise<ContextTimeline | null>
}

/** 每个调用点一个缓存，而不是每个模块一个：每个消费方的映射存活到该消费方
 *  为止，卡片卸载时它缓存的 head 随之丢弃。某个 id 的**第一个** promise
 *  即便解析为 null 也会保留——缓存刻意不重试已敲定的失败，
 *  因为每次快照跳动都重试会让坏路由被永远反复请求。 */
export function makeAgentHeads(): AgentHeads {
  const heads = new Map<string, Promise<ContextTimeline | null>>()
  return {
    headOf(id: string): Promise<ContextTimeline | null> {
      const cached = heads.get(id)
      if (cached !== undefined) return cached
      const fetcher = makeDetailFetcher(id)
      // fetcher 缺失（空 session id）时仍返回一个已敲定的 promise，
      // 每个调用方都能并入同一条目，而不是按可用性分支。
      const pending = fetcher !== undefined ? fetcher().then(d => d?.head ?? null) : Promise.resolve(null)
      heads.set(id, pending)
      return pending
    },
  }
}

/** session 列表面孔之上的 React 座位。面孔变化（watch 重建）时会重新创建
 *  `subscribe`/`getSnapshot`，从而重挂载订阅；快照函数返回面孔自己的值，
 *  因此 `getSnapshot` 对 `useSyncExternalStore` 必须保持引用稳定——
 *  这正是直接返回原值而不派生对象的原因。 */
export function useSessionsSnapshot(face: SessionsFaceLike | null): unknown {
  const subscribe = useCallback((fn: () => void) => {
    // 面孔为 null 时订阅空实现而不是抛错：面板挂载可能早于
    // `sessionsFaceOf` 校验服务（services.ts）。
    if (face === null) return () => {}
    /* v8 ignore next 2 -- 不可达：sessionsFaceOf 在返回面孔之前已校验过 list.subscribe。 */
    if (face.list === undefined) return () => {}
    return face.list.subscribe(fn)
  }, [face])
  const getSnapshot = useCallback(() => {
    if (face === null) return null
    /* v8 ignore next 2 -- 不可达：sessionsFaceOf 在返回面孔之前已校验过 list。 */
    if (face.list === undefined) return null
    return face.list.getSnapshot()
  }, [face])
  return useSyncExternalStore(subscribe, getSnapshot)
}
