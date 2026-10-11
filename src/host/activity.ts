/**
 * `contextActivity` session projection 单元——Context
 * Insights 页热力图与近 7 天用量图背后的每日活动账本。
 *
 * 时间线单元（fold.ts）按「当前」时点给上下文计价，画不出按天的图，
 * 因此本单元把已提交的事件流折叠成按本地日历日索引的账本：
 * 一次 assistant 结算累加一个已完成请求、
 * 它的计费分桶（未缓存输入 + 缓存读 + 缓存写 + 输出），
 * 以及它按 (provider, model, 时段)的计价记录。各桶归属到「开启中的 step 启动」的那天，
 * 取不到时回落用结算时刻；峰谷拆分也按同一时刻计价。每天还会统计自己的 skill 加载次数。
 *
 * 账本以 {@link MAX_KEPT_DAYS} 个键为上限，
 * 且绝不生成值为 `undefined` 的属性。
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from './compat'
import { skillNameOf } from './fold'
import { addBilledUsage, copyCostUsage, tokenCountOf } from './foldMetering'
import type { BilledUsage, UsageLike } from './foldMetering'
import { costUsageSchema } from './timeline'
import { dayKeyOf } from '../shared/days'
import { DEFAULT_HOLIDAYS } from '../shared/officialRates'
import type { ActivityDay, ContextActivity } from '../shared/types'

/** 账本天数的保留上限：比一年每天的活跃 session 略多一点。 */
const MAX_KEPT_DAYS = 400

/** 单日 skill 名称表的上限；敌意重放可能往每次注入里塞一个名称。 */
const MAX_SKILLS_PER_DAY = 100

/** 待配对 `skill` 调用 id 列表的长度上限（见 ActivityState.skillCalls）。 */
const MAX_PENDING_SKILL_CALLS = 100

/** activity 单元的持久 state：日账本，外加进行中的路由与 skill 槽位。 */
export interface ActivityState {
  days: Record<string, ActivityDay>
  /** 当前生效的路由（最后一条 `request/header` 的 config 胜出）——每次结算都按它计价。 */
  model?: string
  provider?: string
  /** 开启中 step 的启动时刻（由 `step/start` 武装，由 `step/end` 清除）。 */
  stepStart?: number
  /** 待配对的 `skill` 工具调用 id（由 `tool/call` 武装，被配对的 `tool/result` 消费）：
   * 光靠 wrapper 匹配不足为信，否则一次读到引用了
   * `<skill_content name="…">` 的源码文本就会被记成一次加载。上限见 {@link MAX_PENDING_SKILL_CALLS}。 */
  skillCalls?: string[]
}

const activitySkillSchema = z.object({
  n: z.number().int().nonnegative(),
  last: z.number(),
}).strict()

const activityDaySchema = z.object({
  tokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  cost: costUsageSchema.optional(),
  skills: z.record(z.string(), activitySkillSchema).optional(),
}).strict()
/** 在 wire payload 离开 host 之前校验它（strict：不允许漂移）。 */
export const contextActivitySchema = z.object({
  days: z.record(z.string(), activityDaySchema),
}).strict() as unknown as z.ZodType<ContextActivity>

/** 持久 fold state 的 schema——在 checkpoint 行种入 fold 之前先校验。 */
const activityStateSchema = z.object({
  days: z.record(z.string(), activityDaySchema),
  model: z.string().optional(),
  provider: z.string().optional(),
  stepStart: z.number().optional(),
  skillCalls: z.array(z.string()).optional(),
}) as unknown as z.ZodType<ActivityState>

/** 某个持久 usage 对象的计费分桶；「没有任何」桶可读时返回 null（没带 usage 的结算照样计入
 * 请求数，但不凭空捏造 token）。各桶都过共用清洗函数 {@link tokenCountOf}：小数四舍五入，
 * 负数钳到 0。 */
function billedBucketsOf(value: unknown): BilledUsage | null {
  if (value === null || typeof value !== 'object') return null
  const usage = value as UsageLike
  const input = tokenCountOf(usage.inputTokens)
  const cacheRead = tokenCountOf(usage.cacheReadTokens)
  const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
  const output = tokenCountOf(usage.outputTokens)
  if (input === null && cacheRead === null && cacheWrite === null && output === null) return null
  return { uncached: input ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0, output: output ?? 0 }
}

/** 在上限之内把一整天的条目写回账本。对每个被淘汰的键做动态 `delete` 会让该记录退化成
 * 字典模式，因此改为重建保留的那一段。 */
function withDayEntry(state: ActivityState, key: string, entry: ActivityDay): ActivityState {
  let days = { ...state.days, [key]: entry }
  const keys = Object.keys(days)
  if (keys.length > MAX_KEPT_DAYS) {
    keys.sort()
    const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_DAYS))
    days = Object.fromEntries(Object.entries(days).filter(([k]) => !drop.has(k)))
  }
  return { ...state, days }
}

/** 把一次 skill 加载记到它所属的那天：计数递增、`last` 取最大值，
 * 乱序重放因此不会把它往回走。到达名称上限的那天保留已记名称，丢掉新来的。 */
function bookSkillLoad(state: ActivityState, name: string, time: number): ActivityState {
  const key = dayKeyOf(time)
  if (key === null) return state
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const prev = byKey[key]
  const existing = prev?.skills?.[name]
  if (existing === undefined && prev?.skills !== undefined && Object.keys(prev.skills).length >= MAX_SKILLS_PER_DAY) return state
  const skills = {
    ...prev?.skills,
    [name]: { n: (existing?.n ?? 0) + 1, last: existing === undefined ? time : Math.max(existing.last, time) },
  }
  const entry: ActivityDay = {
    tokens: prev?.tokens ?? 0,
    requests: prev?.requests ?? 0,
    ...(prev?.cost !== undefined ? { cost: prev.cost } : {}),
    skills,
  }
  return withDayEntry(state, key, entry)
}

/** `user/message`（或 `developer/message`）里的加载手势所携带的 skill 名：
 * 用户显式 `/name` 调用留下的持久 `skill-invocation` 信封。其余一律读作没有加载。 */
function invokedSkillOf(event: SessionEvent): string {
  const data = event.data as { source?: unknown; message?: unknown } | null | undefined
  const carrier = event.type === 'developer/message' ? data?.message : data
  const source = carrier !== null && typeof carrier === 'object'
    ? (carrier as { source?: unknown }).source
    : undefined
  if (source === null || typeof source !== 'object') return ''
  const rec = source as { kind?: unknown; name?: unknown }
  return rec.kind === 'skill-invocation' && typeof rec.name === 'string' ? rec.name : ''
}

/** `tool/result` 消息的调用 id：优先顶层 `toolCallId`，否则取持久 source 信封的
 * `callId`；两者都不是非空字符串时返回 null，未配对的结果因此不会记成 skill 加载。 */
function toolResultCallIdOf(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null
  const rec = message as { toolCallId?: unknown; source?: unknown }
  if (typeof rec.toolCallId === 'string' && rec.toolCallId !== '') return rec.toolCallId
  const source = rec.source
  if (source === null || typeof source !== 'object') return null
  const callId = (source as { callId?: unknown }).callId
  return typeof callId === 'string' && callId !== '' ? callId : null
}
/** 把一条已提交事件折叠进账本。其他事件一律按引用返回原 state，
 * 找不到可归属时刻的结算也是如此；
 * 下一个 state 只沿被改动的路径复制——持久化的旧 state 从不被原地修改。 */
export function applyActivity(
  state: ActivityState,
  event: SessionEvent,
  holidays: readonly string[] = DEFAULT_HOLIDAYS,
): ActivityState {
  if (event.type === 'request/header') {
    const data = event.data as { header?: { config?: { model?: unknown; provider?: unknown } | null } | null } | undefined
    const config = data?.header?.config
    if (config === null || typeof config !== 'object') return state
    const model = typeof config.model === 'string' ? config.model : undefined
    const provider = typeof config.provider === 'string' ? config.provider : undefined
    const nextModel = model !== undefined ? model : state.model
    const nextProvider = provider !== undefined ? provider : state.provider
    if (nextModel === state.model && nextProvider === state.provider) return state
    return {
      ...state,
      ...(nextModel !== undefined ? { model: nextModel } : {}),
      ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    }
  }
  if (event.type === 'step/start') {
    if (!Number.isFinite(event.time)) return state
    return state.stepStart === event.time ? state : { ...state, stepStart: event.time }
  }
  if (event.type === 'step/end') {
    if (state.stepStart === undefined) return state
    // 「删除」该字段——赋值为 `undefined` 会破坏纯 JSON 这一前提。
    const next = { ...state }
    delete next.stepStart
    return next
  }
  if (event.type === 'session/end-seed') {
    // 带标记的 fork/seed 边界：它之前的结算属于继承来的父日志前缀，
    // 已经记账到它 fork 自的那个 session，因此账本重置。`stepStart` 随切点一起作废，
    // 继承尾部留下的已武装槽位就不会把子 session 的首次结算归到父 session 的某天。
    const data = event.data as { inherited?: unknown } | null | undefined
    if (data?.inherited !== true) return state
    return { days: {} }
  }
  if (event.type === 'user/message' || event.type === 'developer/message') {
    const name = invokedSkillOf(event)
    return name === '' ? state : bookSkillLoad(state, name, event.time)
  }
  if (event.type === 'tool/call') {
    // 为 `skill` 工具的派发武装配对声明；结果里的 wrapper 匹配只在这层配对之下才可信
    // （见 ActivityState.skillCalls）。
    const data = event.data as { callId?: unknown; name?: unknown } | null | undefined
    const callId = data?.callId
    if (data?.name !== 'skill' || typeof callId !== 'string' || callId === '') return state
    const pending = state.skillCalls ?? []
    if (pending.includes(callId)) return state
    return { ...state, skillCalls: [...pending, callId].slice(-MAX_PENDING_SKILL_CALLS) }
  }
  if (event.type === 'tool/result') {
    // 模型发起的加载路径：`skill` 工具的结果把指令渲染在 `<skill_content name="…">`
    // wrapper 之后。未配对的结果不记任何加载；无论成功与否，声明都只被消费一次。
    const message = (event.data as { message?: unknown } | null | undefined)?.message
    const callId = toolResultCallIdOf(message)
    const pending = state.skillCalls
    if (callId === null || pending === undefined || !pending.includes(callId)) return state
    const skillCalls = pending.filter(id => id !== callId)
    const next: ActivityState = { ...state }
    // 「删除」已排空的字段——值为 undefined 的属性会破坏纯 JSON state。
    if (skillCalls.length > 0) next.skillCalls = skillCalls
    else delete next.skillCalls
    const name = skillNameOf(message)
    return name === '' ? next : bookSkillLoad(next, name, event.time)
  }
  if (event.type !== 'assistant/message') return state
  // 把结算归到开启中 step 的发起时刻，取不到就用它自己的时刻；槽位保持武装，
  // 因此同一步的第二次结算仍能读到它。
  const initiated = state.stepStart !== undefined ? state.stepStart : event.time
  const key = dayKeyOf(initiated)
  if (key === null) return state
  const data = event.data as { usage?: unknown } | undefined
  const buckets = billedBucketsOf(data?.usage)
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const prev = byKey[key]
  // 只有当前有 model 时结算才计价：没有 model 的结算照样计入 token 和请求数，
  // 但绝不编造费用。
  let cost = prev?.cost
  if (buckets !== null && state.model !== undefined) {
    cost = addBilledUsage(cost, state.provider ?? '', state.model, initiated, buckets, holidays)
  }
  const entry = {
    tokens: (prev === undefined ? 0 : prev.tokens)
      + (buckets === null ? 0 : buckets.uncached + buckets.cacheRead + buckets.cacheWrite + buckets.output),
    requests: (prev === undefined ? 0 : prev.requests) + 1,
    ...(cost !== undefined ? { cost } : {}),
    // 当天的 skill 统计按引用挂在条目上；每次改动都沿自己的路径复制。
    ...(prev?.skills !== undefined ? { skills: prev.skills } : {}),
  }
  return withDayEntry(state, key, entry)
}

/** 每日活动 projection 单元，与时间线、headers 单元一起注册（host/index.ts）。
 * `stateVersion` 为 5：每日计价记录开始感知节假日（节假日按谷时计费），
 * 而后续事件无法为已折叠的那些天补算，
 * 因此升级时缓存行会读作版本过期，由 Context Insights 预热重新冷折叠。 */
export function createContextActivityDefinition(holidays: readonly string[] = DEFAULT_HOLIDAYS): ProjectionDefinition<'contextActivity', ActivityState> {
  return {
    key: 'contextActivity',
    stateSchema: activityStateSchema,
    init: (): ActivityState => ({ days: {} }),
    apply: (state: ActivityState, event: SessionEvent) => applyActivity(state, event, holidays),
    // view 会连账本和每个条目的嵌套记录一起复制，注册表、缓存写入方与 wire 因此都无法改动
    // fold 自己的记录；上面每次改动也都沿自己的路径复制。
    wire: {
      viewSchema: contextActivitySchema,
      view: state => ({
        days: Object.fromEntries(Object.entries(state.days).map(([k, v]) => [k, {
          ...v,
          // 条件展开：值为 `undefined` 的属性会让整次无损 JSON 推送失败。
          ...(v.cost !== undefined ? { cost: copyCostUsage(v.cost) } : {}),
          ...(v.skills !== undefined
            ? { skills: Object.fromEntries(Object.entries(v.skills).map(([n, t]) => [n, { ...t }])) }
            : {}),
        }])),
      }),
    },
    stateVersion: 5,
  }
}
