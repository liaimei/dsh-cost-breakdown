/**
 * `contextHeaders` session projection 单元——
 * 时间线信封数字背后的请求头「epoch 元数据」。
 *
 * epoch 的「内容」（完整 system prompt、完整工具 schema）
 * 有意不搭 projection 值： projection 会在每一行 `session.list`、基线、
 * 推送帧和变更通知里整份提供，
 * 把内容放这里就会被 session 数 × epoch 数放大。client 通过 session 历史按需拉取某个 epoch 的`request/header`。
 *
 * `stateVersion` 有意保持 1（#37 回归的教训）：一抬高就会让所有缓存行失效，
 * 而对一个没有 projection 刷新通道的空闲 session，
 * 该键会一直孤悬到它重新活跃为止。因此 state 仍然「接受」
 * 带内容的 v1 记录形状，由 view 把两代记录统一归一成只有元数据的 wire 形态。
 */

import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from './compat'
import type { ContextHeaders, HeaderRecord, HeaderTool } from '../shared/types'
import { estimateToolSchema } from './pricing'
import { estimateSystemTokens } from '../shared/estimate'

/** 只保留最新 `HEADERS_MAX` 个 epoch；更旧的从数组头部丢弃。 */
const HEADERS_MAX = 50

/** 一个存储的工具：v1 行带着生产者 description 和原始 schema；之后的 fold 只追加元数据。 */
interface StoredHeaderTool {
  name: string
  tokens: number
  description?: string
  plugin?: string
  schema?: unknown
}

/** 一个存储的 epoch：v1 行带的是 `system`；之后的 fold 带 `systemTokens`。 */
interface StoredHeaderRecord {
  seq: number
  time: number
  system?: string
  systemTokens?: number
  tools: StoredHeaderTool[]
}

/** headers 单元的持久 state：epoch 元数据行，由旧到新。 */
export interface HeadersState {
  headers: StoredHeaderRecord[]
}

/** 持久 state 的 schema：两代记录的超集，因此带内容的缓存 v1 行照样能种入 fold。 */
const storedToolSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  description: z.string().optional(),
  plugin: z.string().optional(),
  schema: z.unknown().optional(),
}).strict()

const storedEpochSchema = z.object({
  seq: z.number(),
  time: z.number(),
  system: z.string().optional(),
  systemTokens: z.number().int().nonnegative().optional(),
  tools: z.array(storedToolSchema),
}).strict()

const contextHeadersStateSchema = z.object({
  headers: z.array(storedEpochSchema),
}).strict() as unknown as z.ZodType<HeadersState>

const headerToolWireSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative(),
  plugin: z.string().optional(),
}).strict()

/** client 的 `contextHeaders` 值必须满足的「只有元数据」wire schema；
 * 内容字段按决定缺席（见模块头）。 */
export const contextHeadersSchema = z.object({
  headers: z.array(z.object({
    seq: z.number(),
    time: z.number(),
    // 该 epoch 没有记录 system prompt 时缺失；用于估算该分区的预取大小。
    systemTokens: z.number().int().nonnegative().optional(),
    tools: z.array(headerToolWireSchema),
  }).strict()),
}).strict() as unknown as z.ZodType<ContextHeaders>

/** 把一条 `request/header` 事件折叠成存储的 epoch；其他事件类型或敌意的 `header` 字段返回 null，
 * 该单元的 `apply` 因此没有会抛错的路径。 */
function recordOf(event: SessionEvent): StoredHeaderRecord | null {
  if (event.type !== 'request/header') return null
  // 本单元没有 try/catch，因此不可能的形态必须退化成「不是 epoch」，
  // 而不是从注册表的驱动循环里抛出去。
  const rawHeader = (event.data as { header?: unknown } | undefined)?.header
  if (rawHeader === null || rawHeader === undefined || typeof rawHeader !== 'object') return null
  // 受支持的 epoch header 从不携带 system prompt（`EpochHeader.system` 是 `never`），
  // 所以 epoch 只折叠元数据；存储的 `system` 字段是为缓存的 v1 行保留的。
  const header = rawHeader as { tools?: unknown[] }
  const tools = Array.isArray(header.tools) ? header.tools : []
  const record: StoredHeaderRecord = {
    seq: event.seq,
    time: event.time,
    tools: tools.map((t): StoredHeaderTool => {
      // 条目为 null 或原始值时，退化成无名、按 JSON 计价的工具，而不是抛错。
      const tool = (t !== null && typeof t === 'object' ? t : {}) as { name?: unknown; plugin?: unknown }
      const entry: StoredHeaderTool = {
        name: typeof tool.name === 'string' ? tool.name : '?',
        tokens: estimateToolSchema(t),
      }
      // 逐字保留，让 view 期的解析器绝不覆盖生产者写下的归因；
      // 受支持基线的任何路径都不会写入它（ToolSchema 没有 plugin 字段）。
      if (typeof tool.plugin === 'string' && tool.plugin !== '') {
        entry.plugin = tool.plugin
      }
      return entry
    }),
  }
  return record
}

/**
 * context-headers projection 单元，与时间线单元一起注册（host/index.ts）。
 * @param resolve - 尽力而为的「工具 → 插件」归因（见 toolSources.ts）；在 view 期补上缺失的
 * `plugin`，让没有归因就折叠出来的 epoch 也能渲染出标签。
 */
export function createContextHeadersDefinition(
  resolve?: (name: string) => string | undefined,
): ProjectionDefinition<'contextHeaders', HeadersState> {
  // view 把两代存储记录都归一成「只有元数据」的 wire 形状：旧 v1 epoch 的内容在这里被剥掉
  // （system 文本在每次读取时单独计价一次）。
  const view = (state: HeadersState): ContextHeaders => ({
    headers: state.headers.map((h): HeaderRecord => {
      const record: HeaderRecord = {
        seq: h.seq,
        time: h.time,
        tools: h.tools.map((t): HeaderTool => {
          const entry: HeaderTool = { name: t.name, tokens: t.tokens }
          const plugin = t.plugin ?? (resolve !== undefined ? resolve(t.name) : undefined)
          if (plugin !== undefined) entry.plugin = plugin
          return entry
        }),
      }
      const systemTokens = h.systemTokens
        ?? (typeof h.system === 'string' && h.system !== '' ? estimateSystemTokens(h.system) : undefined)
      if (systemTokens !== undefined) record.systemTokens = systemTokens
      return record
    }),
  })
  const definition: ProjectionDefinition<'contextHeaders', HeadersState> = {
    key: 'contextHeaders',
    stateSchema: contextHeadersStateSchema,
    wire: { viewSchema: contextHeadersSchema, view },
    init: (): HeadersState => ({ headers: [] }),
    apply: (state: HeadersState, event: SessionEvent): HeadersState => {
      const record = recordOf(event)
      if (record === null) return state
      // agent 循环会抑制未变化的 header；这里防的是同一 epoch 的重放。
      const last = state.headers.at(-1)
      if (last !== undefined && last.seq === record.seq) return state
      const headers = [...state.headers, record]
      return { headers: headers.length > HEADERS_MAX ? headers.slice(-HEADERS_MAX) : headers }
    },
    // 有意固定在 1（见模块头关于读兼容的说明）。
    stateVersion: 1,
  }
  return definition
}
