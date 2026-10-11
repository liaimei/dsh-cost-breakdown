/** Agent 图推导——Agent 网络卡片背后的纯模型。session 列表快照已带齐卡片所需的全部
 * 信息，这里把它折叠成当前 session 的家族：最上层已知祖先的整棵子树、逐节点统计，
 * 以及一套深度/DFS 布局。 */

import type { PartsPart } from './categories'
import type { ContextTimeline, SessionCostUsage } from '../shared/types'
import { mergeCostUsage } from './cost'
import { headlineOf, occupancyPercent, type Headline } from './headline'
import { asRecord, contextBreakdownOf, contextPressureOf, numOf, timelineOf, tokenUsageOf } from './services'

/** 客户端对外暴露的 `ctx.sessions` 面孔。session 导航不在这里：它属于视图宿主
 * 的 `openSession`（services.ts 的 `openSessionVia`）。 */
export interface SessionsFaceLike {
  list?: {
    getSnapshot(): unknown
    subscribe(fn: () => void): () => void
  }
  refreshSubagents?(parentSessionId: string): Promise<unknown>
}

/** 一行 session 列表记录中被验证过的子集。除 `running`/`blank`/`updatedAt` 外每个字段
 *  都是可选的：host 传来的行不可信，字段缺失不能让整个折叠失败。 */
export interface AgentRow {
  displayTitle?: string
  title?: string
  parentId?: string
  origin?: string
  running: boolean
  blank: boolean
  updatedAt: number
  projections?: Record<string, unknown>
}

/** subagent 域的身份投影 `subagent`（描述符 mode + 持久 label）。 */
export interface AgentIdentity {
  mode: 'one-shot' | 'continuable'
  label?: string
}

/** 单个 agent 的渲染输入，完全由其所在行的投影值推导而来。`billed` 与
 *  `costUsage` 刻意使用不同口径：前者是计量后的
 *  token 总量，后者是价格估算所依据的账本。 */
export interface AgentStats {
  head: Headline | null
  requests: number
  billed: number | null
  /** 取自 timeline 的累计 session 成本账本——卡片的价格估算就挂在它上面。 */
  costUsage: SessionCostUsage | null
  durationMs: number | null
  identity: AgentIdentity | null
}

/** 当前 session 的实时统计，比任何列表行都更新。 */
export interface AgentSelfStats {
  head: Headline | null
  billed: number | null
  requests: number
  /** 本标签页自己的成本账本（统计面板的 `data.cost`）。 */
  costUsage?: SessionCostUsage | null
  /** 当前 session 的整步耗时（`data.timing.wallMs`，由 host 在完整日志上折叠得出）。
   * 不是 harness 的 subagent 度量——那个只折叠 turn 窗口，且父 session 根本不会带
   * `subagentTiming` 投影——但这是它唯一能拿到的时长。 */
  durationMs?: number | null
}

/** 森林中一个已放置的节点：它的统计加上图渲染器所需的树/连线事实。`depth` 与 `family`
 *  作为布局输入记录在此，布局阶段因此保持纯函数。 */
export interface AgentNode extends AgentStats {
  id: string
  label: string
  parentId?: string
  depth: number
  /** 本节点属于哪个一级子树（根为 -1）——决定家族连线的色相。 */
  family: number
  isCurrent: boolean
  running: boolean
  completed: boolean
  subagent: boolean
}

/** 当前 session 的家族，已整理成可直接渲染的图。`solo` 标记退化的单节点家族，
 *  卡片据此整个丢掉连线层，而不是画出一片空白。 */
export interface AgentForest {
  /** DFS 前序（父节点排在子节点之前）。 */
  nodes: AgentNode[]
  edges: { from: string; to: string }[]
  overflow: number
  solo: boolean
}

/** 节点数不超过此值时卡片仍可读；超出的部分折叠为一条溢出说明。 */
export const AGENT_TREE_LIMIT = 25

/** 固定卡片高度——agentGraph.css 中 `.lc-agent-card` 的 `height` 与此保持一致，连线的
 * 出点（卡片底边）与入点（卡片顶边）才能始终落在卡片边缘。 */
export const AGENT_CARD_H = 104
/** 水平格距在这些上下界之间随舞台宽度自适应；每个节点占一格，卡片填满该格减去 12px 间隙，
 * 因此卡片既不会压到邻卡也不会顶到舞台边缘。所有卡片共用同一格距——图读起来像网格，
 * 没有哪张卡片能多占空间。 */
const SLOT_MAX = 276
const SLOT_MIN = 150
const CARD_GUTTER = 12
/** 相邻层级之间的垂直步距：卡片高度 + 其下方专供连线使用的 40px 通道。 */
const LEVEL_H = AGENT_CARD_H + 40
const PAD_Y = 48

/** 把一行原始 session 列表记录校验成 {@link AgentRow}；非记录的行返回 null 并被跳过，
 *  只有通过各自类型检查的字段才会保留。 */
export function agentRowOf(value: unknown): AgentRow | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const projections = asRecord(rec.projectionValues)
  return {
    ...(typeof rec.displayTitle === 'string' ? { displayTitle: rec.displayTitle } : {}),
    ...(typeof rec.title === 'string' ? { title: rec.title } : {}),
    ...(typeof rec.parentId === 'string' ? { parentId: rec.parentId } : {}),
    ...(typeof rec.origin === 'string' ? { origin: rec.origin } : {}),
    running: rec.running === true,
    blank: rec.blank === true,
    updatedAt: numOf(rec.updatedAt),
    ...(projections !== null ? { projections } : {}),
  }
}

/** subagent 描述符。`mode` 是判别字段且没有默认值：任何其他取值（将来新增的 harness
 *  mode）都读作「无身份」，而不会当成可用节点。 */
export function agentIdentityOf(value: unknown): AgentIdentity | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (rec.mode !== 'one-shot' && rec.mode !== 'continuable') return null
  return {
    mode: rec.mode,
    ...(typeof rec.label === 'string' && rec.label !== '' ? { label: rec.label } : {}),
  }
}

/** 把 `subagentTiming` 投影折算成一个时长：已结算时间加上当前尚未闭合的区间。未闭合
 *  区间下限截断为 0，因为折叠中途 `through` 可能落后于 `since`；总量非正时返回 null
 *  （零时长不是一个值得打印的数字）。 */
export function agentDurationOf(value: unknown): number | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const settled = numOf(rec.settledMs)
  const active = asRecord(rec.active)
  const openMs = active !== null ? Math.max(0, numOf(active.through) - numOf(active.since)) : 0
  const total = settled + openMs
  return total > 0 ? total : null
}

/** harness 自己的完成信号（其 subagent 头部弹窗上的绿点）：子会话描述符正常结束
 * 之后关闭的最后一个 turn。运行中的 session 永远不算完成，
 * 无论它最后交回了什么。 */
export function agentTurnCompletedOf(value: unknown): boolean {
  return asRecord(value)?.lastTurnCompleted === true
}

/** 把一行记录的投影值折叠成可直接渲染的统计。构成部分优先用插件自己的 `contextTimeline`；
 * 只有压力值的行仍能给出占用环，只是没有分片。 */
export function agentStatsOf(values: Record<string, unknown> | undefined): AgentStats {
  const timeline = timelineOf(values?.contextTimeline)
  const pressure = contextPressureOf(values?.contextPressure)
  const breakdown = contextBreakdownOf(values?.contextBreakdown)
  const usage = tokenUsageOf(values?.tokenUsage)
  let head: Headline | null = null
  if (timeline !== null) {
    head = headlineOf(timeline, pressure, breakdown)
  } else if (pressure !== null) {
    const tokens = typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens
      : typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens
        : null
    if (tokens !== null) {
      const window = typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0
        ? pressure.contextWindow
        : undefined
      head = {
        tokens,
        window,
        pct: window !== undefined ? occupancyPercent(tokens, window) : null,
        parts: [],
      }
    }
  }
  const billed = usage !== null
    ? numOf(usage.uncachedInputTokens) + numOf(usage.outputTokens) + numOf(usage.cacheReadTokens) + numOf(usage.cacheWriteTokens)
    : null
  return {
    head,
    // 分离生成方式的 wire head 自带预算好的计数；内联生成方式的行则自行统计已服务的记录。
    requests: timeline !== null ? (timeline.counts?.steps ?? timeline.requests.length) : 0,
    billed,
    costUsage: timeline?.cost ?? null,
    durationMs: agentDurationOf(values?.subagentTiming),
    identity: agentIdentityOf(values?.subagent),
  }
}

/**
 * 从父行的 `subagentCatalog` 投影得到生成顺序排名——即 harness 头部
 * 弹窗自己的兄弟排序（父会话目录事件顺序）。缺失、为空或恶意
 * 取值都返回 null，调用方继续沿用其活跃度启发式；
 * 格式错误的条目单独丢弃。
 */
export function catalogOrderOf(values: Record<string, unknown> | undefined): Map<string, number> | null {
  const cat = values?.subagentCatalog
  if (!Array.isArray(cat)) return null
  const order = new Map<string, number>()
  for (const entry of cat) {
    const rec = asRecord(entry)
    if (rec === null || typeof rec.id !== 'string' || rec.id === '') continue
    if (!order.has(rec.id)) order.set(rec.id, order.size)
  }
  return order.size > 0 ? order : null
}

interface AgentChild {
  id: string
  row: AgentRow
}

/**
 * 构建当前 session 的 agent 家族：沿 `parentId` 向上走到最上层已知祖先，
 * 再 DFS 它的整棵子树（排除空行）。没有锚点时返回 null；
 * 列表尚未下发当前 session 时，就地合成一行占位记录，
 * 让图仍以它为锚点，而不是直接返回 null。
 * @param fetched - 冷行的 detail 通道 head，以 session id 为键。
 *   列表块只从投影缓存提供投影值，因此这些 head 用来补上那些
 *   否则只会列出压力值的亲属；而行自身的投影值始终优先于
 *   抓取到的 head。
 */
export function agentForestOf(
  snapshot: unknown,
  currentId: string | undefined,
  self?: AgentSelfStats,
  fetched?: ReadonlyMap<string, unknown>,
): AgentForest | null {
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null || currentId === undefined || currentId === '') return null

  const rows = new Map<string, AgentRow>()
  for (const key of Object.keys(byId)) {
    const row = agentRowOf(byId[key])
    // 空占位 session（从未被使用过）不算 agent；但当前 session 永远保留。
    if (row !== null && (!row.blank || key === currentId)) rows.set(key, row)
  }
  if (!rows.has(currentId)) {
    // 列表尚未下发当前 session（它已被打开但还没出现在列表中）：
    // 合成一条空记录，让图仍以它为锚点，而不是直接返回 null。
    rows.set(currentId, { running: false, blank: false, updatedAt: 0 })
  }

  // 最上层已知祖先；血缘成环时，锚定在第一次重复的 id 处。
  let root = currentId
  const chain = new Set<string>([currentId])
  for (;;) {
    const parent = rows.get(root)?.parentId
    if (parent === undefined || !rows.has(parent) || chain.has(parent)) break
    chain.add(parent)
    root = parent
  }
  const rootRow = rows.get(root)
  /** v8 ignore next 2 -- root 要么是 currentId（上面已插入），要么是通过 rows.has 验证过的父节点，所以它的行必然存在。 */
  if (rootRow === undefined) return null

  const childrenOf = new Map<string, AgentChild[]>()
  for (const [id, row] of rows) {
    // 父节点不在 `rows` 里的子节点会整条从图上丢掉：它属于本家族之外的血缘，
    // 保留它只会画出一条孤儿边。
    if (row.parentId === undefined || !rows.has(row.parentId)) continue
    const list = childrenOf.get(row.parentId) ?? []
    list.push({ id, row })
    childrenOf.set(row.parentId, list)
  }
  for (const [pid, kids] of childrenOf) {
    // 有缓存时，兄弟顺序沿用父节点的 subagent 目录（即 harness 头部弹窗
    // 自己的生成顺序）；未入目录的子节点排在已入目录的之后，
    // 父节点若无目录则活动度启发式照旧。
    const order = catalogOrderOf(rows.get(pid)?.projections)
    kids.sort((a, b) => {
      const ra = order?.get(a.id)
      const rb = order?.get(b.id)
      // 只有至少一方有目录排名时，目录排名才胜过启发式；
      // 否则整组兄弟都回退到运行中/新旧/id 的比较。
      if (ra !== undefined || rb !== undefined) {
        // 同一父节点下的目录排名互不相同，所以两个有排名的 id 在这里不会打平。
        if (ra === undefined) return 1
        if (rb === undefined) return -1
        return ra - rb
      }
      const runDelta = Number(b.row.running) - Number(a.row.running)
      if (runDelta !== 0) return runDelta
      const timeDelta = b.row.updatedAt - a.row.updatedAt
      return timeDelta !== 0 ? timeDelta : (a.id < b.id ? -1 : 1)
    })
  }

  // 在 DFS 之前先量出总数，这样即使上限截短了遍历，溢出说明依然精确。
  const measure = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    let total = 1
    for (const kid of childrenOf.get(id) ?? []) total += measure(kid.id, seen)
    return total
  }
  const total = measure(root, new Set())

  const nodes: AgentNode[] = []
  const edges: { from: string; to: string }[] = []
  /** 递归 DFS，先输出父节点再输出子节点。`family` 一路传递而非重复计算；
   *  上限在这里（而不是事后）检查，使超限的森林直接停止遍历，
   *  而不是缩小它的溢出说明。 */
  const visit = (id: string, row: AgentRow, parentId: string | undefined, depth: number, seen: Set<string>, family: number): void => {
    if (seen.has(id) || nodes.length >= AGENT_TREE_LIMIT) return
    seen.add(id)
    const values = row.projections
    const fetchedHead = fetched !== undefined ? fetched.get(id) : undefined
    const stats = agentStatsOf(fetchedHead !== undefined && values?.contextTimeline === undefined
      // 行自身的投影永远优先于抓取来的 head：列表块的值可能新几秒，
      // 只有缺失的情况才需要冷读。
      ? { ...values, contextTimeline: fetchedHead }
      : values)
    const identity = stats.identity
    if (id === currentId && self !== undefined) {
      stats.head = self.head ?? stats.head
      stats.billed = self.billed ?? stats.billed
      stats.requests = self.requests > 0 ? self.requests : stats.requests
      stats.costUsage = self.costUsage ?? stats.costUsage
      stats.durationMs = self.durationMs ?? stats.durationMs
    }
    const subagent = row.origin === 'subagent' || identity !== null
    const node: AgentNode = {
      ...stats,
      id,
      label: identity?.label ?? row.title ?? row.displayTitle ?? id,
      ...(parentId !== undefined ? { parentId } : {}),
      depth,
      family,
      isCurrent: id === currentId,
      running: row.running,
      // 按 harness 弹窗自己的规则判定完成：只针对已停止的 agent，信号是最后一个关闭的
      // subagent turn 正常结束。非 subagent 的 session 不会带这个投影，
      // 因此用它自己折叠出的步数代替。
      completed: !row.running
        && (agentTurnCompletedOf(values?.subagentTiming) || (!subagent && stats.requests > 0)),
      subagent,
    }
    nodes.push(node)
    if (parentId !== undefined) edges.push({ from: parentId, to: id })
    const kids = childrenOf.get(id) ?? []
    kids.forEach((kid, ki) => {
      // 根节点之子的序号成为它的家族 id；更深节点继承该值，
      // 于是每个一级子树无论多深都只有一种色相（familyHue）。
      visit(kid.id, kid.row, id, depth + 1, seen, depth === 0 ? ki : family)
    })
  }
  visit(root, rootRow, undefined, 0, new Set(), -1)

  return { nodes, edges, overflow: Math.max(0, total - nodes.length), solo: nodes.length === 1 }
}

/** 子树折叠的结果：合并后的账本、仍在等待精简 head 抓取的 id，
 *  以及后代数量（不含当前 session 本身）。 */
export interface SubagentCostFold {
  usage: SessionCostUsage | null
  /** 既没有 timeline 记录也没有已落地 head 的后代——即精简 head 的抓取目标。 */
  cold: string[]
  count: number
}

/** 合并当前 session 的 SUBAGENT 子树成本：优先取热行的
 * `contextTimeline` 成本，抓取到的精简 head（`landed`）替代
 * 没有 timeline 值的行。空行不是 agent；当前 session
 * 本身从不计入——调用方已持有它自己的用量。
 *
 * 用带 `seen` 集合的 BFS：行图是不可信的 wire 数据，
 * 成环或重复的 `parentId` 链不能让遍历打转或把账本重复计一次。 */
export function subagentCostFoldOf(
  snapshot: unknown,
  currentId: string | undefined,
  landed?: ReadonlyMap<string, ContextTimeline>,
): SubagentCostFold {
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null || currentId === undefined || currentId === '') return { usage: null, cold: [], count: 0 }
  const childrenOf = new Map<string, string[]>()
  for (const key of Object.keys(byId)) {
    const row = agentRowOf(byId[key])
    if (row === null || row.blank || row.parentId === undefined) continue
    const list = childrenOf.get(row.parentId) ?? []
    list.push(key)
    childrenOf.set(row.parentId, list)
  }
  const parts: SessionCostUsage[] = []
  const cold: string[] = []
  const seen = new Set<string>([currentId])
  const queue = [currentId]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const kid of childrenOf.get(id) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      const head = landed?.get(kid)
      const values = agentRowOf(byId[kid])?.projections
      if (values?.contextTimeline === undefined) {
        // 冷亲属的用量挂在抓取到的精简 head 上；在 head 落地之前
        // 该 id 始终是抓取目标，而 head 一旦落地即为最终结果。
        if (head === undefined) cold.push(kid)
        else if (head.cost !== undefined) parts.push(head.cost)
      } else {
        const cost = timelineOf(values.contextTimeline)?.cost
        if (cost !== undefined) parts.push(cost)
      }
      queue.push(kid)
    }
  }
  return { usage: parts.length > 0 ? mergeCostUsage(...parts) : null, cold, count: seen.size - 1 }
}

/** 节点在舞台坐标系中的中心点（px）。 */
export interface AgentPoint {
  id: string
  x: number
  y: number
  depth: number
}

/** 一条父→子曲线，端点已换算成像素，渲染器因此不含任何布局逻辑；
 *  `running` 与 `color` 同样在这里解析，理由相同。 */
export interface AgentLink {
  to: string
  running: boolean
  color: string
  x1: number
  y1: number
  x2: number
  y2: number
}

/** 舞台坐标系下已完成布局的图：`width`/`height` 决定可滚动舞台的尺寸，
 *  `points`/`links` 可直接绘制，`cardW` 是每张卡片的绘制宽度。 */
export interface AgentLayout {
  width: number
  height: number
  /** 响应式布局给出的卡片宽度（格子压缩时随之变窄）。 */
  cardW: number
  points: AgentPoint[]
  links: AgentLink[]
}

/** 整洁的自顶向下树布局：兄弟占据叶槽位，父节点居中于其子节点之上。
 * 格距在 SLOT_MAX 与 SLOT_MIN 之间随舞台宽度自适应；
 * 仍然放不下的层折成多带，因为竖向空间比横向滚动更划算。 */
export function layoutForest(forest: AgentForest, stageWidth = 0): AgentLayout {
  // 节点是 DFS 前序，所以顺序遍历即可按访问顺序追加子节点。
  const childrenOf = new Map<string, AgentNode[]>()
  for (const n of forest.nodes) {
    if (n.parentId === undefined) continue
    const kids = childrenOf.get(n.parentId) ?? []
    kids.push(n)
    childrenOf.set(n.parentId, kids)
  }

  const slotOf = new Map<string, number>()
  let leafSlots = 0
  const place = (node: AgentNode): number => {
    const kids = childrenOf.get(node.id) ?? []
    if (kids.length === 0) {
      const slot = leafSlots
      leafSlots++
      slotOf.set(node.id, slot)
      return slot
    }
    let first = 0
    let last = 0
    kids.forEach((kid, index) => {
      const slot = place(kid)
      if (index === 0) first = slot
      last = slot
    })
    const slot = (first + last) / 2
    slotOf.set(node.id, slot)
    return slot
  }
  /** v8 ignore next 1 -- 森林至少包含（可能被合成出来的）当前节点。 */
  if (forest.nodes.length > 0) place(forest.nodes[0])

  const perLevel = stageWidth > 0 ? Math.max(1, Math.floor(stageWidth / SLOT_MIN)) : 0

  if (perLevel > 0 && leafSlots > perLevel) {
    // 折行布局：各带按亲缘交错，每条父带之后
    // 恰好跟着这些父节点各自子节点的带，兄弟组不会被拆开，除非单组本身就超过一带宽。
    // 带宽上限为 SLOT_MAX：舞台较宽时多出来的宽度
    // 归给间隙，而不是把卡片拉得更开。
    const bandSlot = Math.min(SLOT_MAX, stageWidth / perLevel)
    const width = perLevel * bandSlot
    const points: AgentPoint[] = []
    let row = 0
    const emitBand = (nodes: AgentNode[], depth: number): void => {
      // 每条带在舞台中居中：各带节点数不同，
      // 左对齐会看起来像一道并非本意的阶梯。
      const inset = (width - nodes.length * bandSlot) / 2
      nodes.forEach((node, i) => {
        points.push({ id: node.id, x: inset + (i + 0.5) * bandSlot, y: PAD_Y + row * LEVEL_H, depth })
      })
      row++
      let band: AgentNode[] = []
      const flush = (): void => {
        if (band.length === 0) return
        const packed = band
        band = []
        emitBand(packed, depth + 1)
      }
      for (const node of nodes) {
        const kids = childrenOf.get(node.id) ?? []
        for (let start = 0; start < kids.length; start += perLevel) {
          const group = kids.slice(start, start + perLevel)
          if (band.length + group.length > perLevel) flush()
          band.push(...group)
          if (band.length === perLevel) flush()
        }
      }
      flush()
    }
    /* v8 ignore next 1 -- 森林至少包含当前节点。 */
    if (forest.nodes.length > 0) emitBand([forest.nodes[0]], 0)
    return {
      width,
      height: PAD_Y + (row - 1) * LEVEL_H + AGENT_CARD_H + 24,
      cardW: bandSlot - CARD_GUTTER,
      points,
      links: linksOf(forest, points),
    }
  }

  // 自适应格距；0 = 舞台宽度未测量（取自然最大值）。
  // 只有一个叶子时无格距可解，因此未测量或单叶子的舞台取
  // SLOT_MAX，而不是去除以一个给不出任何信息的叶子数。
  const slot = stageWidth > 0 && leafSlots > 1 ? Math.min(SLOT_MAX, stageWidth / leafSlots) : SLOT_MAX
  const points: AgentPoint[] = forest.nodes.map(node => ({
    id: node.id,
    /** v8 ignore next 1 -- place() 会访问每个节点：按构造，森林恰好就是根节点的子树。 */
    x: (slotOf.get(node.id) ?? 0) * slot + slot / 2,
    y: PAD_Y + node.depth * LEVEL_H,
    depth: node.depth,
  }))
  const maxDepth = points.reduce((max, p) => Math.max(max, p.depth), 0)
  return {
    width: leafSlots * slot,
    height: PAD_Y + maxDepth * LEVEL_H + AGENT_CARD_H + 24,
    cardW: slot - CARD_GUTTER,
    points,
    links: linksOf(forest, points),
  }
}

/** 一级子树序号到家族色相：黄金角让相邻家族在色轮上自然分开，
 * 无需手工调色板。 */
export function familyHue(index: number): string {
  return `hsl(${Math.round(index * 137.508) % 360} 58% 52%)`
}

function linksOf(forest: AgentForest, points: AgentPoint[]): AgentLink[] {
  const pointOf = new Map(points.map(p => [p.id, p]))
  const nodeOf = new Map(forest.nodes.map(n => [n.id, n]))
  const runningIds = new Set(forest.nodes.filter(n => n.running).map(n => n.id))
  const links: AgentLink[] = []
  for (const edge of forest.edges) {
    const from = pointOf.get(edge.from)
    const to = pointOf.get(edge.to)
    /** v8 ignore next 2 -- 边只为已访问的父子对生成，所以两个端点必然存在。 */
    if (from === undefined || to === undefined) continue
    links.push({
      to: edge.to,
      running: runningIds.has(edge.to),
      /* v8 ignore next 1 -- 边只连接已访问的节点。 */
      color: familyHue(nodeOf.get(edge.to)?.family ?? 0),
      // 从父卡片底边出发，进入子卡片顶边。折行后子节点可能被放到下面好几行，
      // 曲线会从中间那些行的后方穿过（连线层绘制在卡片之下）——
      // 读起来是纵深感，而不是交叉。
      x1: from.x,
      y1: from.y + AGENT_CARD_H,
      x2: to.x,
      y2: to.y,
    })
  }
  return links
}

/** 悬停节点的血缘：祖先链加上它整棵子树——即血缘聚焦时
 * 连线会点亮的那组节点 id。无 id 或 id 未知时返回 null。
 *
 * 祖先回溯在父节点缺失处终止；后代遍历以
 * `lit` 集合为键，因此畸形的环状 `parentId` 无法让它打转。 */
export function lineageOf(forest: AgentForest, id: string | null): Set<string> | null {
  if (id === null) return null
  const byId = new Map(forest.nodes.map(n => [n.id, n]))
  const start = byId.get(id)
  if (start === undefined) return null
  const lit = new Set<string>()
  let cur: AgentNode | undefined = start
  while (cur !== undefined) {
    lit.add(cur.id)
    cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined
  }
  const queue = [id]
  for (let i = 0; i < queue.length; i++) {
    // 对每个出队的 id 扫描整个节点列表：森林上限为 AGENT_TREE_LIMIT，
    // 因此建邻接表的开销比这种逐节点线性扫描还大。
    for (const n of forest.nodes) {
      if (n.parentId === queue[i] && !lit.has(n.id)) {
        lit.add(n.id)
        queue.push(n.id)
      }
    }
  }
  return lit
}

/** 堆叠条的一段，按占整条的比例计。`free` 标记空的剩余部分，
 *  它不带颜色，改由轨道绘制。 */
export interface BarSeg {
  key: string
  /** 分段颜色；空的剩余部分改由条的轨道来着色。 */
  color: string
  /** 占整条的比例（0..1）——占用率缩放构成部分，空余比补齐到整条。 */
  share: number
  free: boolean
}

/** 只有压力值（无构成数据）时的填充色阈值，同时也是卡片上百分比数字的配色。 */
export function pressureColorOf(pct: number | null): string {
  if (pct === null) return 'var(--dsw-alias-border-l1)'
  if (pct >= 90) return 'var(--color-red-500)'
  if (pct >= 70) return 'var(--color-amber-500)'
  return 'var(--color-green-500)'
}

/** 每个 agent 一条构成条——沿用聊天输入环自身的语义并压平：各构成部分
 * 按占用份额缩放后填充条体，中性色的剩余部分标出空闲窗口。
 * 窗口未知时填满整条；没有构成数据时
 * 回退为单段按阈值着色的占用填充。 */
export function barSegments(parts: PartsPart[], pct: number | null, fallbackColor: string): BarSeg[] {
  const occ = pct === null ? 1 : Math.min(100, Math.max(0, pct)) / 100
  // 求和时按 `value > 0 ? value : 0` 兜底，避免负数分段把
  // 总量压到低于正值之和，从而抬高每一个份额。
  let total = 0
  for (const p of parts) total += p.value > 0 ? p.value : 0
  const segs: BarSeg[] = []
  let acc = 0
  if (total > 0) {
    for (const p of parts) {
      if (p.value <= 0) continue
      const share = (p.value / total) * occ
      if (share <= 0) continue
      segs.push({ key: p.key, color: p.color, share, free: false })
      acc += share
    }
  } else if (pct !== null && occ > 0) {
    segs.push({ key: 'fill', color: fallbackColor, share: occ, free: false })
    acc = occ
  }
  if (pct !== null && acc < 1) {
    segs.push({ key: 'free', color: '', share: 1 - acc, free: true })
  }
  return segs
}

/** 把 `sessions` 服务校验成卡片消费的 list/refresh 子集；`list`
 *  必须同时带两个动词，因为二者都会被无条件订阅。面孔缺失或不完整时返回 null
 *  而非抛错，调用方据此回退到静态空面板。 */
export function sessionsFaceOf(ctx: { get(name: string): unknown }): SessionsFaceLike | null {
  const rec = asRecord(ctx.get('sessions'))
  if (rec === null) return null
  const list = asRecord(rec.list)
  if (list === null || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return null
  return rec
}

/** 紧凑时长：`42s`、`3m05s`、`1h07m`。与 format.ts 的
 * `fmtDuration` 不同——后者的十进制秒数无法用于 inspector 固定宽度的标题列。 */
export function fmtDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
