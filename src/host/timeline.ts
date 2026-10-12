/**
 * `contextTimeline` session projection 单元——插件的数据面。
 *
 * v0.9 数据通路迁移之后，Host 这一半就全在这里了：
 * 插件不再通过自建的`/dsh-cost-breakdown` RPC 通道提供快照，
 * 而是在 harness 的`ctx.sessionProjections` 注册表上注册一个纯 projection 单元。
 * 此后框架负责：- 按每条已提交的 `session/event` 驱动 fold（即时、
 * 增量），
 * - 通过 `ctx.sessionProjectionCache` 持久化该单元的 state （checkpoint 行、
 * 冷读阶梯、可安全恢复），
 * - 以 `session/projection` 推送帧加尾部页基线把
 * 结果投给浏览器， Client 在其中通过框架标准
 * 的 `useProjection('contextTimeline')` 座位读取。
 *
 * 该单元是纯数学（init/apply/view）——不持有任何订阅，
 * 也从不接触 client。 wire 值与 UI 一直以来渲染的 Snapshot 完全相同（shared/types.ts），
 * 因此 Client 无需改动。
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Config } from './config'
import { resolveBounds } from './config'
import type { ProjectionDefinition } from './compat'
import type { ContextTimeline } from '../shared/types'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import type { TimelineState } from './foldState'
import { buildTimelineHead, buildTimelineView } from './foldWire'

/** 在 wire payload 离开 host 之前校验它（strict：不允许漂移）。
 * 存活 surface 节点的 schema；用 `.strict()` 是为了让多出的字段直接导致本次服务失败，
 * 而不是悄悄带出一个未计价的属性。 */
const surfaceNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number().optional(),
  cat: z.enum(['user', 'inject', 'skill', 'assistant', 'tool']),
  tokens: z.number().int().nonnegative(),
  imgs: z.number().int().nonnegative().optional(),
  gone: z.number().int().nonnegative().optional(),
  form: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  tool: z.string().optional(),
  err: z.boolean().optional(),
  skill: z.string().optional(),
  calls: z.array(z.string()).optional(),
}).strict()

/** 一个存活的 system prompt 节点（shared/types.ts SystemPromptNode）。 */
const systemPromptNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  time: z.number(),
  tokens: z.number().int().nonnegative(),
}).strict()

/** wire 上的一条 request 记录；`net` 由 client 设置，因此这里有意不出现
 * （host 从不写它）。 */
const requestRecordSchema = z.object({
  turn: z.number().optional(),
  step: z.number().optional(),
  time: z.number(),
  seq: z.number(),
  system: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  inject: z.number().int().nonnegative(),
  assistant: z.number().int().nonnegative(),
  tool: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative().optional(),
  /** skill 机制内容的 token（issue #66）。fold 在每条记录上都会写；
   * 设为可选是为了让类别出现之前折叠的行照样能解析。 */
  skill: z.number().int().nonnegative().optional(),
  cacheRead: z.number().int().nonnegative().optional(),
  output: z.number().int().nonnegative().optional(),
  /** 该请求所属 step 的活跃毫秒数（见 RequestRecord.activeMs）。
   * 设为可选是为了让 step 从未闭合（存活尾部）的记录照样能解析。 */
  activeMs: z.number().nonnegative().optional(),
  stepCount: z.number().int().positive().optional(),
}).strict()

/** 时间线渲染的压缩/裁剪/注入/模型/模式事件行。 */
const contextEventSchema = z.object({
  seq: z.number(),
  time: z.number(),
  kind: z.enum(['compaction', 'prune', 'inject', 'model', 'mode']),
  form: z.string().optional(),
  tokens: z.number().optional(),
  count: z.number().optional(),
  sub: z.string().optional(),
  name: z.string().optional(),
  detail: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  fromTurn: z.number().optional(),
  fromStep: z.number().optional(),
  turn: z.number().optional(),
  step: z.number().optional(),
}).strict()

/** fold 推导出的文件操作记录（shared/types.ts FileOpRecord）。 */
const fileOpSchema = z.object({
  seq: z.number().int().nonnegative(),
  path: z.string(),
  kind: z.enum(['read', 'write', 'search']),
  tool: z.string(),
  time: z.number().optional(),
  err: z.boolean(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  detail: z.string().optional(),
  hits: z.number().int().positive().optional(),
  read: z.union([
    z.object({ start: z.number().int().positive(), count: z.number().int().nonnegative() }).strict(),
    z.object({ count: z.number().int().positive(), est: z.literal(true) }).strict(),
  ]).optional(),
  parent: z.number().int().nonnegative().optional(),
  program: z.string().optional(),
  pattern: z.literal(true).optional(),
  gone: z.number().int().nonnegative().optional(),
}).strict()

/** 时间条上绘制的一段区间（shared/types.ts TimingSpan）。 */
const timingSpanSchema = z.object({
  kind: z.enum(['ttft', 'reasoning', 'text', 'toolarg', 'tools', 'other']),
  start: z.number(),
  end: z.number(),
}).strict()

/** client 上下文环打印的信封构成数字。 */
const currentSchema = z.object({
  system: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  user: z.number().int().nonnegative(),
  inject: z.number().int().nonnegative(),
  skill: z.number().int().nonnegative(),
  assistant: z.number().int().nonnegative(),
  tool: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict()

const costBucketsSchema = z.object({
  uncached: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
}).strict()

/** 一组计费分桶；两个时段键都可选，
 * 因此从不拆分时段的 provider 只留 `peak`。 */
const costModelSchema = z.object({
  peak: costBucketsSchema.optional(),
  off: costBucketsSchema.optional(),
}).strict()

const costModelsSchema = z.record(z.string(), costModelSchema)

/** session 成本的 wire 形状——每个提供该值的 projection 共用（activity.ts 会 import 它）。 */
export const costUsageSchema = z.record(z.string(), costModelsSchema)

/** 会话级按 (provider, model) 的请求次数。 */
export const callCountsSchema = z.record(z.string(), z.record(z.string(), z.number().int().nonnegative()))

/** 平台按次积分费率：`<provider>:<model>` → 每次请求的积分。 */
export const creditRatesSchema = z.record(z.string(), z.record(z.string(), z.number().nonnegative()))

/** 每轮消费账本：turn 字符串 → { 该轮的会话级同形账本, 按 provider/model 的请求次数 }。 */
export const turnCostUsageSchema = z.record(z.string(), z.object({
  usage: costUsageSchema,
  requests: z.record(z.string(), z.record(z.string(), z.number().int().nonnegative())),
}).strict())

const toolTimingSchema = z.object({
  calls: z.number().int().nonnegative(),
  ms: z.number().nonnegative(),
}).strict()

/** wire 上整个 session 的计时汇总；
 * 每个拆分字段都是可叠加的可选字段（见行内说明）。 */
const timingTotalsSchema = z.object({
  wallMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative(),
  genMs: z.number().nonnegative(),
  // 可叠加的可选字段：在生成阶段拆分、块计数或吞吐口径出现之前缓存的行必须照样能解析。
  reasoningMs: z.number().nonnegative().optional(),
  reasoningBlocks: z.number().int().nonnegative().optional(),
  textMs: z.number().nonnegative().optional(),
  textBlocks: z.number().int().nonnegative().optional(),
  toolArgMs: z.number().nonnegative().optional(),
  toolArgBlocks: z.number().int().nonnegative().optional(),
  speedTokens: z.number().nonnegative().optional(),
  speedMs: z.number().nonnegative().optional(),
  calls: z.number().int().nonnegative(),
  toolsMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  tools: z.record(z.string(), toolTimingSchema),
}).strict()

/** 回退单元提供的基线闸门记录（见 fallback.ts）。 */
const unsupportedSchema = z.object({
  current: z.string(),
  minimum: z.string(),
}).strict()

/** 统计面板预先算好的计数（拆分 head——见 Snapshot.counts）。 */
const countsSchema = z.object({
  turns: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  injects: z.number().int().nonnegative(),
  compactions: z.number().int().nonnegative(),
  prunes: z.number().int().nonnegative(),
  // 与每个在 view 期推导的 head 字段一样是可叠加的可选字段：缓存行恢复时会带着它完整的事件集。
  skills: z.number().int().nonnegative().optional(),
}).strict()

/** 最新一条保留请求的计费摘要（拆分 head 的标题锚点）。 */
const lastSchema = z.object({
  seq: z.number(),
  total: z.number().int().nonnegative(),
  prompt: z.number().int().nonnegative().optional(),
}).strict()

/** 两代共用一份 wire 契约：「拆分」head（信封标量 + counts/last/detailRev；
 * 沉重集合缺席——它们走按需 detail 通道 host/detail.ts）
 * 与「内联」值（无独立通道的 host 和回退单元把集合就地带上）。
 * 因此集合在 schema 里是可选的；
 * 拆分标记是 `detailRev`（出现 ⟺ 处于拆分形态）。 */
export const contextTimelineSchema = z.object({
  ok: z.literal(true),
  unsupported: unsupportedSchema.optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  contextWindow: z.number().optional(),
  current: currentSchema,
  images: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  humanInputs: z.number().int().nonnegative().optional(),
  // 与 humanInputs 一样是可叠加的可选字段：字段出现之前折叠的行读不到它，client 会退化为 0。
  answers: z.number().int().nonnegative().optional(),
  lastUser: z.string().optional(),
  counts: countsSchema.optional(),
  last: lastSchema.optional(),
  detailRev: z.number().int().nonnegative().optional(),
  requests: z.array(requestRecordSchema).optional(),
  events: z.array(contextEventSchema).optional(),
  cost: costUsageSchema.optional(),
  turnCost: turnCostUsageSchema.optional(),
  calls: callCountsSchema.optional(),
  creditRates: creditRatesSchema.optional(),
  timing: timingTotalsSchema.optional(),
  systems: z.array(systemPromptNodeSchema).optional(),
  nodes: z.array(surfaceNodeSchema).optional(),
  droppedNodes: z.number().int().nonnegative().optional(),
  archive: z.array(surfaceNodeSchema).optional(),
  surfaceFloor: z.number().int().nonnegative().optional(),
  archiveFloor: z.number().int().nonnegative().optional(),
  fileOps: z.array(fileOpSchema).optional(),
  fileOpsFloor: z.number().int().nonnegative().optional(),
  spans: z.array(timingSpanSchema).optional(),
}).strict() as unknown as z.ZodType<ContextTimeline>

/** 持久 fold state 的 schema（注册表的 `stateSchema` 契约）。在 checkpoint 行种入 fold
 * 之前校验纯 JSON 的 `TimelineState`——与 projection 缓存的纯 JSON 前提在写入时
 * 已经强制的是同一种形状保证。 */
const timelineStateSchema = z.object({
  surface: z.array(surfaceNodeSchema),
  sums: z.object({
    user: z.number().int().nonnegative(),
    inject: z.number().int().nonnegative(),
    skill: z.number().int().nonnegative(),
    assistant: z.number().int().nonnegative(),
    tool: z.number().int().nonnegative(),
  }).strict(),
  systemTokens: z.number().int().nonnegative(),
  systems: z.array(systemPromptNodeSchema).optional(),
  toolsTokens: z.number().int().nonnegative(),
  model: z.string().optional(),
  provider: z.string().optional(),
  lastModel: z.string().optional(),
  contextWindow: z.number().optional(),
  requests: z.array(requestRecordSchema),
  turnRuns: z.number().int().nonnegative().optional(),
  events: z.array(contextEventSchema),
  archived: z.array(surfaceNodeSchema),
  cost: costUsageSchema.optional(),
  turnCost: turnCostUsageSchema.optional(),
  calls: callCountsSchema.optional(),
  archiveFloor: z.number().optional(),
  timing: timingTotalsSchema.optional(),
  humanInputs: z.number().int().nonnegative().optional(),
  answers: z.number().int().nonnegative().optional(),
  lastUser: z.string().optional(),
  stepStart: z.object({
    time: z.number(),
    firstToken: z.number().optional(),
  }).strict().optional(),
  stepWaits: z.array(z.object({ start: z.number(), end: z.number() }).strict()).optional(),
  stepApprovals: z.record(z.string(), z.number()).optional(),
  stepRequestSeq: z.number().optional(),
  callNames: z.record(z.string(), z.object({ name: z.string(), start: z.number(), argsRaw: z.string().optional() }).strict()),
  pendingShadowedSeqs: z.array(z.number()).optional(),
  pendingShadowEventSeq: z.number().optional(),
  detailRev: z.number().int().nonnegative().optional(),
  fileOps: z.array(fileOpSchema),
  fileOpsFloor: z.number().int().nonnegative().optional(),
  spans: z.array(timingSpanSchema),
  stepSpans: z.array(timingSpanSchema).optional(),
  pendingCodeOps: z.record(z.string(), z.array(fileOpSchema)).optional(),
}) as unknown as z.ZodType<TimelineState>

/**
 * `contextTimeline` projection 单元，每个插件实例各建一份，带上配置解析出的保留上限。
 *
 * 只有单元携带 `wire` 块时注册表才会提供该值；
 * 没有它的单元仅属 host， Context 标签页会永远停在加载界面。
 *
 * `slim` 每次服务都重新决定 wire 世代，是存活性探测而非固定开关：
 * 按需 detail 通道存活时值为瘦身 head；
 * 在它武装之前（或部署里 connection service 始终不装配时），内联值让标签页端到端可用。
 * 两代都通过同一份 schema 校验、折叠同一份 state，因此拆分只影响视图。
 */
export function createContextTimelineDefinition(config: Config, slim: () => boolean): ProjectionDefinition<'contextTimeline', TimelineState> {
  const bounds = resolveBounds(config)
  const view = (state: TimelineState): ContextTimeline =>
    slim() ? buildTimelineHead(state) : buildTimelineView(state, bounds)
  const definition: ProjectionDefinition<'contextTimeline', TimelineState> = {
    key: 'contextTimeline',
    stateSchema: timelineStateSchema,
    wire: { viewSchema: contextTimelineSchema, view },
    init: () => createTimelineState(),
    apply: (state: TimelineState, event: SessionEvent) => applyTimeline(state, event as Parameters<typeof applyTimeline>[1], bounds),
    // 只要持久 state 的形状或 fold 语义变化就抬高版本，
    // 这会让缓存行失效并促使它们从持久日志重新折叠。日志仍能补算的字段、
    // 或 view 在服务时推导的字段，则「不能」抬高：
    // 让同代所有行失效会让空闲 session 的键孤悬，而它们在重新活跃之前没有刷新通道。
    // 29：峰谷分桶改为按模型判定（官方价目表收录的模型无论走哪条路由都按时段计费），
    // 已有的 `peak` 桶需要按同一规则重折，否则代理路由下的历史用量会一直算错。
    stateVersion: 29,
  }
  return definition
}
