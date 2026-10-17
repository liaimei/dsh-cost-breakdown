/**
 * Cross-session aggregation for the Insights page.
 *
 * Two hard problems live here, and both have burned a previous implementation:
 *
 *   1. **Currency units are not additive.** A DeepSeek figure is CNY per token, a third-party figure is
 *      USD per token, a credit platform bills per request. Nothing in this module ever sums across
 *      those units; where a total is unavoidable (the KPI cost figure) it is explicitly restricted to
 *      money-priceable providers.
 *   2. **"Unavailable" is not "empty".** An absent session list (`null`), a list with no rows (`[]`)
 *      and a filter that matched nothing are three different states, and the page words them
 *      differently.
 *
 * Everything is derived from each row's projections; no session log is opened.
 */

import type { CostLedger, CreditRateTable, Snapshot, TimingTotals } from '../../wire/model'
import type { Translate } from '../i18n/dict'
import { dayKeyOf, shiftDayKey, startOfDay, endOfDay } from '../../core/day'
import type { OverviewRow } from './overview'
import {
  billedTokens, estimateByBucket, estimateSessionCost, mergeCalls, mergeLedgers, moneyOnly,
  type Currency, type PriceBook,
} from './cost'
import { platformSpendsOf, type PlatformSpend } from './platformSpend'
import { mergeCreditRates } from '../../core/credits'
import type { ThirdPartyRates } from './thirdPartyRates'
import type { ClientContext } from '../shell/contracts'
import { serviceOf } from '../shell/contracts'

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/** The four rolling presets. */
export type OverviewRange = 'today' | '7d' | '30d' | 'all'

/** A time window with inclusive bounds; `null` means unbounded on that side. */
export interface RangeWindow {
  start: number | null
  end: number | null
}

/** A calendar range as day keys, inclusive on both ends. */
export interface DayRange {
  from: string
  to: string
}

const DAY_MS = 86_400_000

/**
 * The window of a preset, computed against `now`.
 *
 * Presets are **rolling**, not calendar-aligned: `7d` means the last seven days, which is what a
 * reader expects from a dashboard. Only `today` does calendar arithmetic (`setHours(0,0,0,0)`), so a
 * DST day stays exactly one local day.
 */
export function rangeWindowOf(range: OverviewRange, now: number): RangeWindow {
  if (range === 'all') return { start: null, end: null }
  if (range === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return { start: start.getTime(), end: now }
  }
  const days = range === '7d' ? 7 : 30
  return { start: now - days * DAY_MS, end: now }
}

/** A window as a calendar range, or `null` when either bound is unbounded. */
export function dayKeyRange(window: RangeWindow): DayRange | null {
  if (window.start === null || window.end === null) return null
  const from = dayKeyOf(window.start)
  const to = dayKeyOf(window.end)
  return from === null || to === null ? null : { from, to }
}

/** A picked calendar range as a window: local midnight of the first day to the last millisecond of the
 * last day. A malformed key yields `null` so the caller keeps its preset. */
export function windowOfDayRange(range: DayRange): RangeWindow | null {
  const start = startOfDay(range.from)
  const end = endOfDay(range.to)
  if (start === null || end === null) return null
  return { start, end }
}

/** The day keys a window covers, newest last. `count` bounds an unbounded window (the chart's width). */
export function daysOfWindow(window: RangeWindow, now: number, count: number): string[] {
  const endKey = dayKeyOf(window.end ?? now)
  if (endKey === null) return []
  const days: string[] = []
  for (let back = count - 1; back >= 0; back--) {
    const key = shiftDayKey(endKey, -back)
    if (key !== null) days.push(key)
  }
  return days
}

// ---------------------------------------------------------------------------
// Filtering, sorting, paging
// ---------------------------------------------------------------------------

/** Everything a filter can pin. `day` and `skill` are one-shot pins; `query` is free text. */
export interface RowFilter {
  window: RangeWindow
  day: string | null
  query: string
  skill?: string | null
}

/** Whether a row was updated inside the window. */
function inWindow(row: OverviewRow, window: RangeWindow): boolean {
  if (window.start !== null && row.updatedAt < window.start) return false
  if (window.end !== null && row.updatedAt > window.end) return false
  return true
}

/** Whether a row shows real activity on a given day. A day pin exists to surface sessions that actually
 * did something, so a day with no tokens and no requests does not match. */
function activeOnDay(row: OverviewRow, day: string): boolean {
  const entry = row.familyActivity?.days[day]
  return entry !== undefined && (entry.tokens > 0 || entry.requests > 0)
}

/** Apply the window, the day pin, the skill pin and the free-text query. */
export function filterRows(rows: OverviewRow[], filter: RowFilter): OverviewRow[] {
  const needle = filter.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (!inWindow(row, filter.window)) return false
    if (filter.day !== null && !activeOnDay(row, filter.day)) return false
    if (filter.skill !== undefined && filter.skill !== null && !rowLoadedSkill(row, filter.skill)) return false
    if (needle !== '') {
      const haystack = `${row.title} ${row.cwd ?? ''} ${row.timeline?.lastUser ?? ''}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

/** The list orderings. All descending; a missing number sorts as `-1`, so an unpriced session never
 * outranks a genuinely cheap one. */
export type OverviewSort = 'recent' | 'tokens' | 'context'

/** The billed token total of a row's family, or `-1` when unknown. */
function tokenOrder(row: OverviewRow): number {
  const total = billedTokens(row.familyCost)
  return total > 0 ? total : -1
}

/** The context size of a row, or `-1` when unknown. */
function contextOrder(row: OverviewRow): number {
  const context = row.timeline?.current.total
  return typeof context === 'number' && context > 0 ? context : -1
}

/** Sort a row list by the chosen key, newest/cheapest-last. */
export function sortRows(rows: OverviewRow[], sort: OverviewSort): OverviewRow[] {
  const sorted = [...rows]
  if (sort === 'tokens') sorted.sort((left, right) => tokenOrder(right) - tokenOrder(left))
  else if (sort === 'context') sorted.sort((left, right) => contextOrder(right) - contextOrder(left))
  else sorted.sort((left, right) => right.updatedAt - left.updatedAt)
  return sorted
}

/** Rows per page in the session grid. */
export const OVERVIEW_PAGE_SIZE = 12

/** One page of rows. The index is clamped into range, so a filter change can never leave the pager on a
 * page that no longer exists. */
export function pageOf(rows: OverviewRow[], page: number): { rows: OverviewRow[]; index: number; count: number } {
  const count = Math.max(1, Math.ceil(rows.length / OVERVIEW_PAGE_SIZE))
  const index = Math.min(Math.max(0, Math.trunc(page)), count - 1)
  return { rows: rows.slice(index * OVERVIEW_PAGE_SIZE, (index + 1) * OVERVIEW_PAGE_SIZE), index, count }
}

// ---------------------------------------------------------------------------
// Workspace grouping
// ---------------------------------------------------------------------------

/** The bucket for sessions no workspace claims. */
export const UNGROUPED_KEY = '__ungrouped__'

interface WorkspaceLike {
  path?: unknown
  title?: unknown
  sessionIds?: unknown
}

/** The workspace titles and memberships a group chip reads. */
function workspacesOf(snapshot: unknown): WorkspaceLike[] {
  if (snapshot === null || typeof snapshot !== 'object') return []
  const items = (snapshot as { items?: unknown }).items
  return Array.isArray(items) ? items as WorkspaceLike[] : []
}

/** A stable key for a workspace: its path, or its title when the path is absent. */
function workspaceKey(workspace: WorkspaceLike): string {
  if (typeof workspace.path === 'string' && workspace.path !== '') return workspace.path
  return typeof workspace.title === 'string' ? workspace.title : ''
}

/** Session id → the workspace key that claims it. */
export function sessionGroupsOf(rows: OverviewRow[], workspaces: unknown): Map<string, string> {
  const groups = new Map<string, string>()
  for (const workspace of workspacesOf(workspaces)) {
    const key = workspaceKey(workspace)
    if (key === '') continue
    if (!Array.isArray(workspace.sessionIds)) continue
    for (const id of workspace.sessionIds) {
      if (typeof id === 'string') groups.set(id, key)
    }
  }
  // A row whose own cwd matches a workspace path belongs to it even if the membership list is stale.
  const paths = new Set(workspacesOf(workspaces).map(workspaceKey).filter(key => key !== ''))
  for (const row of rows) {
    if (groups.has(row.id)) continue
    if (row.cwd !== undefined && paths.has(row.cwd)) groups.set(row.id, row.cwd)
  }
  return groups
}

/** A group chip: a workspace key and how many of the scoped rows it claims. */
export interface GroupCount {
  key: string
  count: number
}

/** Group chips for the scoped rows, in workspace registry order, with the ungrouped bucket last. */
export function groupCountsOf(rows: OverviewRow[], workspaces: unknown): GroupCount[] {
  const membership = sessionGroupsOf(rows, workspaces)
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = membership.get(row.id) ?? UNGROUPED_KEY
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const order: string[] = []
  for (const workspace of workspacesOf(workspaces)) {
    const key = workspaceKey(workspace)
    if (key !== '' && counts.has(key) && !order.includes(key)) order.push(key)
  }
  const out: GroupCount[] = order.map(key => ({ key, count: counts.get(key) ?? 0 }))
  if (counts.has(UNGROUPED_KEY)) out.push({ key: UNGROUPED_KEY, count: counts.get(UNGROUPED_KEY) ?? 0 })
  return out
}

/** Whether a row belongs to a group chip. */
export function inGroup(row: OverviewRow, groupKey: string, workspaces: unknown): boolean {
  const key = sessionGroupsOf([row], workspaces).get(row.id) ?? UNGROUPED_KEY
  return key === groupKey
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** The skills card orderings. `loads` and `recent` swap the first two. */
export type SkillSort = 'loads' | 'recent' | 'last' | 'name'

/** One skill's usage across the scoped rows. */
export interface SkillLoadStat {
  name: string
  loads: number
  /** How many rows loaded it — counted once per row, not once per load. */
  sessions: number
  /** Newest load instant. */
  last: number
}

/** Whether a row loaded a given skill (its own ledger or any family member's). */
export function rowLoadedSkill(row: OverviewRow, skill: string): boolean {
  const days = row.familyActivity?.days
  if (days === undefined) return false
  for (const day of Object.values(days)) {
    if (day.skills !== undefined && day.skills[skill] !== undefined) return true
  }
  return false
}

/** Aggregate skill loads over the scoped rows, in the requested order. */
export function skillLoadsOf(rows: OverviewRow[], filter: { window: RangeWindow; day: string | null; sort: SkillSort }): SkillLoadStat[] {
  const byName = new Map<string, SkillLoadStat>()
  for (const row of rows) {
    if (!inWindow(row, filter.window)) continue
    const days = row.familyActivity?.days ?? {}
    const loaded = new Set<string>()
    for (const [day, entry] of Object.entries(days)) {
      if (filter.day !== null && day !== filter.day) continue
      for (const [name, tally] of Object.entries(entry.skills ?? {})) {
        const current = byName.get(name) ?? { name, loads: 0, sessions: 0, last: 0 }
        current.loads += tally.n
        current.last = Math.max(current.last, tally.last)
        byName.set(name, current)
        loaded.add(name)
      }
    }
    for (const name of loaded) {
      const stat = byName.get(name)
      if (stat !== undefined) stat.sessions += 1
    }
  }
  const stats = [...byName.values()]
  const byNameThen = (left: SkillLoadStat, right: SkillLoadStat): number => left.name.localeCompare(right.name)
  if (filter.sort === 'name') stats.sort(byNameThen)
  else if (filter.sort === 'last') stats.sort((left, right) => right.last - left.last || byNameThen(left, right))
  else if (filter.sort === 'recent') stats.sort((left, right) => right.last - left.last || right.loads - left.loads || byNameThen(left, right))
  else stats.sort((left, right) => right.loads - left.loads || right.last - left.last || byNameThen(left, right))
  return stats
}

// ---------------------------------------------------------------------------
// Token and cost totals
// ---------------------------------------------------------------------------

/** The four billed buckets plus their sum. */
export interface UsageTotals {
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
  any: boolean
}

/** Sum the billed buckets across every provider and period. `null` when no bucket exists at all — which
 * stays distinct from a genuine zero. */
export function usageTotalsOf(ledger: CostLedger | null | undefined): UsageTotals | null {
  if (ledger === null || ledger === undefined) return null
  let any = false
  const totals: UsageTotals = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, any: false }
  for (const provider of Object.keys(ledger)) {
    const models = ledger[provider]
    if (models === null || typeof models !== 'object') continue
    for (const model of Object.keys(models)) {
      const entry = models[model]
      if (entry === null || typeof entry !== 'object') continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = entry[period]
        if (bucket === undefined || bucket === null) continue
        totals.uncached += bucket.uncached
        totals.cacheRead += bucket.cacheRead
        totals.cacheWrite += bucket.cacheWrite
        totals.output += bucket.output
        any = true
      }
    }
  }
  if (!any) return null
  totals.total = totals.uncached + totals.cacheRead + totals.cacheWrite + totals.output
  totals.any = true
  return totals
}

/** The stages a token card breaks down, in draw order. */
export const STAGE_ORDER = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'] as const

/** One stage's token total. */
export interface TokenPartTotal {
  key: typeof STAGE_ORDER[number]
  tokens: number
}

/** Per-stage token totals across the scoped rows, from each row's live context composition. */
export function tokenPartsOf(rows: OverviewRow[]): TokenPartTotal[] {
  const sums: Record<string, number> = {}
  for (const key of STAGE_ORDER) sums[key] = 0
  for (const row of rows) {
    const current = row.timeline?.current
    if (current === undefined) continue
    for (const key of STAGE_ORDER) {
      const value = current[key]
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) sums[key] += value
    }
  }
  return STAGE_ORDER.map(key => ({ key, tokens: sums[key] }))
}

/** The cost block: billed tokens, the bucket split, and per-platform rows. */
export interface BilledTotals {
  tokens: UsageTotals
  costByBucket: ReturnType<typeof estimateByBucket>
  platforms: PlatformSpend[]
}

/** Merge the scoped rows' ledgers and price them once. Credit providers are excluded from the money
 * block, and each platform keeps its own currency. */
export function billedTotalsOf(
  rows: OverviewRow[],
  book: PriceBook | null,
  credits: CreditRateTable | null,
  moneyRates: ThirdPartyRates | null,
): BilledTotals {
  const ledger = mergeLedgers(...rows.map(row => row.familyCost))
  const calls = mergeCalls(...rows.map(row => row.familyCalls))
  const tokens = usageTotalsOf(ledger) ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, any: false }
  const costByBucket = estimateByBucket(ledger, book, moneyRates)
  const platforms = platformSpendsOf(ledger, calls, book, moneyRates, credits)
  return { tokens, costByBucket, platforms }
}

/** The KPI band's figures. */
export interface OverviewKpis {
  /** Rows matching the window. */
  sessions: number
  /** Rows the list holds in total (the sub-line's denominator). */
  listed: number
  tokens: number
  turns: number
  /** Cache-hit percentage; `null` when no prompt was billed. */
  cacheHit: number | null
  usageSessions: number
  toolCalls: number
  toolsMs: number
  wallMs: number
  calls: number
  /** Rows whose money cost could be priced. */
  costSessions: number
  billed: BilledTotals | null
  tokenParts: TokenPartTotal[]
  timing: TimingTotals | null
}

/** Sum timing totals strictly additively: an optional scalar is only added when at least one side
 * carries it, so its absence stays visible. */
export function timingSumOf(rows: OverviewRow[]): TimingTotals | null {
  let any = false
  const tools: Record<string, { calls: number; ms: number }> = {}
  const sum: TimingTotals = {
    wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools,
  }
  const optional = ['reasoningMs', 'reasoningBlocks', 'textMs', 'textBlocks', 'toolArgMs', 'toolArgBlocks'] as const
  const carried: Record<string, boolean> = {}
  for (const row of rows) {
    const timing = row.timeline?.timing
    if (timing === undefined) continue
    any = true
    sum.wallMs += timing.wallMs
    sum.ttftMs += timing.ttftMs
    sum.genMs += timing.genMs
    sum.calls += timing.calls
    sum.toolsMs += timing.toolsMs
    sum.toolCalls += timing.toolCalls
    for (const key of optional) {
      const value = timing[key]
      if (value === undefined) continue
      carried[key] = true
      ;(sum as unknown as Record<string, number>)[key] = ((sum as unknown as Record<string, number>)[key] ?? 0) + value
    }
    for (const name of Object.keys(timing.tools)) {
      const tool = tools[name] ?? { calls: 0, ms: 0 }
      tool.calls += timing.tools[name].calls
      tool.ms += timing.tools[name].ms
      tools[name] = tool
    }
  }
  if (!any) return null
  for (const key of optional) if (!carried[key]) delete (sum as unknown as Record<string, unknown>)[key]
  return sum
}

/** Every credit rate table in the scoped rows, first writer winning so a merged figure cannot change. */
export function mergeCreditRatesAll(rows: OverviewRow[]): CreditRateTable | null {
  let merged: CreditRateTable | null = null
  for (const row of rows) merged = mergeCreditRates(merged, row.timeline?.creditRates ?? null)
  return merged
}

/** The KPI figures for the windowed rows. */
export function kpisOf(
  rows: OverviewRow[],
  listed: number,
  book: PriceBook | null,
  credits: CreditRateTable | null,
  moneyRates: ThirdPartyRates | null,
  currency: Currency,
): OverviewKpis {
  const ledger = mergeLedgers(...rows.map(row => row.familyCost))
  const billed = billedTotalsOf(rows, book, credits, moneyRates)
  const tokens = usageTotalsOf(ledger)
  let usageSessions = 0
  let costSessions = 0
  let turns = 0
  let toolCalls = 0
  let toolsMs = 0
  let wallMs = 0
  let calls = 0
  let cacheReads = 0
  let prompts = 0
  for (const row of rows) {
    const usage = usageTotalsOf(row.familyCost)
    if (usage !== null) usageSessions++
    // The cost coverage split is deliberate: a row with usage but no price still feeds the token and
    // cache lines, only the cost line ignores it.
    if (estimateSessionCost(moneyOnly(row.familyCost, credits), book, currency) !== null) costSessions++
    turns += row.timeline?.counts?.turns ?? 0
    toolCalls += row.timeline?.timing?.toolCalls ?? 0
    toolsMs += row.timeline?.timing?.toolsMs ?? 0
    wallMs += row.timeline?.timing?.wallMs ?? 0
    calls += ledgerCallsOf(row.timeline)
    for (const models of Object.values(row.familyCost ?? {})) {
      for (const entry of Object.values(models)) {
        for (const period of ['peak', 'off'] as const) {
          const bucket = entry[period]
          if (bucket === undefined) continue
          cacheReads += bucket.cacheRead
          prompts += bucket.cacheRead + bucket.uncached + bucket.cacheWrite
        }
      }
    }
  }
  return {
    sessions: rows.length,
    listed,
    tokens: tokens?.total ?? 0,
    turns,
    cacheHit: prompts > 0 ? Math.round((cacheReads / prompts) * 100) : null,
    usageSessions,
    toolCalls,
    toolsMs,
    wallMs,
    calls,
    costSessions,
    billed,
    tokenParts: tokenPartsOf(rows),
    timing: timingSumOf(rows),
  }
}

/** Request count of one row, from its call ledger. */
function ledgerCallsOf(timeline: Snapshot | null): number {
  const calls = timeline?.calls
  if (calls === undefined) return 0
  let total = 0
  for (const models of Object.values(calls)) {
    for (const count of Object.values(models)) total += count
  }
  return total
}

/** One day's figures for the 7-day columns; `cost` is `null` when that day could not be priced, so the
 * chart leaves a gap rather than drawing a fake trough. */
export interface DayTotals {
  day: string
  tokens: number
  requests: number
  sessions: number
  cost: number | null
}

/** Daily totals over the last `count` days. */
export function aggregateDays(
  rows: OverviewRow[],
  book: PriceBook | null,
  credits: CreditRateTable | null,
  moneyRates: ThirdPartyRates | null,
  currency: Currency,
  now: number,
  count: number,
): DayTotals[] {
  const window = rangeWindowOf('today', now)
  const days = daysOfWindow({ start: (window.start ?? now) - (count - 1) * DAY_MS, end: now }, now, count)
  const byDay = new Map<string, DayTotals>()
  for (const day of days) byDay.set(day, { day, tokens: 0, requests: 0, sessions: 0, cost: null })
  const costLedgerByDay = new Map<string, CostLedger>()
  for (const row of rows) {
    const ledgerDays = row.familyActivity?.days ?? {}
    for (const [day, entry] of Object.entries(ledgerDays)) {
      const target = byDay.get(day)
      if (target === undefined) continue
      target.tokens += entry.tokens
      target.requests += entry.requests
      if (entry.tokens > 0 || entry.requests > 0) target.sessions += 1
      if (entry.cost !== undefined) {
        costLedgerByDay.set(day, mergeLedgers(costLedgerByDay.get(day) ?? null, entry.cost) ?? entry.cost)
      }
    }
  }
  for (const [day, ledger] of costLedgerByDay) {
    const target = byDay.get(day)
    if (target === undefined) continue
    const money = moneyOnly(ledger, credits)
    const price = estimateSessionCost(money, book, currency)
    target.cost = price
  }
  return days.map(day => byDay.get(day) as DayTotals)
}

/** The billed token total of a row's family; `null` when there is no bucket to report. */
export function billedOf(row: OverviewRow): number | null {
  const usage = usageTotalsOf(row.familyCost)
  return usage === null ? null : usage.total
}

/** The turns a row's own timeline reports. */
export function turnsOf(row: OverviewRow): number {
  return row.timeline?.counts?.turns ?? 0
}

/** The earliest day key in a row's family ledger (the list rows carry no created timestamp). */
export function createdDayOf(row: OverviewRow): string | null {
  const days = row.familyActivity?.days
  if (days === undefined) return null
  let earliest: string | null = null
  for (const day of Object.keys(days)) {
    if (earliest === null || day < earliest) earliest = day
  }
  return earliest
}

/** A relative time string through the plugin's own dictionaries. */
export function relativeTime(time: number, now: number, t: Translate): string {
  const delta = now - time
  if (!Number.isFinite(delta) || delta < 60_000) return t('ov.time.now')
  if (delta < 3_600_000) return t('ov.time.m', { n: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('ov.time.h', { n: Math.floor(delta / 3_600_000) })
  return t('ov.time.d', { n: Math.floor(delta / 86_400_000) })
}

/** Re-fetch the session-list baseline so backfilled rows reach a long-lived page. */
export async function refreshSessions(ctx: ClientContext): Promise<void> {
  const sessions = serviceOf<{ refresh?(): Promise<unknown> }>(ctx, 'sessions')
  try {
    await sessions?.refresh?.()
  } catch {
    // A refresh failure only delays the new rows; the page keeps what it has.
  }
}

/** Ask the host to prewarm the corpus behind the Insights page. Fire-and-forget. */
export function requestActivityBackfill(): void {
  void fetch('/api/dsh-cost-breakdown/backfill', { method: 'POST' }).catch(() => {
    // Best effort: the page renders from whatever has already been folded.
  })
}

/** The four rolling presets, in display order. */
export const OVERVIEW_RANGES: readonly OverviewRange[] = ['today', '7d', '30d', 'all']
