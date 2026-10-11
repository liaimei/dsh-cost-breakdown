/**
 * Context 浏览器的定点全文抓取，取代盲目翻尾页：一次锚定 seq 的历史读取
 * （`remote.session.page`，把包含式的 `throughSeq` 切点钉在目标上）
 * 直接返回承载该事件的那一页，因为 host 按完整消息边界
 * 切页。抓到的节点按 session 缓存，
 * 因为历史是不可变的。
 *
 * remote 面孔通过**声明式** inject 解析（`watchHistoryFaces`）：
 * 对被追踪的服务代理做**未声明**读取会抛错
 * （"cannot get property … without inject"）并可能拖垮整个视图，
 * 因此回调在同一 fiber 中同时声明 `remote` 与 `remote.session`。
 */

import { useSyncExternalStore } from 'react'
import type {
  ClientCtx, ContentFetcher, ConversationNodeLike, HeaderFetcher,
  HistoryEntryLike, SessionPageFace,
} from './services'
import type { HeaderEpochContent } from '../shared/types'

function eventOf(entry: unknown): { type: string; seq: number; data: Record<string, unknown> } | null {
  if (entry === null || typeof entry !== 'object') return null
  // 历史记录把信封包在 `event` 字段里；裸信封也能通过，
  // 而打包的分块行在下游什么都投影不出来。
  const inner = (entry as HistoryEntryLike).event ?? entry
  if (typeof inner !== 'object') return null
  const e = inner as { type?: unknown; seq?: unknown; data?: unknown }
  if (typeof e.type !== 'string' || typeof e.seq !== 'number' || !Number.isFinite(e.seq)) return null
  const data = e.data !== null && typeof e.data === 'object' ? e.data as Record<string, unknown> : {}
  return { type: e.type, seq: e.seq, data }
}

function textOf(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null
  let out = ''
  for (const b of blocks) {
    const text = b !== null && typeof b === 'object' ? (b as { type?: unknown; text?: unknown }).text : undefined
    if (typeof text === 'string') out += text
  }
  return out.trim() === '' ? null : out
}

/** system prompt 的精确文本，各块直接拼接、**不做任何规范化**：
 * 只有空白的 prompt 依然是模型收到的 prompt，必须渲染出来而不是读作缺失。 */
function systemTextOf(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null
  let out = ''
  let seen = false
  for (const b of blocks) {
    const text = b !== null && typeof b === 'object' ? (b as { type?: unknown; text?: unknown }).text : undefined
    if (typeof text === 'string') {
      out += text
      seen = true
    }
  }
  return seen ? out : null
}

/** 把 assistant 的一个内容块映射到快照的块词汇表；无法映射的块原样透传。 */
function assistantBlockOf(block: unknown): Record<string, unknown> {
  const b = block !== null && typeof block === 'object' ? block as { type?: unknown; text?: unknown; attachment?: unknown; name?: unknown; arguments?: unknown } : null
  switch (b?.type) {
    case 'text': case 'reasoning':
      return { kind: b.type, ...(typeof b.text === 'string' ? { text: b.text } : {}) }
    case 'image':
      return { kind: 'image', ...(b.attachment !== undefined ? { attachment: b.attachment } : {}) }
    case 'tool-call':
      return {
        kind: 'tool-call',
        name: typeof b.name === 'string' ? b.name : '?',
        argsRaw: b.arguments,
      }
    default:
      return block !== null && typeof block === 'object' ? block as Record<string, unknown> : { value: block }
  }
}

/** 把一页历史收窄成浏览器渲染的节点映射。以**事件**的 seq 为键
 *  （而不是条目的下标），因为调用方按 seq 查找，并期望页内自身
 *  顺序无关紧要。
 *  注意这里是**单趟**遍历：`tool/call` 收进 `calls`、`tool/result` 就地取用，
 *  因此页内若出现 result 排在其 call 之前的错序，该 result 的 `call` 会是
 *  null，而不会回填。 */
export function pageNodesOf(entries: readonly unknown[]): Map<number, ConversationNodeLike> {
  const nodes = new Map<number, ConversationNodeLike>()
  const calls = new Map<string, { name: string; argsRaw: string }>()
  const summaries = new Map<string, string>()
  for (const entry of entries) {
    const ev = eventOf(entry)
    if (ev === null) continue
    const { type, seq, data } = ev
    if (type === 'tool/call') {
      if (typeof data.callId === 'string') {
        calls.set(data.callId, {
          name: typeof data.name === 'string' ? data.name : '?',
          // 持久信封把参数存成原始 JSON 字符串。
          argsRaw: typeof data.arguments === 'string' ? data.arguments : '',
        })
      }
      continue
    }
    if (type === 'compaction/summary') {
      if (typeof data.compactionId === 'string') {
        const summary = textOf(data.summary)
        if (summary !== null) summaries.set(data.compactionId, summary)
      }
      continue
    }
    if (type === 'user/message') {
      const source = data.source !== null && typeof data.source === 'object' ? data.source as Record<string, unknown> : null
      const compactionId = source !== null
        && source.kind === 'plugin' && typeof source.compactionId === 'string'
        ? source.compactionId
        : null
      if (compactionId !== null) {
        // 压缩检查点：模型可见的信封改为渲染它的摘要
        // （若切页把摘要留在了页外，则为 null）。
        nodes.set(seq, { kind: 'compaction', seq, summary: summaries.get(compactionId) ?? null })
        continue
      }
      nodes.set(seq, {
        kind: 'user',
        seq,
        content: Array.isArray(data.content) ? data.content as readonly unknown[] : [],
      })
      continue
    }
    if (type === 'assistant/message') {
      const message = data.message !== null && typeof data.message === 'object' ? data.message as Record<string, unknown> : null
      const content = message !== null && Array.isArray(message.content) ? message.content : []
      nodes.set(seq, {
        kind: 'assistant',
        seq,
        blocks: (content as unknown[]).map(assistantBlockOf),
      })
      continue
    }
    if (type === 'tool/result') {
      // V4 的一等 tool-role 消息：`toolCallId`/`isError` 挂在
      // 消息上，内容是直接的块列表。
      const message = data.message !== null && typeof data.message === 'object' ? data.message as Record<string, unknown> : null
      const source = message?.source !== null && typeof message?.source === 'object' ? message.source as Record<string, unknown> : null
      const callId = typeof message?.toolCallId === 'string' ? message.toolCallId
        : typeof source?.callId === 'string' ? source.callId
          : null
      const call = callId !== null ? calls.get(callId) ?? null : null
      nodes.set(seq, {
        kind: 'tool-result',
        seq,
        call,
        content: Array.isArray(message?.content) ? message.content as readonly unknown[] : [],
        isError: message?.isError === true,
      })
      continue
    }
  }
  return nodes
}

/** 绑定面孔的 `page` 动词；遇到恶意访问器时退化为 undefined。 */
function readPageOf(face: unknown): SessionPageFace['page'] | undefined {
  if (face === null || typeof face !== 'object') return undefined
  try {
    const fn = (face as Record<string, unknown>).page
    return typeof fn === 'function' ? (fn as SessionPageFace['page']).bind(face) : undefined
  } catch {
    return undefined
  }
}

/** 来自**声明式** inject 的网关历史分页动词，提前绑定：
 * 未绑定就取出的方法会丢掉 `this`，而交出它的被追踪 `remote` 代理本身也要求 inject 已解析。
 */
let declaredPage: SessionPageFace['page'] | undefined

const faceListeners = new Set<() => void>()

function setPageFace(page: SessionPageFace['page'] | undefined): void {
  declaredPage = page
  for (const listener of [...faceListeners]) listener()
}

/** 当前已声明的分页动词；inject 尚未落地（或已被撤销）时为 undefined。
 *  由各 fetcher 读取，绝不跨 inject 周期缓存。 */
export function historyFace(): SessionPageFace['page'] | undefined {
  return declaredPage
}

/** 订阅该分页面孔的到来/撤销，使在 inject 落地之前构建的 fetcher
 *  能在它落地后重建（见 {@link useHistoryFace}）。 */
export function subscribeHistoryFace(listener: () => void): () => void {
  faceListeners.add(listener)
  return () => { faceListeners.delete(listener) }
}

function faceSnapshot(): SessionPageFace['page'] | undefined {
  return declaredPage
}

/** 解析后分页面孔之上的 React 座位。挂载可能与声明式
 * inject 赛跑（watch 重建会在注入的 fiber 重新触发之前先重挂载 slot 组件），
 * 所以首帧可能看不到面孔；订阅可在它落地或被撤销时重建下游的 fetcher。 */
export function useHistoryFace(): SessionPageFace['page'] | undefined {
  return useSyncExternalStore(subscribeHistoryFace, faceSnapshot, faceSnapshot)
}

/** 通过**声明式** inject 注册插件的历史面孔：`remote` 与
 * `remote.session` 必须位于同一 fiber 的需求清单中，因为被追踪的
 * 代理经由 context 解析 `.session`，而未声明的读取会抛错。
 * 回调每次卸载/重挂载都会重跑，并掌管该 slot 的生命周期。 */
export function watchHistoryFaces(ctx: ClientCtx): void {
  ctx.inject(['remote', 'remote.session'], (c) => {
    try {
      const session = (c as ClientCtx & { remote?: { session?: SessionPageFace } }).remote?.session
      setPageFace(session !== undefined ? readPageOf(session) : undefined)
    } catch {
      setPageFace(undefined)
    }
    return () => { setPageFace(undefined) }
  })
}

function rowsOf(response: unknown): readonly unknown[] {
  // remote 解析出的就是 ClientResult 本身（{ok, value}）；裸的
  // {records} 载荷也能通过。其他情况一律 reject，调用方因此可以给出重试而不是宣称缺失。
  // 抓取**抛错**正是关键：只有 reject 才能让浏览器区分
  // 「日志里没有该事件」（真正的 null 节点）与「读取失败」（可重试的提示）。
  let payload: unknown = response
  if (payload !== null && typeof payload === 'object' && 'ok' in payload) {
    const r = payload as { ok?: unknown; value?: unknown }
    if (r.ok !== true || r.value === null || typeof r.value !== 'object') {
      throw new Error('history rpc failed')
    }
    payload = r.value
  }
  if (payload === null || typeof payload !== 'object') throw new Error('history rpc failed')
  const rows = (payload as { records?: unknown }).records
  if (!Array.isArray(rows)) throw new Error('history rpc failed')
  return rows
}

/** 取自声明式 inject slot 的 session 历史读取器，切点钉在 seq 上（`beforeSeq`
 * 取其下一个）。slot 中没有面孔时返回 undefined——调用方沿用各自的静态降级。
 */
function pageReaderOf(sessionId: string): ((seq: number) => Promise<unknown>) | undefined {
  const page = declaredPage
  if (page === undefined) return undefined
  return (seq) => {
    return page({
      address: { kind: 'session' as const, sessionId },
      throughSeq: seq,
      beforeSeq: seq + 1,
    }, new AbortController().signal)
  }
}

/** 在网关历史面孔之上构建浏览器按 session 使用的 fetcher；构建时
 * 没有解析出面孔则返回 undefined（调用方沿用「静态预览加提示」的降级）。 */
export function makeContentFetcher(sessionId: string): ContentFetcher | undefined {
  const read = pageReaderOf(sessionId)
  if (read === undefined) return undefined
  const cache = new Map<number, ConversationNodeLike>()
  return async (seq) => {
    // 只缓存**已落地**的节点：历史不可变，命中即为最终结果；但 null
    // 不缓存，因为按 `throughSeq` 切出的页面可能看到日志后来才新增的事件
    // （实时流），反复重试未命中才能把该事件渲染出来。
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    const node = pageNodesOf(rowsOf(await read(seq))).get(seq) ?? null
    if (node !== null) cache.set(seq, node)
    return node
  }
}

/** 把一条原始持久事件映射成浏览器渲染的世代内容：`request/header`
 * 给出每个工具的描述与原始 schema，`system/message` 只给出 prompt
 * 文本。工具条目为 null 或原始值时退化成一行无名记录，
 * 而不是让整次读取抛错。 */
function headerContentOf(event: { type: string; data: Record<string, unknown> }): HeaderEpochContent | null {
  const { type, data } = event
  if (type === 'system/message') {
    const message = data.message !== null && typeof data.message === 'object'
      ? data.message as Record<string, unknown>
      : null
    const system = systemTextOf(message?.content)
    return system === null ? null : { system, tools: [] }
  }
  const rawHeader = data.header !== null && typeof data.header === 'object'
    ? data.header as Record<string, unknown>
    : null
  if (rawHeader === null) return null
  const toolsRaw = Array.isArray(rawHeader.tools) ? rawHeader.tools : []
  const tools: HeaderEpochContent['tools'] = []
  for (const t of toolsRaw) {
    const tool = t !== null && typeof t === 'object' ? t as Record<string, unknown> : null
    tools.push({
      name: tool !== null && typeof tool.name === 'string' ? tool.name : '?',
      ...(tool !== null && typeof tool.description === 'string' && tool.description !== ''
        ? { description: tool.description }
        : {}),
      schema: t,
    })
  }
  return { tools }
}

/** 浏览器 System 与 Tools 两栏按需的**内容**抓取：一次锚定 seq
 * 的读取返回承载该事件的那一页，已落地的内容按 seq 缓存，
 * 因此回溯各个世代会复用同一批页面。没有历史面孔时返回 undefined。 */
export function makeHeaderFetcher(sessionId: string): HeaderFetcher | undefined {
  const read = pageReaderOf(sessionId)
  if (read === undefined) return undefined
  const cache = new Map<number, HeaderEpochContent>()
  return async (seq) => {
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    const rows = rowsOf(await read(seq))
    let picked: HeaderEpochContent | null = null
    for (const entry of rows) {
      const ev = eventOf(entry)
      if (ev === null || (ev.type !== 'request/header' && ev.type !== 'system/message')) continue
      const content = headerContentOf(ev)
      if (content === null) continue
      // 该页的排他上界是 seq + 1，因此页上每个内容事件要么就是选中的那条、要么更旧——全部缓存。
      cache.set(ev.seq, content)
      if (ev.seq === seq) picked = content
    }
    return picked
  }
}
