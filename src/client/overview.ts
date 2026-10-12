/**
 * Context Insights 页的数据层，从根作用域的 `useSessions` 快照派生而来：
 * 每条 session 列表行都已带上 host 的 `contextTimeline` 与
 * `contextActivity`，因此面板无需打开任何日志就能读出每个 session
 * 的洞察。
 *
 * subagent 来源的 session 不会出现在列表里（工作区浏览器把它们排除在外），
 * 因此每一行都折叠自己整棵后代子树，一个家族作用域同时喂养
 * 卡片、KPI 带、图表与热力图。
 */

import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { dayKeyOf, endOfDayKey, startOfDayKey } from '../shared/days'
import { billedParts } from './categories'
import { cacheHitPercent } from './format'
import { estimateSessionCost, estimateSessionCostByPeriod, mergeCostUsage } from './cost'
import { mergeCallCounts, mergePlatformSpends, platformSpendsOf, type PlatformSpend } from './platformSpend'
import type { CostCurrency, ModelBook } from './cost'
import { agentRowOf } from './agentTree'
import { activityOf, asRecord, timelineOf, type ClientCtx, type SessionsFace } from './services'
import type { ActivityDay, ContextActivity, ContextTimeline, SessionCallCounts, SessionCostUsage, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

/** 一条 session 列表行在 Insights 页渲染时的形态。`family` 与 `familyCost`
 *  是**该行**的子树（自身排在首位），列表因此无需打开任何日志
 *  就能过滤与求和。 */
export interface OverviewRow {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  current: boolean
  timeline: ContextTimeline | null
  /** 整个**团队**合并后的按日账本：本 session 自己的加上每个后代 subagent 的。 */
  activity: ContextActivity | null
  /** 子树每个成员经清洗的 head，自身在前；各成员分别按自己的构成配比拆分。 */
  family: (ContextTimeline | null)[]
  /** 子树合并后的计费用量；没有任何计费时为 null。 */
  familyCost: SessionCostUsage | null
  /** 该会话家族的请求次数（按 provider → model）；积分平台的消费靠它。 */
  familyCalls?: SessionCallCounts | null
}

/** 两个快照读取器背后带防护的标准 props 读取。在面板顶部
 * 无条件调用：该座位是 hook，而引用稳定的选择器让快照对 useMemo
 * 保持引用稳定。 */
function standardSnapshotOf(seat: unknown): unknown {
  if (typeof seat !== 'function') return null
  try {
    return (seat as <T>(selector: (snapshot: unknown) => T) => T)(snapshot => snapshot)
  } catch {
    return null
  }
}

/** 根作用域 `useSessions` 座位交付的 session 列表快照；座位缺失时为 null，
 *  调用方将其渲染为空列表（绝不渲染成错误）。 */
export function sessionsSnapshotOf(props: { useSessions?: unknown }): unknown {
  return standardSnapshotOf(props.useSessions)
}

/** 根作用域 `useWorkspaces` 座位交付的工作区列表快照；用于喂给
 *  分组面包屑、分组芯片以及归档行的排除逻辑。 */
export function workspacesSnapshotOf(props: { useWorkspaces?: unknown }): unknown {
  return standardSnapshotOf(props.useWorkspaces)
}

/** session id → 工作区标题，直接读取注册表自己的成员列表，
 * 而不是从路径猜测。没有任何工作区认领的 session 不属于任何面包屑
 * 分组：「Ungrouped」是一个容器，而不是用来打印的名字。 */
export function sessionGroupsOf(snapshot: unknown): Record<string, string> | null {
  const state = asRecord(snapshot)
  if (state === null || !Array.isArray(state.items)) return null
  const groups: Record<string, string> = {}
  // 放宽类型：Record 索引读取在运行时可能落空。
  const claimed: Record<string, string | undefined> = groups
  for (const item of state.items) {
    const workspace = asRecord(item)
    if (workspace === null) continue
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : undefined
    if (title === undefined || !Array.isArray(workspace.sessionIds)) continue
    for (const id of workspace.sessionIds) {
      if (typeof id === 'string' && claimed[id] === undefined) groups[id] = title
    }
  }
  return groups
}

/** 卡片的项目名：沿用工作区浏览器自己的 basename 推导（两种分隔符都处理）。 */
export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const title = workspaceTitleOf(cwd)
  return title === '' ? undefined : title
}

/** 未分组桶在分组过滤芯片中的键；标题绝不会与之冲突（注册表会对名字去重）。 */
export const UNGROUPED_KEY = '__ungrouped__'

/** 一个分组芯片及其覆盖的作用域内行数。 */
export interface GroupCount {
  key: string
  count: number
}

/** 各分组芯片的计数，按注册表顺序排列、未分组桶在最后，
 * 且只统计已受作用域限制的行，使每个芯片都反映用户当前的筛选；作用域内没有行的分组会被剔除。 */
export function groupCountsOf(rows: readonly OverviewRow[], snapshot: unknown): GroupCount[] {
  const state = asRecord(snapshot)
  if (state === null || !Array.isArray(state.items)) return []
  // session id → 认领它的工作区标题（先认领者胜，与面包屑一致）。
  const claimed = new Map<string, string>()
  const titles: string[] = []
  for (const item of state.items) {
    const workspace = asRecord(item)
    if (workspace === null) continue
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : undefined
    if (title === undefined || !Array.isArray(workspace.sessionIds)) continue
    titles.push(title)
    for (const id of workspace.sessionIds) {
      if (typeof id === 'string' && !claimed.has(id)) claimed.set(id, title)
    }
  }
  const counts = new Map<string, number>()
  let ungrouped = 0
  for (const row of rows) {
    const title = claimed.get(row.id)
    if (title === undefined) ungrouped++
    else counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  const groups: GroupCount[] = []
  for (const title of titles) {
    const count = counts.get(title) ?? 0
    if (count > 0) groups.push({ key: title, count })
  }
  if (ungrouped > 0) groups.push({ key: UNGROUPED_KEY, count: ungrouped })
  return groups
}

/** 判断某一行是否属于当前激活的分组芯片。`groups` 是每个快照只派生一次的
 *  id→标题映射；映射为 null 以及未分组的键，都表示「没有工作区
 *  认领这一行」。 */
export function inGroup(row: OverviewRow, group: string, groups: Record<string, string> | null): boolean {
  const byId: Record<string, string | undefined> = groups ?? {}
  const title = byId[row.id]
  return group === UNGROUPED_KEY ? title === undefined : title === group
}

/** 失败即放行：座位缺失、形态不可信或访问器抛错都不会归档任何行，过滤因此永远不会把列表清空。 */
function archivedSetOf(workspaces: unknown): Set<string> {
  try {
    const value = asRecord(workspaces)?.archivedSessionIds
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

/** 把原始 session 列表快照连接成可直接渲染的行；不可用时返回 null
 * （与真正的空列表区分开）。空占位行与归档行都会剔除；
 * 一行抛错只损失它自己。 */
export function rowsOfSnapshot(snapshot: unknown, workspaces?: unknown): OverviewRow[] | null {
  const state = asRecord(snapshot)
  if (state === null) return null
  if (!Array.isArray(state.ids)) return null
  const ids: string[] = state.ids.filter((id): id is string => typeof id === 'string')
  const archived = archivedSetOf(workspaces)
  const byId = asRecord(state.byId) ?? {}
  const current = typeof state.current === 'string' ? state.current : undefined
  const rows: OverviewRow[] = []
  for (const id of ids) {
    if (archived.has(id)) continue
    // 一行不可信只损失它自己：try 内任何访问器抛错都只丢掉
    // 该行，列表其余部分照常渲染。
    try {
      const row = asRecord(byId[id])
      if (row === null) continue
      if (row.blank === true) continue
      // subagent 来源的 session 属于工作区浏览器自己的排除项：
      // 普通的 open() 无法寻址它们（host 要求持久父地址），
      // 因此总览只列出主线 session。
      if (row.origin === 'subagent') continue
      const displayTitle = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : undefined
      const title = typeof row.title === 'string' && row.title !== '' ? row.title : undefined
      const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined
      const values = asRecord(row.projectionValues)
      rows.push({
        id,
        title: displayTitle ?? title ?? id,
        ...(cwd !== undefined ? { cwd } : {}),
        updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
        running: row.running === true,
        current: id === current,
        timeline: timelineOf(values?.contextTimeline),
        activity: activityOf(values?.contextActivity),
        family: [],
        familyCost: null,
        familyCalls: null,
      })
    } catch {
      // 不可信的行（访问器抛错）整条丢弃；列表继续工作。
    }
  }
  // 与 Context 标签页自己的成本折叠一致（agentTree 的 subagentCostFoldOf）：
  // 非空行的 parentId 构成 childrenOf，用带 seen 集合的 BFS 防环。
  const childrenOf = new Map<string, string[]>()
  for (const id of Object.keys(byId)) {
    try {
      const row = agentRowOf(byId[id])
      if (row === null || row.blank || row.parentId === undefined) continue
      const list = childrenOf.get(row.parentId) ?? []
      list.push(id)
      childrenOf.set(row.parentId, list)
    } catch { /* 不可信的行谁也连接不到 */ }
  }
  for (const row of rows) {
    const timelines: (ContextTimeline | null)[] = [row.timeline]
    const activities: (ContextActivity | null)[] = [row.activity]
    const seen = new Set<string>([row.id])
    const queue = [row.id]
    for (let i = 0; i < queue.length; i++) {
      for (const kid of childrenOf.get(queue[i]) ?? []) {
        if (seen.has(kid)) continue
        seen.add(kid)
        const values = asRecord(asRecord(byId[kid])?.projectionValues)
        timelines.push(timelineOf(values?.contextTimeline))
        activities.push(activityOf(values?.contextActivity))
        queue.push(kid)
      }
    }
    row.family = timelines
    row.familyCost = mergeCostUsage(...timelines.map(t => t?.cost))
    row.familyCalls = mergeCallCounts(...timelines.map(t => t?.calls))
    row.activity = mergeActivity(activities)
  }
  return rows
}

/** 把多个 session 的按日账本合并成一份家族账本：按日累加 token
 * 与请求数，合并计价记录，技能表则按名逐项合并（加载数求和，last-load 取最大）。 */
function mergeActivity(members: (ContextActivity | null)[]): ContextActivity | null {
  const days: ContextActivity['days'] = {}
  const byKey: Record<string, ContextActivity['days'][string] | undefined> = days
  let any = false
  for (const activity of members) {
    if (activity === null) continue
    any = true
    for (const key of Object.keys(activity.days)) {
      const entry = activity.days[key]
      const prev = byKey[key]
      if (prev === undefined) {
        days[key] = {
          tokens: entry.tokens,
          requests: entry.requests,
          ...(entry.cost !== undefined ? { cost: entry.cost } : {}),
          ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
        }
      } else {
        prev.tokens += entry.tokens
        prev.requests += entry.requests
        if (entry.cost !== undefined) {
          /* v8 ignore next 1 -- 有确定输入参与合并时绝不会返回空。 */
          prev.cost = mergeCostUsage(prev.cost, entry.cost) ?? entry.cost
        }
        if (entry.skills !== undefined) prev.skills = mergeSkillTallies(prev.skills, entry.skills)
      }
    }
  }
  return any ? { days } : null
}

/** 合并两天的技能表：加载数在家族内**求和**，而 `last` 取最新的
 *  时刻，因为同一个技能被两个 agent 加载过，最后加载时间仍只有一个。 */
function mergeSkillTallies(a: ActivityDay['skills'], b: NonNullable<ActivityDay['skills']>): NonNullable<ActivityDay['skills']> {
  const out: Record<string, { n: number; last: number } | undefined> = { ...a }
  for (const name of Object.keys(b)) {
    const tally = b[name]
    const prev = out[name]
    out[name] = prev === undefined ? tally : { n: prev.n + tally.n, last: Math.max(prev.last, tally.last) }
  }
  return out as NonNullable<ActivityDay['skills']>
}

/** 预设范围键，每一个都是以 `now` 为锚点的滚动窗口。 */
export type OverviewRange = 'today' | '7d' | '30d' | 'all'

/** 解析后的作用域窗口：含两端的 epoch 毫秒边界，某一端开放时为 null。
 * 预设只钉住起点；日历选择器则把两端都闭合。 */
export interface RangeWindow {
  start: number | null
  end: number | null
}

/** 完全开放的窗口（"all" 预设）；因为要交给每个作用域读取器，所以冻结。 */
export const OPEN_WINDOW: RangeWindow = Object.freeze({ start: null, end: null })

/** 日历挑选的范围：两个含端点的本地日键，永远有序。选择器与
 * {@link dayRangeWindow} 都会对这一对排序，因此没有读取器会看到
 * 逆序范围，颠倒的一对也不会把页面过滤成空。 */
export interface DayRange {
  from: string
  to: string
}

/** 把挑选的一对规范化成 `from <= to`：下游每个读取器（以及选择器
 *  自己的状态）从此都可以假定顺序、省去交换。 */
export function orderedDayRange(a: string, b: string): DayRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

/** 预设对应的窗口（epoch 毫秒）。"Today" 以本地午夜为起点——
 * 用日期字段做运算能让夏令时缩短或加长的那一天保持精确，而按 epoch 毫秒相减会漂到相邻日。
 */
export function rangeWindowOf(range: OverviewRange, now: number): RangeWindow {
  if (range === 'all') return OPEN_WINDOW
  const start = rangeStartOf(range, now)
  return { start, end: null }
}

/** 预设起点是**滚动**的，锚在 `now` 上（从不锚在午夜）："last 7 days" 随
 *  时钟移动，只有 "today" 需要日历运算来得到夏令时安全的午夜。 */
function rangeStartOf(range: Exclude<OverviewRange, 'all'>, now: number): number {
  if (range === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return midnight.getTime()
  }
  return now - (range === '7d' ? 7 : 30) * 86_400_000
}

/** 挑选范围的窗口：起始日的午夜到结束日的最后一毫秒，
 * 两个被选中的日子因此都完整计入。某个键畸形时返回 null——调用方此时保留预设作用域。 */
export function dayRangeWindow(range: DayRange): RangeWindow | null {
  const ordered = orderedDayRange(range.from, range.to)
  const start = startOfDayKey(ordered.from)
  const end = endOfDayKey(ordered.to)
  if (start === null || end === null) return null
  return { start, end }
}

/** session 网格的排序键：`context` 按**当前**上下文 token 的绝对量降序，
 *  取 `timeline.current.total`（不是累计计费 token）。注意它与卡片圆环口径不同：
 *  环图展示的是 `current.total / contextWindow` 的占比，因此窗口不同的两个 session
 *  之间，排序与环图读数可能给出相反的观感。 */
export type OverviewSort = 'recent' | 'tokens' | 'context'

/** 团队卡片的累计计费 token；没有任何计费时为 null；排序与卡片统计共用这个数字。 */
export function billedOf(row: OverviewRow): number | null {
  const totals = usageTotalsOf(row.familyCost)
  return totals?.total ?? null
}

/** 用于展示的 turn 数：分离生成方式提供服务时用精简 head 预算好的
 *  `counts.turns`，否则用已服务的请求记录条数（内联生成方式）。 */
export function turnsOf(timeline: ContextTimeline | null): number {
  if (timeline === null) return 0
  return timeline.counts?.turns ?? timeline.requests.length
}

/** 该 session 首个活跃日（账本中最早的键）——卡片的
 * 创建日期行：列表行不带创建时间，因此用首个计费日顶替。 */
export function createdDayOf(activity: ContextActivity | null): string | undefined {
  const days = activity?.days
  if (days === undefined) return undefined
  let first: string | undefined
  for (const key of Object.keys(days)) {
    if (first === undefined || key < first) first = key
  }
  return first
}

/** 一趟应用页面的三个过滤器。日期过滤要求**确实有**活动
 *  （仅仅存在于那天的行不算那天「活跃」），查询则匹配标题、工作区路径
 *  或最后一条 user 消息——用户对某个 session
 *  通常就记得这三样。 */
export function filterRows(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null; query: string },
): OverviewRow[] {
  const query = opts.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (opts.scope.start !== null && row.updatedAt < opts.scope.start) return false
    if (opts.scope.end !== null && row.updatedAt > opts.scope.end) return false
    if (opts.day !== null) {
      const entry = row.activity?.days[opts.day]
      if (entry === undefined || (entry.tokens <= 0 && entry.requests <= 0)) return false
    }
    if (query !== '') {
      const inTitle = row.title.toLowerCase().includes(query)
      const inCwd = row.cwd !== undefined && row.cwd.toLowerCase().includes(query)
      const lastUser = row.timeline?.lastUser
      const inLastUser = typeof lastUser === 'string' && lastUser.toLowerCase().includes(query)
      if (!inTitle && !inCwd && !inLastUser) return false
    }
    return true
  })
}

/** 排序**副本**（调用方的数组可能是 React state）。每个键都降序，且
 *  缺失的数字按 -1 排在最后而不是当作 0，未定价的 session 因此
 *  永远压不过真正便宜的 session。 */
export function sortRows(rows: readonly OverviewRow[], sort: OverviewSort): OverviewRow[] {
  const copy = [...rows]
  if (sort === 'tokens') copy.sort((a, b) => (billedOf(b) ?? -1) - (billedOf(a) ?? -1))
  else if (sort === 'context') copy.sort((a, b) => (b.timeline?.current.total ?? -1) - (a.timeline?.current.total ?? -1))
  else copy.sort((a, b) => b.updatedAt - a.updatedAt)
  return copy
}

/** session 网格每页渲染这么多张卡片。 */
export const OVERVIEW_PAGE_SIZE = 12

/** 把请求的页码夹进当前有效范围，渲染之间缩水的列表因此不会让视图失效。 */
export function pageOf<T>(rows: readonly T[], page: number): { items: T[]; index: number; count: number } {
  const count = Math.max(1, Math.ceil(rows.length / OVERVIEW_PAGE_SIZE))
  const index = Math.min(Math.max(0, page), count - 1)
  return { items: rows.slice(index * OVERVIEW_PAGE_SIZE, (index + 1) * OVERVIEW_PAGE_SIZE), index, count }
}

/** 某个技能在作用域内的统计：加载总次数、至少加载过它一次的
 *  session 行数，以及最新的加载时刻。 */
export interface SkillLoadStat {
  name: string
  loads: number
  /** 作用域内有多少 session 行（agent 家族）加载过它。 */
  sessions: number
  last: number
}

/** 技能卡片的排名键。 */
export type SkillSort = 'loads' | 'recent'

/** 作用域的账本日判定：热力图钉住某天时只接纳那一天，
 * 否则作用域窗口把自己的日子整体纳入。 */
function skillDayPredicate(opts: { scope: RangeWindow; day: string | null }): (key: string) => boolean {
  if (opts.day !== null) return key => key === opts.day
  const { start, end } = opts.scope
  const floor = start === null ? null : dayKeyOf(start)
  const ceiling = end === null ? null : dayKeyOf(end)
  return key => (floor === null || key >= floor) && (ceiling === null || key <= ceiling)
}

/** Insights 页技能卡片的数据：把作用域内每行的家族账本在被接纳的日子里
 * 按名逐项折叠——每个名字的加载次数、每行只记一次的加载者计数、
 * 最新的加载时刻。打平时按名字定序。 */
export function skillLoadsOf(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null; sort?: SkillSort },
): SkillLoadStat[] {
  const admit = skillDayPredicate(opts)
  const stats = new Map<string, SkillLoadStat>()
  for (const row of rows) {
    const days = row.activity?.days
    if (days === undefined) continue
    // 一行对某个名字只计一次加载者，无论它在多少个被接纳的日子里出现过该名字。
    const rowLoaded = new Set<string>()
    for (const key of Object.keys(days)) {
      if (!admit(key)) continue
      const skills = days[key].skills
      if (skills === undefined) continue
      for (const name of Object.keys(skills)) {
        const tally = skills[name]
        const prev = stats.get(name)
        if (prev === undefined) stats.set(name, { name, loads: tally.n, sessions: 1, last: tally.last })
        else {
          prev.loads += tally.n
          prev.last = Math.max(prev.last, tally.last)
          if (!rowLoaded.has(name)) prev.sessions += 1
        }
        rowLoaded.add(name)
      }
    }
  }
  // 名字在各行之间唯一（它们是映射的键），因此按名定序绝不会再次打平。
  const byName = (a: SkillLoadStat, b: SkillLoadStat): number => (a.name < b.name ? -1 : 1)
  const out = [...stats.values()]
  switch (opts.sort ?? 'loads') {
    case 'recent': return out.sort((a, b) => (b.last - a.last) || (b.loads - a.loads) || byName(a, b))
    default: return out.sort((a, b) => (b.loads - a.loads) || (b.last - a.last) || byName(a, b))
  }
}

/** 该行的家族账本是否在作用域内加载过指定技能——
 * 即技能卡片点击背后的下钻过滤器。 */
export function rowLoadedSkill(
  row: OverviewRow,
  name: string,
  opts: { scope: RangeWindow; day: string | null },
): boolean {
  const admit = skillDayPredicate(opts)
  const days = row.activity?.days
  if (days === undefined) return false
  for (const key of Object.keys(days)) {
    if (admit(key) && days[key].skills?.[name] !== undefined) return true
  }
  return false
}

/** 四个 provider 桶求和，外加总量。`input` 是**未缓存**输入，
 *  因此 `total` 是计费体量而不是 prompt 大小。 */
export interface UsageTotals {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
}

/** 对一份成本用量的各桶求和（各桶已在 timeline 边界处清洗过）。
 * 任何一方都没有桶记录时返回 null，调用方的单元格因此保留破折号而不是捏造一个零。 */
export function usageTotalsOf(usage: SessionCostUsage | null | undefined): UsageTotals | null {
  if (usage === null || usage === undefined) return null
  const totals: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = usage[provider]
    for (const model of Object.keys(models)) {
      const periods = models[model]
      for (const period of ['peak', 'off'] as const) {
        const bucket = periods[period]
        if (bucket === undefined) continue
        totals.input += bucket.uncached
        totals.cacheRead += bucket.cacheRead
        totals.cacheWrite += bucket.cacheWrite
        totals.output += bucket.output
        any = true
      }
    }
  }
  if (!any) return null
  totals.total = totals.input + totals.cacheRead + totals.cacheWrite + totals.output
  return totals
}

/** 该范围的时长总计，由各行 host 折叠出的整个 session 总计折叠而成，
 * 方式与 KPI 带折叠标量数字完全一致。可选可加字段只对自己
 * 的携带者求和，因此没有任何行携带的字段保持缺失，而不会实体化成零。 */
export function timingSumOf(rows: readonly OverviewRow[]): TimingTotals | null {
  let out: TimingTotals | null = null
  for (const row of rows) {
    const t = row.timeline?.timing
    if (t === undefined) continue
    if (out === null) {
      out = { ...t, tools: { ...t.tools } }
      continue
    }
    out.wallMs += t.wallMs
    out.ttftMs += t.ttftMs
    out.genMs += t.genMs
    out.calls += t.calls
    out.toolsMs += t.toolsMs
    out.toolCalls += t.toolCalls
    addOptionalOf(out, t, 'reasoningMs')
    addOptionalOf(out, t, 'reasoningBlocks')
    addOptionalOf(out, t, 'textMs')
    addOptionalOf(out, t, 'textBlocks')
    addOptionalOf(out, t, 'toolArgMs')
    addOptionalOf(out, t, 'toolArgBlocks')
    addOptionalOf(out, t, 'speedTokens')
    addOptionalOf(out, t, 'speedMs')
    for (const name of Object.keys(t.tools)) {
      const tool = t.tools[name]
      const outTools: Record<string, ToolTimingTotals | undefined> = out.tools
      const prev = outTools[name]
      out.tools[name] = prev === undefined ? { ...tool } : { calls: prev.calls + tool.calls, ms: prev.ms + tool.ms }
    }
  }
  return out
}

/** 一个可选可加时长字段的就地合并；两边都缺失就保持缺失，绝不materialize 一个 undefined。 */
function addOptionalOf(target: TimingTotals, source: TimingTotals, key: OptionalTimingKey): void {
  const a = target[key]
  const b = source[key]
  if (a !== undefined || b !== undefined) target[key] = (a ?? 0) + (b ?? 0)
}

type OptionalTimingKey = 'reasoningMs' | 'reasoningBlocks' | 'textMs' | 'textBlocks'
  | 'toolArgMs' | 'toolArgBlocks' | 'speedTokens' | 'speedMs'

/** 某条堆叠图的一段，已在家族作用域内求和，并按其来源的构成分段
 *  使用同样的键，图例与分段因此保持一致。 */
export interface TokenPartTotal {
  key: string
  color: string
  value: number
}

/** 该范围的计费 token 按分类拆分，跨各行的家族折叠：每个成员的
 * `billedParts` 按分类求和，而其各分段恰好合计它自己的计费数字，
 * 因此聚合总量仍等于精确的合并计费体量。没有计费时为 null；
 * 非有限的分段整段丢弃。 */
export function tokenPartsOf(rows: readonly OverviewRow[]): { parts: TokenPartTotal[]; total: number } | null {
  const sums = new Map<string, TokenPartTotal>()
  let total = 0
  let any = false
  for (const row of rows) {
    for (const member of row.family) {
      if (member === null) continue
      const totals = usageTotalsOf(member.cost)
      if (totals === null) continue
      any = true
      const usage: TokenUsage = {
        uncachedInputTokens: totals.input,
        cacheReadTokens: totals.cacheRead,
        cacheWriteTokens: totals.cacheWrite,
        outputTokens: totals.output,
      }
      for (const part of billedParts(member.current, null, usage)) {
        if (!Number.isFinite(part.value) || part.value <= 0) continue
        total += part.value
        const sumsGet: Map<string, TokenPartTotal | undefined> = sums
        const prev = sumsGet.get(part.key)
        sums.set(part.key, prev === undefined
          ? { key: part.key, color: part.color, value: part.value }
          : { ...prev, value: prev.value + part.value })
      }
    }
  }
  if (!any) return null
  return { parts: [...sums.values()], total }
}

/** 该范围的**具体**计费用量：provider 自己的四个桶（精确值，非估算）
 * 加上这些桶在每个 host 定价时段下折合的花费。 */
export interface BilledTotals {
  cacheRead: number
  uncached: number
  cacheWrite: number
  output: number
  total: number
  /** 每个 host 定价时段的美元金额，尚未换算为显示货币。 */
  cost: { peak: number; off: number; any: boolean }
  /** 按平台拆分的消费；空数组表示没有任何平台可定价。 */
  platforms: PlatformSpend[]
}

/** 严格按上报值折叠该范围的计费桶。与 {@link tokenPartsOf} 不同，
 * 后者把同一总量按上下文分类配比：这里是用以计算账单的
 * 计量数字。没有计费时为 null，
 * 卡片因此展示其空状态说明。 */
export function billedTotalsOf(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  credits?: Record<string, Record<string, number>> | null,
): BilledTotals | null {
  const usage = mergeCostUsage(...rows.map(row => row.familyCost))
  const totals = usageTotalsOf(usage)
  if (totals === null) return null
  // 跨会话按平台汇总：积分平台与人民币平台各自成行，口径与单会话卡片完全一致
  // （同一个 platformSpendsOf），因此两个页面不会对同一批数据给出不同的拆分。
  const platforms = mergePlatformSpends(...rows.map(row => platformSpendsOf(
    row.familyCost,
    row.familyCalls ?? null,
    book,
    null,
    credits ?? null,
  )))
  return {
    cacheRead: totals.cacheRead,
    uncached: totals.input,
    cacheWrite: totals.cacheWrite,
    output: totals.output,
    total: totals.total,
    cost: estimateSessionCostByPeriod(usage, book),
    platforms,
  }
}

/** 整条 KPI 带，每个渲染回合在作用域内的行上计算一次。各 `*Sessions`
 *  计数刻意按数字分别统计覆盖范围：有用量但无可用价目册的 session
 *  仍会贡献 token 与缓存命中两条子行。 */
export interface OverviewKpis {
  sessions: number
  listed: number
  tokens: number
  turns: number
  cost: number | null
  costSessions: number
  cacheHit: string | null
  usageSessions: number
  toolCalls: number
  toolsMs: number
  calls: number
  wallMs: number
  tokenParts: { parts: TokenPartTotal[]; total: number } | null
  /** 该范围的精确计费桶及其分时段花费；没有计费时为 null。 */
  billed: BilledTotals | null
  timing: TimingTotals | null
}

/** 用已受作用域限制的行构建 KPI 带。`listed` 需外部传入，因为它是
 *  **未过滤**的 session 总数——这条带要显示过滤器藏掉了多少。 */
export function kpisOf(
  rows: readonly OverviewRow[],
  listed: number,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): OverviewKpis {
  // 计费体量与花费与卡片、图表共用同一个家族作用域。
  const usage = mergeCostUsage(...rows.map(row => row.familyCost))
  const totals = usageTotalsOf(usage)
  let turns = 0
  let toolCalls = 0
  let toolsMs = 0
  let calls = 0
  let wallMs = 0
  let costSessions = 0
  let usageSessions = 0
  for (const row of rows) {
    // 每条子行只统计自己那个数字覆盖的 session：有用量但无价目册费率的 session 仍会计入缓存命中率。
    if (estimateSessionCost(row.familyCost, book, currency) !== null) costSessions++
    if (usageTotalsOf(row.familyCost) !== null) usageSessions++
    turns += turnsOf(row.timeline)
    const timing = row.timeline?.timing
    toolCalls += timing?.toolCalls ?? 0
    toolsMs += timing?.toolsMs ?? 0
    calls += timing?.calls ?? 0
    wallMs += timing?.wallMs ?? 0
  }
  return {
    sessions: rows.length,
    listed,
    tokens: totals?.total ?? 0,
    turns,
    cost: estimateSessionCost(usage, book, currency),
    costSessions,
    cacheHit: totals === null ? null : cacheHitPercent(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite),
    usageSessions,
    toolCalls,
    toolsMs,
    calls,
    wallMs,
    tokenParts: tokenPartsOf(rows),
    billed: billedTotalsOf(rows, book),
    timing: timingSumOf(rows),
  }
}

/** 热力图与用量图所需的某日合并数字；该日没有定价出任何东西时
 *  （无记录、无价目册，或只有未定价的模型），`cost` 为 null 而非 0，
 *  图表因此可以留出空档，而不是画出一个假的低谷。 */
export interface DayTotals {
  tokens: number
  requests: number
  sessions: number
  /** 该日估算花费；未能定价时为 null——没有计价记录、没有价目册，或没有已定价的模型。 */
  cost: number | null
}

/** 把所有行的按日账本合并成一份——即热力图与用量图的数据。
 * 只有家族条目确实带活动的那一天才计入，与日期过滤保持一致，
 * 且用与 KPI 带相同的价目册和估算器定价。 */
/** `sessions` 统计的是为那天贡献了活动的行数，而不是那天横跨的
 *  session 数，因此某天的三个数字取自同一组一致的行。 */
export function aggregateDays(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): Record<string, DayTotals> {
  const merged: Record<string, { tokens: number; requests: number; sessions: number; fees: SessionCostUsage[] }> = {}
  const byKey: Record<string, { tokens: number; requests: number; sessions: number; fees: SessionCostUsage[] } | undefined> = merged
  for (const row of rows) {
    if (row.activity === null) continue
    for (const key of Object.keys(row.activity.days)) {
      const entry = row.activity.days[key]
      if (entry.tokens <= 0 && entry.requests <= 0) continue
      const prev = byKey[key]
      if (prev === undefined) {
        merged[key] = {
          tokens: entry.tokens,
          requests: entry.requests,
          sessions: 1,
          fees: entry.cost !== undefined ? [entry.cost] : [],
        }
      } else {
        prev.tokens += entry.tokens
        prev.requests += entry.requests
        prev.sessions++
        if (entry.cost !== undefined) prev.fees.push(entry.cost)
      }
    }
  }
  const days: Record<string, DayTotals> = {}
  for (const [key, day] of Object.entries(merged)) {
    // 没有费用记录，或记录没有价目册能为它定价，两种情况下合并出的费用都是 null。
    days[key] = {
      tokens: day.tokens,
      requests: day.requests,
      sessions: day.sessions,
      cost: estimateSessionCost(mergeCostUsage(...day.fees), book, currency),
    }
  }
  return days
}

/** 重新拉取 session 列表基线，使 host 侧的投影回填
 * （host/backfill.ts）能到达长时间保持连接的浏览器；失败被吞掉，面板用已有的行照常渲染。 */
export function refreshSessions(ctx: ClientCtx): void {
  try {
    const sessions = ctx.get('sessions') as SessionsFace | undefined
    // `refresh` 是可选的：较旧 host 的面孔能列出 session，却无法重新拉取。
    if (sessions === undefined || typeof sessions.refresh !== 'function') return
    // Promise.resolve 吸收非 promise 的返回值；rejection 被吞掉。
    void Promise.resolve(sessions.refresh()).catch(() => { /* 重新拉取失败就继续用旧行 */ })
  } catch { /* 服务不可信——不刷新 */ }
}

// 插件的预热触发路由（host/backfill.ts），在此重新声明：客户端
// bundle 会内联每个 import，而 host 模块绝不能进到这里。
const BACKFILL_ROUTE = '/api/dsh-cost-breakdown/backfill'

/** 唤醒 host 的投影预热（host/backfill.ts）：本页是这些行的唯一
 * 读取者，因此 host 把全语料库的冷读推迟到该界面首次打开时
 * （每个 host 进程一趟）。 */
export function requestActivityBackfill(): void {
  try {
    void fetch(BACKFILL_ROUTE, { method: 'POST' }).catch(() => { /* 这些行会在之后某次打开时到达 */ })
  } catch { /* 传输不可信——面板继续用已有的行 */ }
}

/** 该行的相对活动标签（「3m ago」），按单位逐级降档。未来或
 * 非法的时刻读作「just now」（时钟偏移不算值得显示破折号的错误）。
 *
 * 用一条共用的单位阶梯而不是 `Intl.RelativeTimeFormat`：标签紧凑，
 * 形态上与本 locale 无关，只有单位词来自字典。 */
export function relativeTime(t: (key: string, params?: Record<string, string | number>) => string, updatedAt: number, now: number): string {
  const diff = now - updatedAt
  if (!Number.isFinite(diff) || diff < 60_000) return t('ov.time.now')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('ov.time.m', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('ov.time.h', { n: hours })
  return t('ov.time.d', { n: Math.floor(hours / 24) })
}
