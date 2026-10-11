/**
 * 客户端的 harness 边界：本插件消费的 harness web 半侧界面，
 * 以及把每个下发值重新校验一遍的清洗器。
 *
 * 这些接口只是类型——运行时服务来自用户的 harness，
 * 因此每个面孔都要在自己的调用点重新校验。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import { estimateSystemTokens } from '../shared/estimate'
import type { ActivityDay, ContextActivity, ContextBreakdown, ContextHeaders, ContextPressure, ContextTimeline, CostModelUsage, HeaderEpochContent, SystemPromptNode, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

/** 字典服务。`bind` 返回绑定到某个命名空间的翻译函数——组件只应
 *  持有这一种写法，因为未绑定的 `t` 会丢掉命名空间。 */
export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  getLocale?(): { active: string }
}

/** 一条 slot 注册。`name` 选择座位；`id`/`key` 区分同一座位里的多个
 *  条目（带键的座位会挂载键为当前值的条目，例如 `main`）。 */
export interface SlotRegistration {
  name: string
  id?: string
  order?: number
  key?: string
  /** 字典命名空间；框架据此合成 `t` 座位。 */
  locale?: string
  label?: () => string
  inject?: (sessionId?: string) => unknown
}

/** slot 服务。`inject` 返回该注册的**清理函数**（即其回调的返回值），
 *  这也是调用方要把它收进自己的清理函数列表的原因。 */
export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  ): unknown
}

/** 右侧 Sidebar 标签页类型所贡献的 harness `SidebarRightGuideEntry` 子集。 */
export interface SidebarGuideEntryLike {
  order: number
  title: () => string
  description?: () => string
  icon?: ComponentType<{ size?: number }>
}

/** 注册表接受的标签**类型**：`kind` 是面板 slot 所用的标识键，
 *  `id` 是实例。为什么两者都带命名空间，见 sidebar.ts。 */
export interface SidebarTabDefinitionLike {
  id: string
  kind: string
  title: () => string
  guide?: readonly SidebarGuideEntryLike[]
}

/** 右侧 Sidebar 的标签类型注册表（`ctx.sidebarRightTabs`），经由延迟
 * inject 触达：没有它的部署也能完整组装（不留挂起 fiber，不抛错）。 */
export interface SidebarTabsFace {
  register(definition: SidebarTabDefinitionLike): () => void
}

/** 右侧 Sidebar 的导航面孔（`ctx.sidebarRight`）：`openResource`
 * 经由随附的预览类型认领 `dsh-resource://file/…` 地址。
 * 它缺失或拒绝时，调用方回退到系统打开方式。 */
export interface SidebarResourceFace {
  openResource(address: string): void
}

/** 已定稿的聊天节点：它携带来源 surface 事件的 `seq`，因此
 * 浏览器按 `seq` 连接其节点，而不是去投影它们的内容。 */
export interface ConversationNodeLike {
  kind: string
  seq: number
  /** 持久消息 id；合成/被中断的回复上不存在。 */
  messageId?: unknown
  content?: readonly unknown[]
  blocks?: readonly unknown[]
  call?: { name: string; argsRaw: string } | null
  isError?: boolean
  summary?: string | null
  /** PTC `run_code` 派发的嵌套 dsh ToolCallBlock[] 树；在 fileActivity 中按结构重新校验。 */
  subCalls?: readonly unknown[]
  /** 工具结果的展示 meta（例如搜索命中的文件），按连接交付的形态。 */
  meta?: unknown
}

/** dsh 的 `ImageAttachmentRef`，重新声明类型以免依赖附件包。
 * 持久日志只保存这个引用，从不内联字节。 */
export interface ImageRefLike {
  attachmentId: string
  name?: string
  bytes?: number
  width?: number
  height?: number
  originalDimensions?: { width: number; height: number }
}

/** 加载某个附件的展示 URL。宁可 reject（或抛错）也不返回空
 *  字符串，图片卡片因此能展示其不可用状态。 */
export type ImageLoader = (attachment: ImageRefLike) => Promise<string>

/** 聊天的附件服务，各处都是可选的：没有它时，图片节点渲染成
 *  只有元数据的卡片，而不是让整个节点失败。 */
export interface UiConversationFace {
  imageUrl?(sessionId: string, attachment: ImageRefLike): Promise<string>
}

/** 经 session 授权的图片加载器；服务缺失或不可信时为 undefined（只渲染元数据卡片）。 */
export function imageLoaderOf(
  ctx: ClientCtx,
  sessionId: string | undefined,
): ImageLoader | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const conversation = ctx.get('uiConversation') as UiConversationFace | undefined
    if (conversation !== undefined && typeof conversation.imageUrl === 'function') {
      const imageUrl = conversation.imageUrl.bind(conversation)
      return attachment => imageUrl(sessionId, attachment)
    }
  } catch { /* 服务缺失或不可信——只渲染元数据卡片 */ }
  return undefined
}

/** `useChat` 座位。选择器必须返回引用稳定的切片：新建的对象会让视图在每次事件时都重渲染。 */
export type UseChatLike = <T>(selector: (snapshot: unknown) => T) => T

/** `ChatSnapshot.legacy.nodes`；座位没有交付真正的数组时为 undefined，调用方不连接照常渲染。 */
export function conversationNodesOf(props: {
  useChat?: UseChatLike
}): readonly ConversationNodeLike[] | undefined {
  const useChat: unknown = props.useChat
  if (typeof useChat !== 'function') return undefined
  try {
    // `s.legacy` 是稳定对象；该数组在选择器之外读取。
    const slice = (useChat as UseChatLike)((s: unknown) =>
      s !== null && typeof s === 'object' ? (s as { legacy?: unknown }).legacy : undefined)
    const nodes = slice !== null && typeof slice === 'object' ? (slice as { nodes?: unknown }).nodes : undefined
    return Array.isArray(nodes) ? nodes as readonly ConversationNodeLike[] : undefined
  } catch { /* 座位不可信——连接退化为空 */ }
  return undefined
}

/** session 作用域 slot 组件的框架标准 kit。 */
export interface SessionStandardProps {
  sessionId?: string
  useProjection?: (key: string) => unknown
  /** 聊天视图快照座位。 */
  useChat?: UseChatLike
}

/** 同一套 kit 限定到右侧 Sidebar 的版本：它那一列太窄，装不下头部
 *  卡片；`host: 'sidebar'` 是视图分支所依据的唯一开关。 */
export interface ContextViewProps extends SessionStandardProps {
  /** 只由右侧 Sidebar 的注册设置；它会把窄列装不下的头部卡片去掉。 */
  host?: 'sidebar'
}

/** 经由标准座位读取一个投影键，并在边界处收窄。该座位是 hook：
 * 必须在组件顶部无条件调用，每个键一次，且顺序稳定。 */
export function projectionOf<T>(props: SessionStandardProps, key: string, narrow: (value: unknown) => T | null): T | null {
  if (typeof props.useProjection !== 'function') return null
  return narrow(props.useProjection(key))
}

/** 每个插件模块都以它而不是裸的 `Context` 为类型，两个硬性
 *  inject（`slots`、`locale`）因此是编译期事实：index.ts 只声明这两个，
 *  其他服务一律通过延迟 inject 或 `get` 触达。 */
export type ClientCtx = Context & {
  locale: LocaleService
  slots: SlotsService
}

/** 边界类型刻意是 `Record<string, unknown>`，因此每次字段读取都要先自证有效再借用 wire 类型。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

/** 字段缺失、非数字或为 NaN 时退化为 0。 */
export function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function objectsOf<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is T => v !== null && typeof v === 'object')
}

/** 完整快照（timelineOf）与分离 detail（timelineSource.ts）共用的集合/下限块。
 *
 *  `fileOps`/`spans` 以「是否存在」为准，其他集合则不然：键**缺失**意味着
 *  较旧的 host 从未折叠过它们（卡片随之走旧路径），这一点必须与
 *  host 服务了一个空列表的情况保持可区分。 */
export function collectionsOf(data: Record<string, unknown>): Pick<ContextTimeline,
  'requests' | 'events' | 'nodes' | 'droppedNodes' | 'archive'
  | 'surfaceFloor' | 'archiveFloor' | 'fileOps' | 'fileOpsFloor' | 'spans'> {
  return {
    requests: objectsOf(data.requests),
    events: objectsOf(data.events),
    nodes: objectsOf(data.nodes),
    droppedNodes: numOf(data.droppedNodes),
    archive: objectsOf(data.archive),
    ...(typeof data.surfaceFloor === 'number' ? { surfaceFloor: data.surfaceFloor } : {}),
    ...(typeof data.archiveFloor === 'number' ? { archiveFloor: data.archiveFloor } : {}),
    ...(data.fileOps !== undefined ? { fileOps: objectsOf(data.fileOps) } : {}),
    ...(typeof data.fileOpsFloor === 'number' ? { fileOpsFloor: data.fileOpsFloor } : {}),
    ...(data.spans !== undefined ? { spans: objectsOf(data.spans) } : {}),
  }
}

/** null/原始值条目能通过裸的 `Array.isArray`，却会在第一次取属性时抛错，因此它走清洗慢路径。 */
function recordsOnly(value: unknown): boolean {
  return Array.isArray(value) && value.every(e => e !== null && typeof e === 'object')
}

/** host 的基线闸门记录（host/fallback.ts）；不是两个版本字符串就退化为 null。 */
export function unsupportedOf(value: unknown): { current: string; minimum: string } | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.current !== 'string' || typeof data.minimum !== 'string') return null
  return { current: data.current, minimum: data.minimum }
}

/** session 成本的原材料：未通过校验的分支整支丢弃、各桶清零，垃圾数据因此计价为 0，绝不为 NaN。 */
function costOf(value: unknown): ContextTimeline['cost'] | undefined {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return undefined
  const out: NonNullable<ContextTimeline['cost']> = {}
  for (const provider of Object.keys(data)) {
    const models = asRecord(data[provider])
    if (models === null || Array.isArray(models)) continue
    const branch: Record<string, CostModelUsage> = {}
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) continue
      const copy: CostModelUsage = {}
      for (const period of ['peak', 'off'] as const) {
        const b = asRecord(periods[period])
        if (b === null || Array.isArray(b)) continue
        copy[period] = {
          uncached: numOf(b.uncached),
          cacheRead: numOf(b.cacheRead),
          cacheWrite: numOf(b.cacheWrite),
          output: numOf(b.output),
        }
      }
      branch[model] = copy
    }
    out[provider] = branch
  }
  return out
}

/** 成本块走快路径的前置条件：每个 provider **以及**每个模型分支
 *  都必须是记录。它刻意只检查到这层深度——桶字段本身就是数字，
 *  由 `numOf` 处理——这样既便宜到能跑在每次投影读取上，
 *  又能把非记录形态路由到清洗路径。 */
function costFastOk(value: unknown): boolean {
  if (value === undefined) return true
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  return Object.keys(data).every((provider) => {
    const models = asRecord(data[provider])
    return models !== null && !Array.isArray(models)
  })
}

/** 把下发的投影值收窄成**渲染安全**的 context timeline：非记录
 * 保持 `null`（调用方显示加载界面），而不符合 wire 形态的记录会被
 * **清洗**，损坏的载荷因此不会在渲染期间抛错并把对话视图卸载掉。 */
export function timelineOf(value: unknown): ContextTimeline | null {
  const data = asRecord(value)
  if (data === null) return null
  const current = data.current
  // 快路径形态检查：host 总会下发完整的数字 breakdown 与真实集合；其他情况则在下面重建。
  const numericBreakdown = current !== null && typeof current === 'object'
    && ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool', 'total']
      .every(k => typeof (current as Record<string, unknown>)[k] === 'number')
  if (numericBreakdown
    && recordsOnly(data.requests)
    && recordsOnly(data.events)
    && recordsOnly(data.nodes)
    && recordsOnly(data.archive)
    && systemsFastOk(data.systems)
    && timingFastOk(data.timing)
    && costFastOk(data.cost)) {
    // 原样透传让该值对选择器的等值判断保持引用稳定。
    return data as unknown as ContextTimeline
  }
  const safeCurrent: Record<string, unknown> = current !== null && typeof current === 'object' ? current as Record<string, unknown> : {}
  const cost = costOf(data.cost)
  const timing = timingOf(data.timing)
  // 基线闸门记录能挺过清洗：没过快路径的兜底载荷仍必须能弹出闸门模态框。
  const unsupported = unsupportedOf(data.unsupported)
  // 分离生成方式的 head 字段同样能挺过清洗。
  const counts = countsOf(data.counts)
  const last = lastOf(data.last)
  const safe: ContextTimeline = {
    ok: true,
    ...(unsupported !== null ? { unsupported } : {}),
    ...(typeof data.model === 'string' ? { model: data.model } : {}),
    ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
    ...(typeof data.contextWindow === 'number' ? { contextWindow: data.contextWindow } : {}),
    current: {
      system: numOf(safeCurrent.system),
      tools: numOf(safeCurrent.tools),
      user: numOf(safeCurrent.user),
      inject: numOf(safeCurrent.inject),
      skill: numOf(safeCurrent.skill),
      assistant: numOf(safeCurrent.assistant),
      tool: numOf(safeCurrent.tool),
      total: numOf(safeCurrent.total),
    },
    ...collectionsOf(data),
    ...(typeof data.images === 'number' ? { images: data.images } : {}),
    ...(typeof data.toolCalls === 'number' ? { toolCalls: data.toolCalls } : {}),
    ...(typeof data.humanInputs === 'number' ? { humanInputs: data.humanInputs } : {}),
    ...(typeof data.answers === 'number' && Number.isFinite(data.answers) ? { answers: data.answers } : {}),
    ...(typeof data.lastUser === 'string' && data.lastUser !== '' ? { lastUser: data.lastUser.slice(0, 200) } : {}),
    ...(counts !== undefined ? { counts } : {}),
    ...(last !== undefined ? { last } : {}),
    ...(typeof data.detailRev === 'number' && Number.isFinite(data.detailRev) ? { detailRev: data.detailRev } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(timing !== null ? { timing } : {}),
    ...(data.systems !== undefined ? { systems: systemsOf(data.systems) } : {}),
  }
  return safe
}

/** 按 seq 排序的活跃 system prompt 节点；某个条目被丢弃时，浏览器就停在 header 世代。 */
function systemsOf(value: unknown): ContextTimeline['systems'] {
  const list = objectsOf<Record<string, unknown>>(value)
  const out: SystemPromptNode[] = []
  for (const entry of list) {
    const { seq, time, tokens } = entry
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) continue
    out.push({ seq, time, tokens })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

/** 每个条目都必须带有限的 `seq`/`time`/`tokens`，否则载荷走清洗慢路径。 */
function systemsFastOk(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    const { seq, time, tokens } = entry as Record<string, unknown>
    return typeof seq === 'number' && Number.isFinite(seq)
      && typeof time === 'number' && Number.isFinite(time)
      && typeof tokens === 'number' && Number.isFinite(tokens)
  })
}

/** 分离 head 的计数；缺失就保持缺失（旧生成方式），调用方从各集合自行推导计数。 */
function countsOf(value: unknown): ContextTimeline['counts'] {
  const data = asRecord(value)
  if (data === null) return undefined
  return {
    turns: numOf(data.turns),
    steps: numOf(data.steps),
    injects: numOf(data.injects),
    compactions: numOf(data.compactions),
    prunes: numOf(data.prunes),
    skills: numOf(data.skills),
  }
}

function lastOf(value: unknown): ContextTimeline['last'] {
  const data = asRecord(value)
  if (data === null) return undefined
  if (typeof data.seq !== 'number' || !Number.isFinite(data.seq)) return undefined
  if (typeof data.total !== 'number' || !Number.isFinite(data.total)) return undefined
  return {
    seq: data.seq,
    total: data.total,
    ...(typeof data.prompt === 'number' && Number.isFinite(data.prompt) ? { prompt: data.prompt } : {}),
  }
}

/** token 计量的 `contextPressure` 投影。它的三个字段是不同时刻各自独立、
 * 后者覆盖前者的记录（dsh 的 `ContextPressureProjection`），因此各自单独校验；某个值缺失时，调用方就转向自己推导的锚点。 */
export function contextPressureOf(value: unknown): ContextPressure | null {
  const data = asRecord(value)
  if (data === null) return null
  const out: ContextPressure = {}
  if (typeof data.pressureTokens === 'number' && Number.isFinite(data.pressureTokens)) out.pressureTokens = data.pressureTokens
  if (typeof data.projectedTokens === 'number' && Number.isFinite(data.projectedTokens)) out.projectedTokens = data.projectedTokens
  if (typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow)) out.contextWindow = data.contextWindow
  return out
}

/** token 计量的 `contextBreakdown` 投影；值不完整时退化为 null，卡片改用折叠自身的汇总值。 */
export function contextBreakdownOf(value: unknown): ContextBreakdown | null {
  const data = asRecord(value)
  if (data === null) return null
  const { systemTokens, toolsTokens, messageTokens } = data
  if (typeof systemTokens !== 'number' || !Number.isFinite(systemTokens)) return null
  if (typeof toolsTokens !== 'number' || !Number.isFinite(toolsTokens)) return null
  if (typeof messageTokens !== 'number' || !Number.isFinite(messageTokens)) return null
  return { systemTokens, toolsTokens, messageTokens }
}

/** token 计量的 `tokenUsage` 投影。其 wire schema 要求四个桶齐全
 * （dsh token-meter 的 `projectionSchema`），因此值不完整时整体
 * 退化为 null，而不是少算计费总量。 */
export function tokenUsageOf(value: unknown): TokenUsage | null {
  const data = asRecord(value)
  if (data === null) return null
  const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = data
  if (typeof uncachedInputTokens !== 'number' || !Number.isFinite(uncachedInputTokens)) return null
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return null
  if (typeof cacheReadTokens !== 'number' || !Number.isFinite(cacheReadTokens)) return null
  if (typeof cacheWriteTokens !== 'number' || !Number.isFinite(cacheWriteTokens)) return null
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

/** NaN 或负值退化为 0，而不会渗进甜甜圈的份额里。 */
function msNumOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 可选的时长标量；不是非负数字就保持 undefined，该字段因此绝不会实体化成 0。 */
function optNumOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** `timelineOf` 透传路径的整值检查；不是形态良好的 timing 对象就走清洗慢路径。 */
function timingFastOk(value: unknown): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const t = value as Record<string, unknown>
  for (const k of ['wallMs', 'ttftMs', 'genMs', 'calls', 'toolsMs', 'toolCalls']) {
    if (typeof t[k] !== 'number') return false
  }
  // 可选的分块标量必须通过与慢路径相同的非负检查。
  for (const k of ['reasoningMs', 'textMs', 'toolArgMs', 'reasoningBlocks', 'textBlocks', 'toolArgBlocks']) {
    const v = t[k]
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return false
  }
  const tools = t.tools
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) return false
  for (const k in tools) {
    const row = (tools as Record<string, unknown>)[k]
    if (row === null || typeof row !== 'object') return false
    if (typeof (row as Record<string, unknown>).calls !== 'number') return false
    if (typeof (row as Record<string, unknown>).ms !== 'number') return false
  }
  return true
}

/** 把下发的 TimingTotals 收窄成渲染安全的形态；某一行不合形态只丢它自己，排名绝不会因此变空。 */
export function timingOf(value: unknown): TimingTotals | null {
  const data = asRecord(value)
  if (data === null) return null
  const tools: Record<string, ToolTimingTotals> = {}
  const rawTools = data.tools
  if (rawTools !== null && typeof rawTools === 'object' && !Array.isArray(rawTools)) {
    for (const k in rawTools) {
      // 自有键 '__proto__' 会去设置原型，而不是成为一个行。
      if (k === '__proto__' || !Object.hasOwn(rawTools, k)) continue
      const row = (rawTools as Record<string, unknown>)[k]
      if (row === null || typeof row !== 'object') continue
      const calls = (row as Record<string, unknown>).calls
      const ms = (row as Record<string, unknown>).ms
      // 写 `!(calls >= 0)` 而不是 `calls < 0`：前者连 NaN 也一并拒绝。
      if (typeof calls !== 'number' || !(calls >= 0) || typeof ms !== 'number' || !(ms >= 0)) continue
      tools[k] = { calls, ms }
    }
  }
  const totals: TimingTotals = {
    wallMs: msNumOf(data.wallMs),
    ttftMs: msNumOf(data.ttftMs),
    genMs: msNumOf(data.genMs),
    calls: msNumOf(data.calls),
    toolsMs: msNumOf(data.toolsMs),
    toolCalls: msNumOf(data.toolCalls),
    tools,
  }
  // host 没有下发时可选标量保持缺失，卡片因此渲染未拆分的形态，而不是一堆无意义的零。
  const reasoning = optNumOf(data.reasoningMs)
  if (reasoning !== undefined) totals.reasoningMs = reasoning
  const reasoningBlocks = optNumOf(data.reasoningBlocks)
  if (reasoningBlocks !== undefined) totals.reasoningBlocks = reasoningBlocks
  const textMs = optNumOf(data.textMs)
  if (textMs !== undefined) totals.textMs = textMs
  const textBlocks = optNumOf(data.textBlocks)
  if (textBlocks !== undefined) totals.textBlocks = textBlocks
  const toolArgMs = optNumOf(data.toolArgMs)
  if (toolArgMs !== undefined) totals.toolArgMs = toolArgMs
  const toolArgBlocks = optNumOf(data.toolArgBlocks)
  if (toolArgBlocks !== undefined) totals.toolArgBlocks = toolArgBlocks
  return totals
}

/**
 * 插件的 `contextHeaders` 投影：请求 header 世代的**元数据**
 * （边界、token 价格、归因）；世代**内容**按需抓取
 * （historyPage.ts），从不在这里携带。
 *
 * 一个畸形的世代会把**整个**投影退化为 null，因为下游读取会
 * 盲目地调用 `tool.name.toLowerCase()` 和 `b.tokens - a.tokens`
 * 而不做检查。
 *
 * #37 之前、从缓存提供服务的 host 仍会在 token 价格的位置上
 * 携带 system **文本**，因此未定价的条目在这里套用共用的计量
 * 启发式。
 */
/** 把 `contextHeaders` 投影校验成渲染安全的值。单个坏世代为何
 *  会让**整个**投影变 null，见上方的块注释。 */
export function headersOf(value: unknown): ContextHeaders | null {
  const headers = asRecord(value)
  if (headers === null || !Array.isArray(headers.headers)) return null
  for (const h of headers.headers as unknown[]) {
    if (h === null || typeof h !== 'object') return null
    const entry = h as { tools?: unknown; systemTokens?: unknown }
    if (!Array.isArray(entry.tools)) return null
    if (entry.systemTokens !== undefined && (typeof entry.systemTokens !== 'number' || !Number.isFinite(entry.systemTokens))) return null
    for (const t of entry.tools as unknown[]) {
      if (t === null || typeof t !== 'object') return null
      const tool = t as { name?: unknown; tokens?: unknown; plugin?: unknown }
      if (typeof tool.name !== 'string') return null
      if (typeof tool.tokens !== 'number' || !Number.isFinite(tool.tokens)) return null
      if (tool.plugin !== undefined && typeof tool.plugin !== 'string') return null
    }
  }
  let legacy = false
  for (const entry of headers.headers as { systemTokens?: unknown; system?: unknown }[]) {
    if (entry.systemTokens === undefined && typeof entry.system === 'string' && entry.system !== '') {
      legacy = true
      break
    }
  }
  if (!legacy) return headers as unknown as ContextHeaders
  // #37 之前的形态把 system 文本放在如今年 token 价格所在的位置。就地
  // 重写（而不是丢弃这些世代）让其他元数据读取继续可用，而
  // `|| undefined` 为估算为零的情况保留「未定价」，而不是实体化一个 0。
  return {
    headers: (headers.headers as { systemTokens?: number; system?: unknown }[]).map((entry) => {
      if (entry.systemTokens !== undefined) return entry
      return { ...entry, systemTokens: estimateSystemTokens(entry.system) || undefined }
    }),
  } as unknown as ContextHeaders
}

/** Overview 热力图与用量图背后的按日 `contextActivity` 账本。缺失即
 * 保持 null（较旧的 host 不提供该键）；按日重新校验只丢弃坏条目或坏费用。 */
/** 校验按日的 `contextActivity` 投影。`dirty` 记录是否有**任何**条目
 *  需要修复，它决定是原样透传原对象（引用稳定，利于
 *  `useMemo`）还是返回重建后的对象。 */
export function activityOf(value: unknown): ContextActivity | null {
  const data = asRecord(value)
  if (data === null) return null
  const rawDays = asRecord(data.days)
  if (rawDays === null || Array.isArray(rawDays)) return null
  const days: Record<string, ActivityDay> = {}
  let dirty = false
  for (const key of Object.keys(rawDays)) {
    const entry = asRecord(rawDays[key])
    const tokens = entry?.tokens
    const requests = entry?.requests
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)
      || entry === null || Array.isArray(entry)
      || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0
      || typeof requests !== 'number' || !Number.isFinite(requests) || requests < 0) {
      // 日键必须是本地的 `YYYY-MM-DD`：热力图与日期过滤按字典序比较
      // 这些键（shared/days.ts），写法一错就会静默地永远匹配不上。
      dirty = true
      continue
    }
    // 该日的计价记录（可选可加）；结果为空则整条丢弃（空 ≠ 零），该日的数字照常保留。
    const proved = costOf(entry.cost)
    const cost = proved !== undefined && Object.keys(proved).length > 0 ? proved : undefined
    if (entry.cost !== undefined && cost === undefined) dirty = true
    // 该日的技能表（可选可加）：畸形的统计只丢弃对应的那个名字。
    const skills = skillTalliesOf(entry.skills)
    if (entry.skills !== undefined && skills === undefined) dirty = true
    days[key] = {
      tokens,
      requests,
      ...(cost !== undefined ? { cost } : {}),
      ...(skills !== undefined ? { skills } : {}),
    }
  }
  // 原样透传让该值对选择器的等值判断保持引用稳定。
  return dirty ? { days } : data as unknown as ContextActivity
}

/** 某日的技能加载表；一个名字需要有限的计数与加载时刻，清洗后为空的记录整条丢弃。 */
function skillTalliesOf(value: unknown): ActivityDay['skills'] | undefined {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return undefined
  const skills: Record<string, { n: number; last: number }> = {}
  let any = false
  for (const name of Object.keys(data)) {
    const tally = asRecord(data[name])
    const n = tally?.n
    const last = tally?.last
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0
      || typeof last !== 'number' || !Number.isFinite(last)) continue
    skills[name] = { n, last }
    any = true
  }
  return any ? skills : undefined
}

/** '/' 菜单中的一行。整条记录大量字段可选，因为 harness 的菜单
 *  只会渲染其自身契约允许的子集，而字段缺失意味着「随附的
 *  默认值」，而不是「空」。 */
export interface TriggerCandidate {
  name: string
  /** 展示标题；缺失时用名字本身（标题不同时会把名字作为尾随别名渲染）。 */
  label?: string
  /** 该候选项所属分组的可视标题；它存在时会抑制菜单的来源标题行。 */
  section?: string
  description?: string
  /** 行字形，按 16px 边长渲染。 */
  icon?: ComponentType<{ size?: number }>
}

/** 挑选那一刻触发 token span 的快照（draftRev CAS）。 */
export interface TokenSpan {
  start: number
  end: number
  draftRev: number
}

/** 输入外壳移交过来的挑选结果：被选中的候选项，加上它所在的 session
 *  与 token span；打开路径会把这些都暂存给关闭路径。 */
export interface TriggerPick {
  candidate: TriggerCandidate
  session: { sessionId: string }
  position: string
  via: string
  span: TokenSpan
}

/** `'handled'` 表示插件接管该输入；`undefined` 表示放弃，由外壳
 *  执行自己的默认行为（把该行当作 prompt 派发）。 */
export type SourcePickOutcome = 'handled' | undefined

/** harness 的输入触发服务（`ctx.inputTriggers`）：一个 '/' 触发源，其候选项、挑选与回车都留在客户端。 */
export interface InputTriggersFace {
  registerSource(src: {
    trigger: '/'
    name: string
    order?: number
    candidates(
      session: { sessionId: string },
      req: { query: string; position: string; signal: AbortSignal },
    ): Promise<readonly TriggerCandidate[]>
    onPick(pick: TriggerPick): SourcePickOutcome
    matchEnter?(
      session: { sessionId: string },
      line: string,
      signal: AbortSignal,
    ): Promise<SourcePickOutcome>
  }): () => void
}

/** session 作用域（`ctx.sessions.scope`），用于派发限定作用域的消费 token 事件。 */
export interface SessionScopeFace {
  bail(subject: unknown, event: string, payload: unknown): unknown
}

/** 本插件消费的 session 服务形态。`refresh` 是可选的，因为被裁剪的
 *  部署仍能列出 session；`scope` 则是 /context 关闭路径派发事件所依据的。 */
export interface SessionsFace {
  scope(id: string): SessionScopeFace | undefined
  /** 重新拉取 session 列表基线；总览在打开时搭它一趟，使回填行（backfill.ts）能到达长时间保持连接的浏览器。 */
  refresh?(): Promise<unknown>
}

/** 历史页中的一行，按网关序列化的形态：普通记录上信封嵌在
 *  `event` 之下，而在分页来源会跳过的打包分块行上完全不存在
 *  （见 historyPage 的 `eventOf`）。 */
export interface HistoryEntryLike {
  event?: unknown
}

/** 网关锚定 seq 的历史分页动词（`remote.session.page`）：
 * `throughSeq` 是包含式的日志切点、必须存在于日志中，`beforeSeq`
 * 是排他上界。行是 `SessionHistoryRecord`——
 * `{type:'event', event}` 加上映射器会跳过的打包 `{type:'chunks', …}` 段，因为只有流式增量才会打包。 */
export interface SessionPageFace {
  page(request: {
    address: { kind: 'session'; sessionId: string }
    throughSeq: number
    beforeSeq?: number
    maxMessages?: number
  }, signal?: AbortSignal): Promise<unknown>
}

/** 连接服务的面孔：通用 RPC 调用器，以及 harness 自己的打开入口所依据的回环事实。 */
export interface ConnectionFace {
  isLoopback?: boolean
  rpc?: {
    call?(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

/** session 命名空间下的工作区打开 remote，搭通用 '/api' 通道。 */
const OPEN_CHANNEL = '/api'
const CAN_OPEN_ENDPOINT = 'session/canOpenWorkspacePath'
const OPEN_ENDPOINT = 'session/openWorkspacePath'

/** 连接上已绑定的通用 RPC 调用器；服务缺失或不可信时为 undefined。 */
function rpcCallOf(ctx: ClientCtx): ((channel: string, endpoint: string, payload: unknown) => Promise<unknown>) | undefined {
  try {
    const rpc = asRecord((ctx.get('connection') as ConnectionFace | undefined)?.rpc)
    const fn = rpc?.call
    if (rpc !== null && typeof fn === 'function') {
      return (fn as (channel: string, endpoint: string, payload: unknown) => Promise<unknown>).bind(rpc)
    }
  } catch { /* 连接缺失或不可信——调用方退化关闭 */ }
  return undefined
}

/** **该 session** 的工作区根——取自它 session 列表行上的 `cwd`，而不是 host 进程的启动目录。 */
export function workspaceOf(ctx: ClientCtx, sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  // Host 数据：不可信对象可能在调用时或取属性时抛错。
  try {
    const sessions = ctx.get('sessions') as { list?: { getSnapshot(): unknown } } | undefined
    const snapshot = typeof sessions?.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
    const byId = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { byId?: unknown }).byId : undefined
    const row: unknown = byId !== null && typeof byId === 'object' ? (byId as Record<string, unknown>)[sessionId] : undefined
    const cwd = row !== null && typeof row === 'object' ? (row as { cwd?: unknown }).cwd : undefined
    // 用 **session** 的根，而不是 host 进程的 cwd：服务多个工作区的插件
    // 必须相对产出它们的那个 session 来换算文件路径。
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/** 该部署能否把路径交给原生桌面：既要处于回环地址，**又**要
 * 经一次 RPC 往返确认 session 控制器的打开能力；
 * 任何缺失、不可信或传输失败都解析为 false。 */
export async function canOpenPathsOf(ctx: ClientCtx): Promise<boolean> {
  const call = rpcCallOf(ctx)
  if (call === undefined) return false
  try {
    const connection = ctx.get('connection') as ConnectionFace | undefined
    if (connection?.isLoopback !== true) return false
    const result = await call(OPEN_CHANNEL, CAN_OPEN_ENDPOINT, { args: {} })
    const r = asRecord(result)
    return r !== null && r.ok === true && r.value === true
  } catch {
    return false
  }
}

/** 经 session 控制器 open remote 的系统路径打开器；没有 RPC 调用器时为 undefined；发出即不管。 */
export function openPathVia(ctx: ClientCtx): ((path: string) => void) | undefined {
  const call = rpcCallOf(ctx)
  if (call === undefined) return undefined
  return (path: string): void => {
    try {
      // `args` 是以 remote 声明的参数名为键的普通对象
      // （网关的 wire 契约——数组会被 host 侧拒绝）。
      void call(OPEN_CHANNEL, OPEN_ENDPOINT, { args: { request: { path } } })
        .catch(() => { /* 打开是尽力而为；失败保持静默 */ })
    } catch { /* 同一套约定，用于同步抛错的传输 */ }
  }
}

/** 右侧 Sidebar 的资源打开器；该列缺失时为 undefined
 * ——调用方保留其系统打开的降级。地址无人认领或没有 session 界面时，
 * `openResource` 会抛错，调用方因此能得知地址是否被占用。每次打开都
 * 重新校验该面孔：服务可能跨越一次 HMR 重载落地或被撤销。 */
export function openResourceVia(ctx: ClientCtx): ((address: string) => boolean) | undefined {
  // 这个不可信面孔要重新校验成带可调用 `openResource` 的记录。
  const faceOf = (): SidebarResourceFace | undefined => {
    try {
      const face = asRecord(ctx.get('sidebarRight'))
      return face !== null && typeof face.openResource === 'function'
        ? face as unknown as SidebarResourceFace
        : undefined
    } catch {
      return undefined
    }
  }
  if (faceOf() === undefined) return undefined
  return (address: string): boolean => {
    const face = faceOf()
    if (face === undefined) return false
    try {
      face.openResource(address)
      return true
    } catch {
      // 没有预览类型认领它，或没有挂载 session 界面。
      return false
    }
  }
}

/** 经由视图宿主自己的选择动词（`uiWorkspace.openSession`）跳到某个
 * session——侧栏行的点击搭的也是同一个动词，而 sessions 服务本身不带
 * 选择动词。面孔缺失或不可信时异常被吞掉，失效的跳转因此留在当前页。 */
export function openSessionVia(ctx: ClientCtx, id: string): void {
  try {
    const workspace = asRecord(ctx.get('uiWorkspace'))
    const open = workspace?.openSession
    if (typeof open === 'function') open.call(workspace, id)
  } catch { /* 面孔缺失或不可信——跳转是尽力而为 */ }
}

/** 某个 surface 节点 seq 的按需内容：持久日志中没有该 seq 时为 `null`，传输失败时 reject。 */
export type ContentFetcher = (seq: number) => Promise<ConversationNodeLike | null>

/** 某个 `contextHeaders` 世代 seq 的按需 system prompt 与工具 schema（historyPage.ts）；日志中没有该世代时为 `null`。 */
export type HeaderFetcher = (seq: number) => Promise<HeaderEpochContent | null>
