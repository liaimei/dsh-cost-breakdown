/**
 * context 时间线 fold：把 session 的持久事件日志重放成按请求的构成时间线。
 *
 * 它是 `ctx.sessionProjections` 上的一个 session projection 单元（由 timeline.ts 注册）：
 * 框架每提交一条`session/event` 就调用一次 `applyTimeline`，
 * 并把返回的 state 经 projection 缓存持久化。
 * 事件不改变 state 时 `applyTimeline` 必须返回同一引用——变更流由 `Object.is` 把关——而任何变化都返回一个由惰性浅克隆构造的新引用。state 必须保持纯 JSON（缓存 checkpoint 的前提）
 * 且有界。
 */

import type { Category, ContextEventRecord, FileOpRecord, RequestRecord, SurfaceNode, SystemPromptNode, TimingSpan } from '../shared/types'
import { estimateSystemContent } from '../shared/estimate'
import type { FoldBounds } from './config'
import {
  estimateMessage,
  estimateToolsTotal,
  firstText,
  imageCountOf,
  injectionSourceName,
  isInjection,
  toolCallNames,
} from './pricing'
import type { ContentBlock, MessageSource } from './pricing'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { decodeSpansOfStream, decodeTallyOfStream, firstTokenTimeOfStream, replaceRangeOf } from './logShapes'
import { opBearingTool, opsOfCall, parseCallArgs, rawArgsNeeded } from '../shared/fileOps'
import { countTurnRuns, trimState } from './foldState'
import type { TimelineEvent, TimelineState } from './foldState'
import { accumulateCost, addDecode, bumpToolTotals, DECODE_KINDS, durOf, ensureTiming, tokenCountOf } from './foldMetering'
import type { UsageLike } from './foldMetering'

/** 消息事件计价归入的构成分桶；skill 机制优先于通用的注入上下文判断，
 * 因为它的两种 source kind 都是持久的 `user/message` 注入，
 * 否则会被 {@link isInjection} 一并吸收。 */
function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (type === 'developer/message') return 'inject'
  // skill 机制自成一个分桶：两种 source kind 都是持久的 user/message 注入，
  // 会被朴素的注入上下文判断吸收掉。
  const kind = message?.source?.kind
  if (kind === 'skill-invocation' || kind === 'skill-catalog') return 'skill'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
}

/** 把 detail 集合标记为脏。只触及工作槽位（stepStart、callNames、遮蔽声明）或信封标量的 fold 分支
 * 「不得」抬高它——对外 detail 没有变化，打开的标签页也没有东西需要重新拉取。
 */
function bumpDetailRev(st: TimelineState): void {
  st.detailRev = (st.detailRev ?? 0) + 1
}

/** 生效价格取最后一个非空节点，因此丢掉最旧的只会让「最新节点全为空」的日志少报。 */
const SYSTEM_NODES_MAX = 8

/** 生效的 system prompt 价格：最后一个非空节点，没有则为 0（harness 自己的规则）。 */
function systemTokensOf(systems: readonly SystemPromptNode[]): number {
  for (let i = systems.length - 1; i >= 0; i--) {
    if (systems[i].tokens > 0) return systems[i].tokens
  }
  return 0
}

/** 追加一个 system prompt 节点，并给列表加上长度上限（见 SYSTEM_NODES_MAX）。 */
function pushSystem(st: TimelineState, node: SystemPromptNode): void {
  const systems = [...(st.systems ?? []), node]
  st.systems = systems.length > SYSTEM_NODES_MAX ? systems.slice(-SYSTEM_NODES_MAX) : systems
  st.systemTokens = systemTokensOf(st.systems)
}

/** 只派发、从不结算父 run_code 的敌意日志，无法让持久 state 长出这个上限。 */
const PENDING_CODE_OPS_MAX = 200

/** 把未知的参数 payload 转成 JSON 字符串；敌意的（循环引用）值不产出参数。 */
function argsRawOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** 把新的操作记录追加到对外日志；头部被丢弃时由 `trimState` 里的裁剪负责抬高
 * `fileOpsFloor`。 */
function pushFileOps(st: TimelineState, ops: FileOpRecord[]): void {
  for (const op of ops) st.fileOps.push(op)
}

/** 缓冲区满时把新到的整批丢掉（只可能出现在防御性日志里）。 */
function bufferCodeOps(st: TimelineState, rootCallId: string, ops: FileOpRecord[]): void {
  const pending = st.pendingCodeOps ?? {}
  let total = 0
  for (const k in pending) total += pending[k].length
  if (total + ops.length > PENDING_CODE_OPS_MAX) return
  st.pendingCodeOps = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), ...ops] }
}

/** 落章后的「副本」：源对象与持久化的旧 state 共享，因此绝不能把 `gone` 写到它们身上。 */
function archiveRemoved(st: TimelineState, removed: SurfaceNode[], goneSeq: number): void {
  for (const n of removed) st.archived.push({ ...n, gone: goneSeq })
}

/** 移除按 SEQ 列表走，而不是按声明的范围：被裁剪的替换节点保留着自己的 seq，落在范围终点之外，
 * 按范围移除会把它们漏下并多算。 */
function removeSurfaceSeqs(st: TimelineState, claimed: ReadonlySet<number>, goneSeq: number): SurfaceNode[] {
  if (claimed.size === 0) return []
  const kept: SurfaceNode[] = []
  const removed: SurfaceNode[] = []
  for (const n of st.surface) {
    if (claimed.has(n.seq)) {
      st.sums[n.cat] -= n.tokens
      removed.push(n)
    } else {
      kept.push(n)
    }
  }
  archiveRemoved(st, removed, goneSeq)
  st.surface = kept
  return removed
}

/** surface projection 从持久事件上读取的字段。 */
type SurfaceEventLike = Pick<TimelineEvent, 'seq' | 'time' | 'surfaceOp'>

/** 消息事件的持久 payload，重新核验成记录；其他情况返回 null，
 * 调用方按空消息处理而不是抛错。 */
interface MessageLike {
  content?: ContentBlock[]
  source?: MessageSource
  /** V4 世代唯一的错误写法：只有与它同时出现时，事件级的 `error` 标记才会被接受。 */
  isError?: unknown
}

/** 结构化读取让畸形 payload 保持全函数，并且与 `deriveEventMessage` 不同，它让空的 developer 消息
 * 在 surface 上占位但计 0 token（正是 fold 的 surface 所对齐的 harness 消息投影规则）。 */
function messageOf(data: Record<string, unknown> | undefined): MessageLike | null {
  const message = data?.message
  return message !== null && typeof message === 'object' ? message : null
}

/** 与 `firstText` 不同，这里「不能」截断或归一：skill 名要拿原始的
 * `<skill_content name="…">` wrapper 去匹配。 */
function firstFullText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
  }
  return ''
}

/** 已加载的 skill 在结果文本里渲染成 `<skill_content name="…">…</skill_content>`，因此名称从内容里
 * 还原，而不是相信调用信封。导出供 activity fold 的 skill 加载计数使用，
 * 它从同一条持久事件上读原始的 `data.message`。 */
export function skillNameOf(msg: unknown): string {
  const content = msg !== null && typeof msg === 'object' ? (msg as MessageLike).content : undefined
  const text = firstFullText(content)
  const match = text.match(/<skill_content\s+name="([^"]+)"/)
  return match === null ? '' : match[1]
}

/** 给一条消息事件计价并把节点放到 surface 上：追加，或替换该事件 `surfaceOp` 指定的范围
 * （就地 splice）/ 已武装的遮蔽声明列出的那些 seq。返回该节点，
 * 让调用方按它选定的 text/tool 字段分支。 */
function applySurface(
  st: TimelineState,
  ev: SurfaceEventLike,
  type: string,
  message: MessageLike | null | undefined,
): SurfaceNode {
  const cat = categoryOf(type, message ?? undefined)
  const node: SurfaceNode = {
    seq: ev.seq,
    time: ev.time,
    cat,
    // 空的 assistant/developer 消息投影不出任何模型消息，因此连内容和角色框架一起跳过。
    tokens: estimateMessage(message, type === 'assistant/message' || type === 'developer/message'),
  }
  // 图片块挂在「节点」上（为 0 时缺失）：统计面板在存活 surface 上求和，因此被压缩消息的图片不再计入。
  const imgs = imageCountOf(message?.content)
  if (imgs > 0) node.imgs = imgs
  const source = message?.source
  const form = source?.form
  if (typeof form === 'string') node.form = form
  if (type === 'assistant/message') {
    const text = firstText(message?.content)
    if (text !== '') node.text = text
    else {
      const names = toolCallNames(message?.content)
      if (names.length > 0) node.calls = names.slice(0, 3)
    }
  } else if (type === 'tool/result') {
    const srcId = (source as { callId?: unknown } | undefined)?.callId
    const toolEntry = typeof srcId === 'string' ? st.callNames[srcId] : undefined
    if (toolEntry !== undefined) {
      node.tool = toolEntry.name
      const timing = ensureTiming(st)
      const dur = durOf(toolEntry.start, ev.time)
      timing.toolsMs += dur
      timing.toolCalls += 1
      bumpToolTotals(timing, toolEntry.name, dur)
      // 只有当有 step 开着来认领这个窗口时才绘制（跨 step 或外来的结果仍照上面计入总量）。
      if (st.stepStart !== undefined) {
        st.stepSpans = [...(st.stepSpans ?? []), { kind: 'tools', start: toolEntry.start, end: ev.time }]
      }
    }
    // 重建时去掉已用掉的 id（按仓库 lint 要求不用动态 delete）；映射规模保持在待处理调用的量级，复制成本可忽略。
    if (typeof srcId === 'string') {
      const kept: Record<string, { name: string; start: number }> = {}
      for (const k in st.callNames) {
        if (k !== srcId) kept[k] = st.callNames[k]
      }
      st.callNames = kept
    }
    if (message?.isError === true) node.err = true
  } else if (source?.kind === 'skill-invocation') {
    node.skill = typeof source.name === 'string' ? source.name : '?'
  } else if (source?.kind === 'plugin') {
    if (source.form === 'notice' && typeof source.summary === 'string') node.text = source.summary
    else if (source.form === 'snapshot' && Array.isArray(source.sections)) {
      node.text = source.sections.map(s => s?.name).filter(Boolean).join(', ').slice(0, 80)
    } else {
      const ptext = firstText(message?.content)
      if (ptext !== '') node.text = ptext
    }
  } else {
    const utext = firstText(message?.content)
    if (utext !== '') node.text = utext
  }

  // 在这里消费掉已武装的遮蔽声明；再晚一条 surface 事件它就过期了。「删除」这些字段：
  // 赋值为 `undefined` 会破坏纯 JSON 前提。
  const shadowedSeqs = st.pendingShadowedSeqs
  const shadowEventSeq = st.pendingShadowEventSeq
  delete st.pendingShadowedSeqs
  delete st.pendingShadowEventSeq

  const op = replaceRangeOf(ev.surfaceOp)
  if (op !== null) {
    if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
      const removed = removeSurfaceSeqs(st, new Set(shadowedSeqs), ev.seq)
      st.sums[cat] += node.tokens
      st.surface.push(node)
      // 把计量行从粗略遮蔽价改写成「净释放」量，使它和趋势图显示的下降一致。
      // 写副本：events 数组的元素与持久 state 共享。
      if (shadowEventSeq !== undefined) {
        const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0)
        const i = st.events.findIndex(e => e.seq === shadowEventSeq)
        if (i >= 0) st.events[i] = { ...st.events[i], tokens: Math.max(0, removedSum - node.tokens) }
      }
      return node
    }
    // 「就地」splice：harness 让替换节点占据该区间的位次，且按它注册表的校验，两个端点都必须指向存活
    // 节点。畸形的区间退化为追加，保留原有节点。
    let si = -1
    let ei = -1
    for (let i = 0; i < st.surface.length; i++) {
      if (si < 0 && st.surface[i].seq === op.start) si = i
      if (st.surface[i].seq === op.end) { ei = i; break }
    }
    if (si >= 0 && ei >= si) {
      const removed = st.surface.splice(si, ei - si + 1, node)
      archiveRemoved(st, removed, ev.seq)
      for (const r of removed) st.sums[r.cat] -= r.tokens
      st.sums[cat] += node.tokens
      return node
    }
  }
  st.surface.push(node)
  st.sums[cat] += node.tokens
  return node
}

/** 它结算后的结果「就是」用户的回答，因此计入人类输入；一个结果 = 一次提交。 */
const ASK_USER_TOOL = 'ask_user_question'

/** fold 分支可以「就地」改动的集合。每个分支在 `ensure` 里如实列出自己的改动点；
 * 未列出的容器绝不原地写入——每次触碰都用新的数组/记录「替换」该属性——
 * 因此它们无需克隆就一直与持久化的旧 state 共享。 */
type CloneKey = 'surface' | 'sums' | 'requests' | 'events' | 'archived' | 'callNames' | 'fileOps' | 'timing'

const CLONE_ALL: readonly CloneKey[] = ['surface', 'sums', 'requests', 'events', 'archived', 'callNames', 'fileOps', 'timing']

/**
 * reducer：把一条持久事件折叠进新 state；事件无任何变化时**按引用**返回原 `state`
 * （注册表用 `Object.is` 判断是否推送变更流，凭空造一个新引用会让每条事件都被推送）。
 * 有变化的 state 由惰性浅克隆构造（见 `ensure`）；抛错的 fold 整体吞掉，
 * 一条畸形事件因此无法卡住该单元。
 */
export function applyTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  let st: TimelineState | undefined
  /** 该事件的私有工作 state。每条事件「恰好调用一次」（每个分支自行列出它这条路径可能写入的集合；
   * 辅助函数从不调用它），因此每次调用都新建一份是安全的。默认值是全量克隆，
   * 将来某个分支若漏写列表，会退化成旧行为，而不是共享它要改动的集合。 */
  const ensure = (keys: readonly CloneKey[] = CLONE_ALL): TimelineState => {
    st = { ...state }
    for (const key of keys) {
      if (key === 'surface') st.surface = [...state.surface]
      else if (key === 'sums') st.sums = { ...state.sums }
      else if (key === 'requests') st.requests = [...state.requests]
      else if (key === 'events') st.events = [...state.events]
      else if (key === 'archived') st.archived = [...state.archived]
      else if (key === 'callNames') st.callNames = { ...state.callNames }
      else if (key === 'fileOps') st.fileOps = [...state.fileOps]
      // `timing` 缺失就保持缺失：值为 `undefined` 的自有属性会让每次缓存写入都失败。
      else if (state.timing !== undefined) st.timing = { ...state.timing, tools: { ...state.timing.tools } }
    }
    return st
  }

  const data = event.data
  // 注册表直接从 session/event 总线上驱动 `apply`，没有错误边界：一次抛错的 fold 会让本单元的格子和
  // 推送流都不再前进，浏览器会永远停在「加载中」。持久日志是不可信输入，
  // 因此畸形事件一律「丢弃」，绝不抛出。
  try {
    switch (event.type) {
      case 'request/header': {
        const header = (data?.header ?? {}) as {
          tools?: unknown[]
          config?: { model?: unknown; provider?: unknown }
        }
        const tools = Array.isArray(header.tools) ? header.tools : []
        const s = ensure(['events'])
        // 工具总量 = dsh 的整数组计价（所有 schema 合成一个 JSON 字符串）。
        s.toolsTokens = estimateToolsTotal(tools)
        // 路由与 model 的权威来源是持久 request 信封，而不是 request/context。
        if (header.config && typeof header.config.model === 'string') s.model = header.config.model
        if (header.config && typeof header.config.provider === 'string') s.provider = header.config.provider
        // 模型切换没有专门的事件：它就是与前一次不同的请求头，记录时 reason 为 'change'
        // （'initial' 开启 session，'resume' 重新打开它）。
        if ((data?.reason === 'change' || data?.reason === 'resume') && s.model && s.lastModel && s.model !== s.lastModel) {
          s.events.push({ seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model })
          bumpDetailRev(s)
        }
        if (s.model) s.lastModel = s.model
        break
      }
      case 'system/message': {
        // system prompt 在 harness 有序 surface 里位列第 0，
        // 但被排除在插件自己的消息类别之外：它是信封数字的来源，
        // 因此绝不能进 `surface`/`sums`（否则会与 `systemTokens` 重复计数）。
        const s = ensure(['surface', 'sums', 'archived'])
        delete s.pendingShadowedSeqs
        delete s.pendingShadowEventSeq
        const op = replaceRangeOf(event.surfaceOp)
        if (op !== null) {
          const systems = s.systems ?? []
          s.systems = systems.filter(n => n.seq < op.start || n.seq > op.end)
          // 防御性处理：dsh 从不在这里认领普通 surface 节点，但移除一下能保持 surface 与 sums 一致。
          const claimed = new Set<number>()
          for (const n of s.surface) {
            if (n.seq >= op.start && n.seq <= op.end) claimed.add(n.seq)
          }
          if (removeSurfaceSeqs(s, claimed, event.seq).length > 0) bumpDetailRev(s)
        }
        pushSystem(s, { seq: event.seq, time: event.time, tokens: estimateSystemContent(messageOf(data)?.content) })
        break
      }
      case 'request/context': {
        const s = ensure([])
        // 只在路由或容量变化时记录，因此它更新当前路由展示，但从不触发模型切换事件。
        if (data && typeof data.contextWindow === 'number') s.contextWindow = data.contextWindow
        if (data && typeof data.model === 'string') s.model = data.model
        if (data && typeof data.provider === 'string') s.provider = data.provider
        break
      }
      case 'tool/call': {
        if (data && typeof data.callId === 'string' && typeof data.name === 'string') {
          const s = ensure(['callNames'])
          // 只在参数确实会被读取时才保留（会产生操作的工具，或 flush 要读的 run_code 根调用），
          // 让庞大的 bash/pwsh 调用不落进持久 state。
          const argsRaw = rawArgsNeeded(data.name) ? argsRawOf(data.arguments) : undefined
          s.callNames[data.callId] = {
            name: data.name,
            start: event.time,
            ...(argsRaw !== undefined ? { argsRaw } : {}),
          }
        }
        break
      }
      case 'tool/ptc-dispatch': {
        // 在 run_code 程序内部结算的嵌套 PTC（Code Mode）调用：其派发事件不带 meta，因此读取窗口与
        // 按文件的搜索归因退化为仅凭参数的形式。这些操作按顶层 run_code 调用 id 缓冲，
        // 等它的结果折叠进来时再 flush（定位目标是那条结果行）。
        const rootCallId = data?.rootCallId
        const name = data?.name
        if (typeof rootCallId === 'string' && typeof name === 'string') {
          // 与 tool/call 同样的门控，只是没有 run_code 那一支。
          const argsRaw = opBearingTool(name) ? argsRawOf(data?.arguments) : undefined
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: name,
            argsRaw,
            err: data?.isError === true,
          })
          if (ops.length > 0) {
            const s = ensure([])
            bufferCodeOps(s, rootCallId, ops)
          }
        }
        break
      }
      case 'assistant/attempt': {
      // 一次没有提交 surface 消息、但内嵌流仍带着该次尝试首个 token 的模型尝试——
      // harness 自己的 sessionStats fold 也是同样把它落在开启中的 step 上，因此 step 内的重试能保住真实
      // TTFT，而不会掉进卡片的残余里。
        const start = state.stepStart
        if (start === undefined || start.firstToken !== undefined) return state
        const first = firstTokenTimeOfStream(data?.stream)
        if (first === undefined) return state
        const s = ensure([])
        s.stepStart = { time: start.time, firstToken: first }
        break
      }
      case 'step/start': {
        // 被取代的 step 遗留的区间累加器和等待/审批/回指针槽位都在这里作废
        // （它们的时刻早于新窗口）。
        const s = ensure([])
        s.stepStart = { time: event.time }
        delete s.stepSpans
        delete s.stepWaits
        delete s.stepApprovals
        delete s.stepRequestSeq
        break
      }
      case 'step/end': {
        // 没有开启中的槽位（step/end 未配对，或该 step 已在重新折叠中过期）：state 必须保持引用不变。
        const start = state.stepStart
        if (start === undefined) return state
        const s = ensure(state.stepRequestSeq !== undefined ? ['timing', 'requests'] : ['timing'])
        ensureTiming(s).wallMs += durOf(start.time, event.time)
        // 活跃时间用于趋势图的时长叠加层：step 窗口减去该 step 用户等待区间的钳制并集。
        // 落章落在 step 已提交的 request 记录上，
        // 敌意重折叠若丢了那一行就跳过。
        const waits: { start: number; end: number }[] = [...(state.stepWaits ?? [])]
        for (const id in state.stepApprovals) waits.push({ start: state.stepApprovals[id], end: event.time })
        waits.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        let waitMs = 0
        let waitCursor = start.time
        for (const wait of waits) {
          const from = Math.max(waitCursor, wait.start)
          const to = Math.min(wait.end, event.time)
          if (to > from) { waitMs += to - from; waitCursor = to }
        }
        const activeMs = durOf(start.time, event.time) - waitMs
        const last = state.requests.at(-1)
        if (last !== undefined && last.seq === state.stepRequestSeq) {
          s.requests[s.requests.length - 1] = { ...last, activeMs }
        }
        // 把开启中 step 的区间铺满 [step 起, step 止]——按「先到者胜」去重叠（并行工具运行画的是其
        // 「并集」，绝不重复计墙钟时间），每个空洞都用残余类型填上，因此总是无缝铺满。
        // 零宽度的 step（敌意时间戳）不 flush 任何东西。
        const painted: TimingSpan[] = []
        for (const span of state.stepSpans ?? []) {
          const from = Math.max(start.time, span.start)
          const to = Math.min(event.time, span.end)
          if (to > from) painted.push({ kind: span.kind, start: from, end: to })
        }
        painted.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const flushed: TimingSpan[] = []
        let cursor = start.time
        for (const span of painted) {
          const from = Math.max(cursor, span.start)
          if (span.end <= from) continue
          if (from > cursor) flushed.push({ kind: 'other', start: cursor, end: from })
          flushed.push({ kind: span.kind, start: from, end: span.end })
          cursor = span.end
        }
        if (event.time > cursor) flushed.push({ kind: 'other', start: cursor, end: event.time })
        s.spans = [...state.spans, ...flushed]
        // 「删除」这些可选字段——赋值为 `undefined` 会破坏纯 JSON 前提。
        delete s.stepStart
        delete s.stepSpans
        delete s.stepWaits
        delete s.stepApprovals
        delete s.stepRequestSeq
        bumpDetailRev(s)
        break
      }
      case 'approval/asked': {
        // step 之外的提问不产生计价，且必须让 state 保持引用不变。
        const id = data?.id
        if (state.stepStart === undefined || typeof id !== 'string') return state
        const s = ensure([])
        s.stepApprovals = { ...state.stepApprovals, [id]: event.time }
        break
      }
      case 'approval/decided': {
        // 没有对应已武装 asked 的 decided（step 之外的一对，或落在重折叠窗口里）不产生计价。
        const id = data?.id
        const open = state.stepApprovals
        const askedAt = typeof id === 'string' ? open?.[id] : undefined
        if (open === undefined || askedAt === undefined) return state
        const s = ensure([])
        s.stepWaits = [...(state.stepWaits ?? []), { start: askedAt, end: event.time }]
        const kept: Record<string, number> = {}
        for (const k in open) if (k !== id) kept[k] = open[k]
        if (Object.keys(kept).length > 0) s.stepApprovals = kept
        else delete s.stepApprovals
        break
      }
      case 'user/message':
      case 'developer/message': {
        // 该依赖会把空的 developer 消息投影成 null；结构化读取则保住它在 surface 上的占位。
        const developer = event.type === 'developer/message'
        const msg = developer ? messageOf(data) : deriveEventMessage(event as never) as MessageLike | null
        if (developer && (msg === null || !Array.isArray(msg.content))) return state
        const s = ensure(['surface', 'sums', 'archived', 'events'])
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, msg)
        const source = msg?.source
        if (developer || isInjection(source)) {
          const rec: ContextEventRecord = {
            seq: event.seq,
            time: event.time,
            kind: 'inject',
            // 重新核验：harness 只校验 source 的 `kind`，不校验 `form`，因此敌意的 form 必须退化成
            // 默认值，而不是让这条记录在每次投递时都过不了严格的 schema。
            form: typeof source?.form === 'string' && source.form !== '' ? source.form : 'context',
            tokens: node.tokens,
          }
          if (source?.kind === 'skill-invocation') {
            rec.sub = 'skill'
            rec.name = typeof source.name === 'string' ? source.name : '?'
          } else {
            const label = injectionSourceName(source)
            if (label !== '') {
              rec.name = label
              // 同一个身份也挂在 surface 节点上，浏览器里的行因此与这条事件行给出同样的注入标签。
              node.name = label
            }
            // notice 带着生产者那句长度受限的单行说明；像 dsh transcript 的行那样把它接在来源名之后展示。
            if (source?.form === 'notice' && typeof source.summary === 'string' && source.summary !== '') {
              rec.detail = source.summary
            }
          }
          s.events.push(rec)
        } else {
          s.humanInputs = (s.humanInputs ?? 0) + 1
          // 最新者胜：没有文本的消息（只有图片）保留上一行。
          if (node.text !== undefined && node.text !== '') s.lastUser = node.text
        }
        break
      }
      case 'tool/result': {
        // 若按信封计价而不读 data.message，就会丢掉全部内容。
        const toolMsg = deriveEventMessage(event as never) as MessageLike | null
        // 抢在 applySurface 消费之前读取：已武装的调用把该结果配对进文件操作，
        // 而结果的 callId 是缓冲的 Code-Mode 操作的 flush 键。
        const msgSource = toolMsg?.source as { callId?: unknown } | undefined
        const srcId = msgSource?.callId
        const pendingEntry = typeof srcId === 'string' ? state.callNames[srcId] : undefined
        const buffered = typeof srcId === 'string' ? state.pendingCodeOps?.[srcId] : undefined
        const s = ensure(['surface', 'sums', 'archived', 'events', 'fileOps', 'timing'])
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, toolMsg)
        // 已作答的提问也算一次人类输入；未配对或外来的结果没有工具名，因此不计。
        if (node.tool === ASK_USER_TOOL) s.humanInputs = (s.humanInputs ?? 0) + 1
        // 问答工具的整个窗口就是用户作答的等待，开启中的 step 因此先记下它，供 `step/end` 做 `activeMs` 扣减。
        if (pendingEntry !== undefined && pendingEntry.name === ASK_USER_TOOL && state.stepStart !== undefined) {
          s.stepWaits = [...(state.stepWaits ?? []), { start: pendingEntry.start, end: event.time }]
        }
        // 未配对的结果不登记文件操作（与 surface 节点缺少工具标签保持一致）。
        if (pendingEntry !== undefined) {
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: pendingEntry.name,
            argsRaw: pendingEntry.argsRaw,
            meta: data?.meta,
            err: toolMsg?.isError === true,
          })
          pushFileOps(s, ops)
        }
        if (buffered !== undefined && buffered.length > 0) {
          // run_code 根调用结算：它的嵌套操作以 `parent` = 本条结果行的形式落地，
          // 并从其调用参数里取程序 description。
          const program = parseCallArgs(pendingEntry?.argsRaw)?.description
          pushFileOps(s, buffered.map(op => ({
            ...op,
            parent: event.seq,
            ...(typeof program === 'string' && program !== '' ? { program } : {}),
          })))
          const kept: Record<string, FileOpRecord[]> = {}
          for (const k in s.pendingCodeOps) {
            if (k !== srcId) kept[k] = s.pendingCodeOps[k]
          }
          if (Object.keys(kept).length > 0) s.pendingCodeOps = kept
          else delete s.pendingCodeOps
        }
        // skill 加载的工具结果是 harness 注入的上下文，自有一个构成分桶：价格在 surface 汇总层面从
        // `tool` 挪到 `skill`，图表因此显示 skill 的占用情况，而不是把它埋进普通结果里。
        // 名称来自渲染出的 `<skill_content name="…">` wrapper；即使 tool/call 事件已不在
        // （窗口被裁剪、重放），单凭 wrapper 仍能认出一个真实的 skill 结果。
        // 这个标记让未配对的加载仍可按工具调用计数。
        if (node.tool === 'skill' || node.tool === undefined) {
          const name = skillNameOf(toolMsg)
          if (name !== '') {
            node.skill = name
            if (node.tool === undefined) node.tool = 'skill'
            s.sums.tool -= node.tokens
            node.cat = 'skill'
            s.sums.skill += node.tokens
            s.events.push({ seq: event.seq, time: event.time, kind: 'inject', form: 'instructions', sub: 'skill', name, tokens: node.tokens })
          }
        }
        break
      }
      case 'assistant/message': {
      // 该记录是请求「发出时」的原样，因此要在这次响应加入 surface 之前构造。
        const usage = data?.usage as UsageLike | null | undefined
        const s = ensure(['surface', 'sums', 'archived', 'events', 'requests', 'timing'])
        bumpDetailRev(s)
        const total = s.systemTokens + s.toolsTokens + s.sums.user + s.sums.inject + s.sums.skill + s.sums.assistant + s.sums.tool
        const record: RequestRecord = {
          time: event.time,
          seq: event.seq,
          system: s.systemTokens,
          tools: s.toolsTokens,
          user: s.sums.user,
          inject: s.sums.inject,
          skill: s.sums.skill,
          assistant: s.sums.assistant,
          tool: s.sums.tool,
          total,
        }
        // 只写真实数字：`turn`/`step` 缺席时绝不能凭空生成一个值为 `undefined` 的属性。
        if (data && typeof data.turn === 'number') record.turn = data.turn
        if (data && typeof data.step === 'number') record.step = data.step
        // `step/end` 会把该 step 的活跃时间落在这条记录上，它是时长叠加层的数据来源。
        if (state.stepStart !== undefined) s.stepRequestSeq = record.seq
        // 提前取出供下面的吞吐口径使用：`null` 表示「没有可读的输出桶」，而不是编造的 0。
        let output: number | null = null
        if (usage !== null && typeof usage === 'object') {
        // 官方 TokenUsage 语义：各桶互不重叠——inputTokens 只是未缓存输入，缓存读/写各自独立，
        // 计费 prompt 侧 = input + cacheRead + cacheWrite——而 outputTokens 已包含 reasoningTokens。
        // 每个桶都先过 `tokenCountOf`，因为持久日志不可信，
        // 任何不合规的原始数字都绝不能进入 state。
          const input = tokenCountOf(usage.inputTokens)
          const cacheRead = tokenCountOf(usage.cacheReadTokens)
          const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
          output = tokenCountOf(usage.outputTokens)
          // 任何一个可读的桶都算一次计费采样，完全不可读的对象则按缺失处理，
          // 因此编造的 0 永远不会进到 client 的推导占用率锚点。
          if (input !== null || cacheRead !== null || cacheWrite !== null || output !== null) {
            record.prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
            // 计费 prompt 中命中缓存的份额（step 行上的缓存数字）。
            if (cacheRead !== null) record.cacheRead = cacheRead
            if (output !== null) record.output = output
            accumulateCost(s, event.time, {
              uncached: input ?? 0,
              cacheRead: cacheRead ?? 0,
              cacheWrite: cacheWrite ?? 0,
              output: output ?? 0,
            }, bounds.holidays)
          }
        }
        s.requests.push(record)
        // `turnRuns` 账本：`turn` 值每变化一次算一个 turn run，与 `countTurnRuns` 的规则完全一致。
        const prevLast = state.requests.at(-1)
        s.turnRuns = (state.turnRuns ?? countTurnRuns(state.requests))
          + (prevLast === undefined
            ? (record.turn !== undefined ? 1 : 0)
            : (record.turn === prevLast.turn ? 0 : 1))
        // 等待与生成的分界落在第一个「可观测」瞬间；
        // 当流里的标记早于 token 时（被涂掉的 reasoning 块不留下任何 chunk），
        // 分界会前移到更早的那个块标记：若以 token 为锚，铺满标记的解码窗口会被算进等待，
        // 图例各行还会重复计算、超过 100%。流里没有 token 时（step 被中止）不归因，
        // 落进卡片的残余。待处理槽位保持武装——该 step 的工具调用和 `step/end` 还在后面。
        const timing = ensureTiming(s)
        timing.calls += 1
        const stepStart = state.stepStart
        if (stepStart !== undefined) {
          const firstToken = stepStart.firstToken ?? firstTokenTimeOfStream(data?.stream)
          if (firstToken !== undefined) {
            const decodeBlocks = decodeSpansOfStream(data?.stream, event.time)
            let decodeStart = firstToken
            for (const block of decodeBlocks) decodeStart = Math.min(decodeStart, block.start)
            timing.ttftMs += durOf(stepStart.time, decodeStart)
            timing.genMs += durOf(decodeStart, event.time)
            // 时间条的模型切片：先是静默等待，随后是按「流顺序」
            // 从「同一个」decodeStart 边界起算的解码块，各行、
            // 圆环与时间条因此读同一个窗口。没有标记的流把这段窗口留给 step/end 的残余填充。
            const modelSpans: TimingSpan[] = [{ kind: 'ttft', start: stepStart.time, end: decodeStart }]
            for (const block of decodeBlocks) {
              const to = Math.min(event.time, block.end)
              if (to <= block.start) continue
              modelSpans.push({ kind: block.kind, start: modelSpans.length === 1 ? decodeStart : block.start, end: to })
            }
            s.stepSpans = [...(s.stepSpans ?? []), ...modelSpans]
            // 配对方式与 harness 的 session-stats fold 完全一致：只有当解码窗口和 provider 报告的输出
            // token 都已知时，这次调用才计入。TPS 有意保留首 token 作为锚，
            // 因为那是与 harness 对齐的口径。
            if (output !== null) {
              timing.speedMs = (timing.speedMs ?? 0) + durOf(firstToken, event.time)
              timing.speedTokens = (timing.speedTokens ?? 0) + output
            }
            // 生成阶段拆分：各分桶铺满生成窗口，只剩结算尾部未归因。
            // 只有窗口已计价时才计价，未被落章的调用其未归因时间因此不会在这里重现。
            const tally = decodeTallyOfStream(data?.stream, event.time)
            for (const kind of DECODE_KINDS) addDecode(timing, kind, tally.spans[kind], tally.blocks[kind])
          }
        }
        // 内容数组为空时返回 null（只有 usage 的事件投影不出消息，与 dsh 的 surface fold 同规则）。
        const asstMsg = deriveEventMessage(event as never) as MessageLike | null
        const asstNode = applySurface(s, event, event.type, asstMsg)
        // 节点恰好只在消息「说了点什么」时带 `text`，因此没有文本的工具派发不计。
        if (asstNode.text !== undefined) s.answers = (s.answers ?? 0) + 1
        break
      }
      case 'session/end-seed': {
        // fork/seed 边界：带「标记」的标记点（`inherited: true`）
        // 之前的事件是被种入的子 session 原样重放的父日志前缀，
        // 其中的 usage 结算也算在内——那些花费 fork 自的 session 已经计过价了。把成本汇总清零，
        // 被种入 session 自己的成本就只统计种入之后的花费。「未标记」的标记点是一般的 resume/重放边界，
        // 必须让 state 引用保持不变，否则每次 resume 都会抹掉该 session 的历史。
        // 用 `{}` 而不是 `undefined`：值为 undefined 的属性过不了纯 JSON 缓存前提。
        if (data?.inherited !== true) break
        const s = ensure([])
        s.cost = {}
        break
      }
      case 'plan/mode': {
      // 计划模式在启用期间会给每个模型请求加一段引导，所以值得一条事件。
        if (data && typeof data.active === 'boolean') {
          const s = ensure(['events'])
          s.events.push({ seq: event.seq, time: event.time, kind: 'mode', name: data.active ? 'plan.on' : 'plan.off' })
          bumpDetailRev(s)
        }
        break
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const s = ensure(['events'])
        bumpDetailRev(s)
        // 紧随该事件同步而来的那次替换，遮蔽的正是这些节点 seq。
        if (data && Array.isArray(data.shadowedSeqs)) {
          s.pendingShadowedSeqs = data.shadowedSeqs.filter((x): x is number => typeof x === 'number')
          s.pendingShadowEventSeq = event.seq
        }
        s.events.push({
          seq: event.seq,
          time: event.time,
          kind: event.type === 'compaction/summary' ? 'compaction' : 'prune',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
          ...(event.type === 'compaction/summary' && data && Array.isArray(data.shadowedSeqs)
            ? { count: data.shadowedSeqs.length }
            : {}),
        })
        break
      }
      default:
        return state
    }
  } catch {
    // 对格式良好的事件不可达；这道守卫的存在是为了让 fold 永远拖不垮 projection。失败的事件「整体」丢弃
    // ——部分改动都落在私有的惰性克隆上——保证这次转移全有或全无。
    st = undefined
  }

  if (st !== undefined) {
    trimState(st, bounds)
    return st
  }
  return state
}

// 拆分之前的对外接口，为测试保留；生产调用方直接 import 所属的兄弟模块。
/** 面向测试的再导出，这些部件原本归本模块所有；它们不属于插件的运行时契约，
 * 生产调用方请改从兄弟模块 import。 */
export { createTimelineState, trimToLastTurns } from './foldState'
export type { TimelineEvent, TimelineState } from './foldState'
export { addBilledUsage, isPeakAt, tokenCountOf } from './foldMetering'
export type { BilledUsage, UsageLike } from './foldMetering'
export { buildTimelineDetail, buildTimelineHead, buildTimelineView } from './foldWire'
