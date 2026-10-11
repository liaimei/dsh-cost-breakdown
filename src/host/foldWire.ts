/**
 * fold 对外提供的值——瘦身 wire head、按需拉取的 detail payload，以及内联视图。
 * 每个字段都是副本，对外提供的值因此绝不与持久 state 别名共享。
 */

import type { ContextTimelineDetail, Snapshot, ToolTimingTotals } from '../shared/types'
import { copyCostUsage } from './foldMetering'
import type { FoldBounds } from './config'
import type { TimelineState } from './foldState'

/** 信封标量、存活 surface 聚合值，以及最新请求的计费摘要。
 * 有意省掉 detail 集合（它们被填成空数组），
 * 调用方因此可以先展开这个 head 再补上集合。
 *
 * 对外提供值的字段都是副本——绝不能与持久 state 别名共享。可选标量用条件展开，
 * 因为一个值为 `undefined` 的属性就能让整次无损 JSON 推送失败。 */
function headFieldsOf(state: TimelineState): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.skill + state.sums.assistant + state.sums.tool
  // 以 provider 为锚的占用率不在这里折叠：Client 直接读 token-meter 自己的 `contextPressure` 键。
  const result: Snapshot = {
    ok: true,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.provider !== undefined ? { provider: state.provider } : {}),
    ...(state.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
    current: {
      system: state.systemTokens,
      tools: state.toolsTokens,
      user: state.sums.user,
      inject: state.sums.inject,
      skill: state.sums.skill,
      assistant: state.sums.assistant,
      tool: state.sums.tool,
      total: surfaceTotal + state.systemTokens + state.toolsTokens,
    },
    images: state.surface.reduce((n, node) => n + (node.imgs ?? 0), 0),
    // 仍在进行中（尚无结果）的调用，以及结果已被压缩或裁剪出 surface 的调用都不计。
    // skill 工具加载会把节点改归 `skill` 桶，但保留其工具身份，因此照样计入。
    toolCalls: state.surface.reduce((n, node) => node.cat === 'tool' || (node.cat === 'skill' && node.tool !== undefined) ? n + 1 : n, 0),
    humanInputs: state.humanInputs ?? 0,
    answers: state.answers ?? 0,
    ...(state.lastUser !== undefined ? { lastUser: state.lastUser } : {}),
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
  // 成本汇总与集合一样，以「副本」形式上 wire。
  if (state.cost !== undefined) {
    result.cost = copyCostUsage(state.cost)
  }
  // 计时汇总同样以「副本」形式上 wire（含按名称的行）。
  if (state.timing !== undefined) {
    const tools: Record<string, ToolTimingTotals> = {}
    for (const k in state.timing.tools) tools[k] = { ...state.timing.tools[k] }
    result.timing = { ...state.timing, tools }
  }
  // 浏览器据此确定任意一步当时生效的 prompt，并按需从事件里取回其文本。
  if (state.systems !== undefined && state.systems.length > 0) {
    result.systems = state.systems.map(n => ({ ...n }))
  }
  return result
}

/** 沉重集合、钉住 inject/skill 节点后的 surface 切片，以及各水位；不含 `rev`，
 * 它归 head 所有。
 *
 * 内联 wire 视图（无独立通道的 host）与按需 detail payload（host/detail.ts）逐字共用。 */
function detailCollectionsOf(state: TimelineState, bounds: FoldBounds): Omit<ContextTimelineDetail, 'rev'> {
  const result: Omit<ContextTimelineDetail, 'rev'> = {
    requests: state.requests.map(r => ({ ...r })),
    events: state.events.map(e => ({ ...e })),
    nodes: [],
    droppedNodes: 0,
    archive: state.archived.map(n => ({ ...n })),
    fileOps: state.fileOps.map(o => ({ ...o })),
    ...(state.fileOpsFloor !== undefined ? { fileOpsFloor: state.fileOpsFloor } : {}),
    spans: state.spans.map(s => ({ ...s })),
  }
  // 注入内容「最先」落到 surface 上，因此在长 session 里，只取尾部会丢掉它们的身份，而它们的
  // token 仍在计（汇总覆盖整个 surface），浏览器于是只有 token 总数、没有可列出条目；
  // skill 内容同理（摘要在 session 开始时注入，加载又都堆在早期）。
  // 把这两类钉进对外提供的列表里。
  // 溢出切片在位置上先于尾部，拼接后仍保持 seq 有序。
  const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes)
  const overflow = state.surface.slice(0, overflowCount)
  const tail = state.surface.slice(overflowCount)
  const pinned = overflow.filter(n => n.cat === 'inject' || n.cat === 'skill')
  result.nodes = pinned.length > 0 ? [...pinned, ...tail] : tail
  result.droppedNodes = overflowCount - pinned.length
  // 两个水位让 client 能把所选步骤的重建标为近似，而不是悄悄少显示内容。
  if (result.droppedNodes > 0) {
    let floor = 0
    for (const n of overflow) if (n.cat !== 'inject' && n.cat !== 'skill') floor = Math.max(floor, n.seq)
    result.surfaceFloor = floor
  }
  if (state.archiveFloor !== undefined) result.archiveFloor = state.archiveFloor

  // 把每个事件挂到它前后的请求上：`turn`/`step` 指向事件之后记录的第一条请求，
  // `fromTurn`/`fromStep` 则指向它之前的那条。两个列表都保持 seq 有序，因此走一遍指针即可。
  const requests = result.requests
  const events = result.events
  let ri = 0
  for (const ev of events) {
    while (ri < requests.length && requests[ri].seq <= ev.seq) ri++
    // 用 .at() 让越界情形在类型系统里显式可见。
    const next = requests.at(ri)
    const prev = ri > 0 ? requests.at(ri - 1) : undefined
    if (next !== undefined && typeof next.turn === 'number' && typeof next.step === 'number') {
      ev.turn = next.turn
      ev.step = next.step
    }
    if (prev !== undefined && typeof prev.turn === 'number' && typeof prev.step === 'number') {
      ev.fromTurn = prev.turn
      ev.fromStep = prev.step
    }
  }
  return result
}

/** 拆分世代的「瘦身」wire head：信封标量、预先算好的计数、最新请求的计费摘要，
 * 以及 detail 修订标记——小到足以整份搭上每条投递通道。 */
export function buildTimelineHead(state: TimelineState): Snapshot {
  const result = headFieldsOf(state)
  // 只统计「保留下来」的记录，与 detail 提供的是同一批。
  const turns = new Set<number>()
  for (const r of state.requests) turns.add(r.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  // 带 skill 标记的 inject 事件中的去重名称；目录摘要走的是无标记事件，因此永远不落在这里。
  const skills = new Set<string>()
  for (const e of state.events) {
    if (e.kind === 'inject') injects++
    else if (e.kind === 'compaction') compactions++
    else if (e.kind === 'prune') prunes++
    if (e.sub === 'skill' && typeof e.name === 'string' && e.name !== '') skills.add(e.name)
  }
  result.counts = { turns: turns.size, steps: state.requests.length, injects, compactions, prunes, skills: skills.size }
  const last = state.requests.at(-1)
  if (last !== undefined) {
    result.last = { seq: last.seq, total: last.total, ...(typeof last.prompt === 'number' ? { prompt: last.prompt } : {}) }
  }
  result.detailRev = state.detailRev ?? 0
  return result
}

/** 沉重集合、同一 fold 切点上的瘦身 head，以及 head 携带的修订标记。 */
export function buildTimelineDetail(state: TimelineState, bounds: FoldBounds): ContextTimelineDetail {
  return { rev: state.detailRev ?? 0, head: buildTimelineHead(state), ...detailCollectionsOf(state, bounds) }
}

/** 无独立通道 host 上的「内联」projection wire 视图：head 标量加上就位的 detail 集合。 */
export function buildTimelineView(state: TimelineState, bounds: FoldBounds): Snapshot {
  return { ...headFieldsOf(state), ...detailCollectionsOf(state, bounds) }
}
