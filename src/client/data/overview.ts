/**
 * Cross-session aggregation for the Insights page.
 *
 * Everything here is derived from the root session-list snapshot and each row's projections; no
 * session log is ever opened. The two hard problems this module owns:
 *
 *   1. **Sub-agent folding.** A session row represents its whole descendant family, not just itself:
 *      spend, calls and the activity ledger are summed down the `parentId` tree. Rows that are
 *      themselves sub-agents are therefore not listed separately.
 *   2. **"Unavailable" vs "empty".** The session list is a snapshot that can arrive late; an absent
 *      list is `null`, a present-but-empty one is `[]`. The page renders a different state for each,
 *      so the distinction is carried all the way through.
 */

import type {
  ActivityLedger, CallLedger, CostLedger, LedgerDay, Snapshot,
} from '../../wire/model'
import { mergeActivity } from '../../core/day'
import { mergeCalls, mergeLedgers } from './cost'

/** One row of the Insights list: a session plus its folded family. */
export interface OverviewRow {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  /** The session's own live token snapshot, when its projection is mounted. */
  timeline: Snapshot | null
  /** This session's own daily ledger. */
  activity: ActivityLedger | null
  /** Descendant session ids folded into this row (not including itself). */
  family: string[]
  /** Spend and calls summed over the family (null when nothing carried a bucket). */
  familyCost: CostLedger | null
  familyCalls: CallLedger | null
  /** Activity summed over the family. */
  familyActivity: ActivityLedger | null
}

/** The shapes this module reads off the session-list snapshot. */
interface SessionRowLike {
  id?: unknown
  title?: unknown
  displayTitle?: unknown
  cwd?: unknown
  updatedAt?: unknown
  running?: unknown
  current?: unknown
  blank?: unknown
  origin?: unknown
  parentId?: unknown
  projectionValues?: unknown
}

/** Read the session-list snapshot's rows, or `null` when the list itself is unavailable. */
function rowsFrom(snapshot: unknown): SessionRowLike[] | null {
  const record = snapshot !== null && typeof snapshot === 'object' ? snapshot as Record<string, unknown> : null
  if (record === null) return null
  const rows = record.rows
  if (Array.isArray(rows)) return rows as SessionRowLike[]
  const byId = record.byId
  if (byId !== null && typeof byId === 'object') return Object.values(byId as Record<string, SessionRowLike>)
  return null
}

/** The projection value a row carries, by key. The snapshot may expose them inline or under
 * `projectionValues`; both shapes are read because harness versions differ. */
function projectionOn(row: SessionRowLike, key: string): unknown {
  const direct = (row as Record<string, unknown>)[key]
  if (direct !== undefined) return direct
  const values = row.projectionValues
  return values !== null && typeof values === 'object' ? (values as Record<string, unknown>)[key] : undefined
}

/**
 * Build the list rows from the session-list snapshot.
 *
 * Returns `null` when the snapshot is unavailable (the page shows its loading/absent state) and `[]`
 * when it is genuinely empty. A row that throws while being read loses only itself.
 */
export function rowsOfSnapshot(snapshot: unknown, washTimeline: (value: unknown) => Snapshot | null, washActivity: (value: unknown) => ActivityLedger | null): OverviewRow[] | null {
  const sourceRows = rowsFrom(snapshot)
  if (sourceRows === null) return null
  const archived = new Set<string>()
  const record = snapshot as Record<string, unknown>
  if (Array.isArray(record.archivedSessionIds)) {
    for (const id of record.archivedSessionIds) if (typeof id === 'string') archived.add(id)
  }
  const rows: OverviewRow[] = []
  for (const row of sourceRows) {
    try {
      const id = row.id
      if (typeof id !== 'string' || id === '') continue
      if (archived.has(id)) continue
      // A blank row is a placeholder the host has not materialised yet; a sub-agent row is folded into
      // its parent, which is listed instead.
      if (row.blank === true) continue
      if (row.origin === 'subagent') continue
      const title = typeof row.title === 'string' && row.title !== ''
        ? row.title
        : typeof row.displayTitle === 'string' ? row.displayTitle : id
      rows.push({
        id,
        title,
        ...(typeof row.cwd === 'string' && row.cwd !== '' ? { cwd: row.cwd } : {}),
        updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
        running: row.running === true,
        timeline: washTimeline(projectionOn(row, 'contextTimeline')),
        activity: washActivity(projectionOn(row, 'contextActivity')),
        family: [],
        familyCost: null,
        familyCalls: null,
        familyActivity: null,
      })
    } catch {
      // A throwing row loses only itself.
    }
  }
  // Fold every row's descendant subtree. One pass over the parent map is enough: the tree is shallow
  // (a session has one parent) and children are grouped first.
  const childrenOf = new Map<string, string[]>()
  for (const row of sourceRows) {
    const parentId = row.parentId
    const id = row.id
    if (typeof parentId !== 'string' || parentId === '' || typeof id !== 'string' || id === '') continue
    const list = childrenOf.get(parentId) ?? []
    list.push(id)
    childrenOf.set(parentId, list)
  }
  const byId = new Map(rows.map(row => [row.id, row]))
  for (const row of rows) {
    const seen = new Set<string>([row.id])
    const queue = [...(childrenOf.get(row.id) ?? [])]
    const family: string[] = []
    let cost: CostLedger | null = null
    let calls: CallLedger | null = null
    let activity: ActivityLedger | null = null
    while (queue.length > 0) {
      const id = queue.shift() as string
      // Cycle-safe: a corrupted parent chain must not loop forever.
      if (seen.has(id)) continue
      seen.add(id)
      family.push(id)
      const child = byId.get(id)
      if (child !== undefined) {
        cost = mergeLedgers(cost, child.timeline?.cost ?? null)
        calls = mergeCalls(calls, child.timeline?.calls ?? null)
        activity = mergeActivity(activity, child.activity)
      }
      for (const grandchild of childrenOf.get(id) ?? []) queue.push(grandchild)
    }
    row.family = family
    // The row's own figures are included in the family totals the cards read.
    row.familyCost = mergeLedgers(cost, row.timeline?.cost ?? null)
    row.familyCalls = mergeCalls(calls, row.timeline?.calls ?? null)
    row.familyActivity = mergeActivity(activity, row.activity)
  }
  return rows
}

/** Sum two ledger days, exported for the day-level aggregate. */
export function mergeDayRows(left: LedgerDay, right: LedgerDay): LedgerDay {
  return {
    tokens: left.tokens + right.tokens,
    requests: left.requests + right.requests,
  }
}
