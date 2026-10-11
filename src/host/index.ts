/**
 * dsh-cost-breakdown —— Host 这一半（已安装包的入口）。
 *
 * 一个普通的 Cordis 插件模块（ESM），由 harness 以 `dsh-cost-breakdown` loader 行加载。
 * projection 单元（`timeline.ts`、`headers.ts`、`activity.ts`）注册到
 * `ctx.sessionProjections`，折叠持久事件日志，再由 harness 把结果流式推给浏览器；
 * 唯一的例外是按需 detail 通道（detail.ts），它面向「正在查看」的 client 逐个提供沉重集合，
 * wire 值因此保持瘦身 head。
 *
 * session projection 注册表是硬依赖：注册表不存在时 Cordis 会让本插件一直处于 PENDING，
 * 而每次注册都是一个 effect，其 disposer 跟随发起调用的 fiber。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createContextActivityDefinition } from './activity'
import { createToolAttribution } from './attribution'
import { watchBalanceChannel } from './balance'
import { watchActivityBackfill } from './backfill'
import { makeColdReadGate } from './coldRead'
import { Config, resolveBounds } from './config'
import { watchDetailChannel } from './detail'
import { createFallbackActivityDefinition, createFallbackHeadersDefinition, createFallbackTimelineDefinition } from './fallback'
import { createContextHeadersDefinition } from './headers'
import { watchStepIdentity } from './stepIdentity'
import { watchSkillCatalog } from './skills'
import { createContextTimelineDefinition } from './timeline'
import { detectHarnessVersion } from './version'
import { meetsBaseline } from '../shared/version'

/** loader 行 id；Config 命名空间与设置表单的存储键都由它推导。 */
export const name = 'dsh-cost-breakdown'

/** 硬依赖：注册表不存在时 Cordis 会让本插件保持 pending。 */
export const inject = ['sessionProjections']

/** 同时以值（cordis 校验器）和类型（解析后的配置形状）两种身份重新导出。 */
export { Config } from './config'

/** 组装插件：先武装常驻路由，再注册闸门的回退单元或真实 fold 单元，
 * 最后装上 backfill watcher。 */
export function apply(ctx: Context, config: Config): void {
  // 两条路由只读运行时已验证的接口，且在闸门两侧都要工作，
  // 因此必须在下面闸门的提前返回之前武装好。
  watchBalanceChannel(ctx)
  watchSkillCatalog(ctx)
  // 低于基线的 harness 永远拿不到真实 fold（它的日志形状和接缝接口都在兼容矩阵之外）；
  // 回退单元提供全零数据加闸门记录。版本探测不出来时按放行处理，
  // 走下面正常的组装流程。
  const harnessVersion = detectHarnessVersion(ctx)
  if (harnessVersion !== undefined && !meetsBaseline(harnessVersion)) {
    // register() 会把 state 约束到 SessionProjectionStateMap 里声明的条目；闸门的不透明空 state
    // 有意不属于其中任何一条（本来就没折叠）——用 cast 绕过。
    ctx.sessionProjections.register(createFallbackTimelineDefinition(harnessVersion) as never)
    ctx.sessionProjections.register(createFallbackHeadersDefinition() as never)
    ctx.sessionProjections.register(createFallbackActivityDefinition() as never)
    return
  }
  // 在 toolSources.ts 的固定链条之上叠加；cordis 不支持或读取失败时回落到它。
  const attribution = createToolAttribution(ctx)
  watchStepIdentity(ctx)
  // detail 路由的冷档与概览预热共用这道闸门（coldRead.ts）。
  const coldReads = makeColdReadGate()
  // 单元的 view 每次服务都读闸门：detail 通道存活时出瘦身 wire，否则出内联值。
  const gate = watchDetailChannel(ctx, resolveBounds(config), coldReads)
  ctx.sessionProjections.register(createContextTimelineDefinition(config, () => gate.live))
  ctx.sessionProjections.register(createContextHeadersDefinition(name => attribution.ownerOf(name)))
  ctx.sessionProjections.register(createContextActivityDefinition(resolveBounds(config).holidays))
  watchActivityBackfill(ctx, coldReads)
}

/** 安装期的类型面：消费方从包入口导入这些 wire 模型名，
 * 而不是去声明它们的各个模块里取。 */
export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ActivityDay, ContextActivity, ContextHeaders, HeaderRecord, HeaderTool, ContextTimelineDetail, TimelineCounts, TimelineLast } from '../shared/types'
export type { PlatformBalance, PlatformBalanceEntry, SkillInfo } from '../shared/types'
export type { ActivityState } from './activity'
export type { TimelineState } from './foldState'
export type { HeadersState } from './headers'
