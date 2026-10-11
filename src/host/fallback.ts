/**
 * 基线闸门的回退 projection 单元（见 host/index.ts）。
 *
 * 在低于受支持基线的 harness 上，插件注册这些单元「而非」
 * 真实 fold：完全不做解析——`apply` 是不透明的空 state 上的恒等函数，
 * `view` 提供一个固定值，其 timeline 快照带着闸门记录（`unsupported`：
 * 探测到的 harness 版本与基线），client
 * 因此渲染空白卡片和它的升级提示弹窗。
 *
 * 该定义还带着 0.1.1 之前的顶层 `schema` + `view` 别名，
 * 那些 harness 的注册表读的是它们而不是 `stateSchema` + `wire`。
 * 它们只服务于支撑矩阵（docs/compatibility.md）之外的 harness，在这种环境下这道闸门就是插件的全部行为。
 *
 * `stateVersion` 固定为 1：
 * 降级时 timeline 键会重新折叠，headers 键则被剥成空 state 种入（闸门从不读它）；
 * 升回来时回退行会被丢弃或拒绝，两者都从日志重新折叠。
 */

import { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { ProjectionDefinition } from './compat'
import { BASELINE_DSH_VERSION } from '../shared/version'
import { contextActivitySchema } from './activity'
import { contextHeadersSchema } from './headers'
import { contextTimelineSchema } from './timeline'

/** 不透明的 fold state：闸门不做任何折叠，因此任何缓存行都能种入它（strip 模式，
 * 既不丢弃也不抛错），纯 JSON 的缓存写入门槛也自然成立。 */
const fallbackStateSchema = z.object({})
type FallbackState = z.infer<typeof fallbackStateSchema>

/** 0.1.1 之前注册表契约的字段（见文件头说明）。 */
interface LegacyDefinitionShape<V> {
  schema: z.ZodType<V>
  view(state: FallbackState): V
}

/** 构造一个闸门单元；所有单元共用恒等折叠并提供冻结值，
 * 三者的差别只在 key、schema 和 payload。 */
function fallbackDefinition<K extends 'contextTimeline' | 'contextHeaders' | 'contextActivity'>(
  key: K,
  wireSchema: z.ZodType<SessionProjectionMap[K]>,
  value: SessionProjectionMap[K],
): ProjectionDefinition<K, FallbackState> & LegacyDefinitionShape<SessionProjectionMap[K]> {
  const view = (): SessionProjectionMap[K] => value
  return {
    key,
    stateSchema: fallbackStateSchema,
    init: () => ({}),
    apply: state => state,
    wire: { viewSchema: wireSchema, view },
    schema: wireSchema,
    view,
    stateVersion: 1,
  }
}

/** 低于基线的 harness 上全零的 `contextTimeline` 值；`unsupported` 就是 client
 * 渲染升级闸门所需的全部 payload。 */
export function createFallbackTimelineDefinition(current: string) {
  return fallbackDefinition('contextTimeline', contextTimelineSchema, {
    ok: true,
    unsupported: { current, minimum: BASELINE_DSH_VERSION },
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  })
}

/** 为空的 `contextHeaders` 值：没有解码出任何行，client 因此不画 header epoch。 */
export function createFallbackHeadersDefinition() {
  return fallbackDefinition('contextHeaders', contextHeadersSchema, { headers: [] })
}

/** 为空的 `contextActivity` 值：旧 host 的热力图宁可一天不显示，也不显示过期数据。 */
export function createFallbackActivityDefinition() {
  return fallbackDefinition('contextActivity', contextActivitySchema, { days: {} })
}
