/**
 * session projection 单元契约的兼容层。
 *
 * 已安装的 dsh 类型固定在最老的受支持接口（0.1.7-rc.2）上，它的可选 `wire?`
 * 过不了注册表的 wired-register 重载，因此这里把契约镜像成
 * {@link ProjectionDefinition}，让两侧都能通过编译检查。
 */

import type { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** dsh 0.1.7-rc.2+ 提供的 session projection 单元契约（本地镜像）。 */
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  key: K
  /** 在 checkpoint 行种入 fold 之前校验持久化 state；该 state 必须保持为纯 JSON。 */
  stateSchema: z.ZodType<S>
  /** 注册表会传入 session header 与 fork 继承的前缀长度；无参 init 则两者都不观察。 */
  init(): S
  /** 纯转移；被忽略的事件必须按引用返回原 state。 */
  apply(state: S, event: SessionEvent): S
  /** 只对面向 client 的单元生效：没有 `wire` 的单元仅属 host，其值永远不会到达浏览器。 */
  wire: {
    viewSchema: z.ZodType<SessionProjectionMap[K]>
    view(state: S): SessionProjectionMap[K]
  }
  /** 折叠出的 state 形状变化时抬高；版本不同的缓存行会被丢弃并重新折叠，
   * 而不是做迁移。 */
  stateVersion: number
}
