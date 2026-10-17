/**
 * The session-list reader behind the statistics page: which rows count, how the descendant family folds,
 * and the difference between "no list" and "empty list".
 */

import { describe, expect, it } from 'vitest'
import { rowsOfSnapshot, type OverviewRow } from '../../src/client/data/overview'
import { activityOf, snapshotOf } from '../../src/client/shell/washers'

/** A session-list row. */
function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: id, updatedAt: 1, running: false, ...overrides }
}

/** Run the reader over a fake snapshot. */
function read(snapshot: unknown): OverviewRow[] | null {
  return rowsOfSnapshot(snapshot, snapshotOf, activityOf)
}

describe('rowsOfSnapshot', () => {
  it('distinguishes an unavailable list from an empty one', () => {
    expect(read(undefined)).toBeNull()
    // A snapshot without a row collection cannot be read as a list.
    expect(read({})).toBeNull()
    expect(read({ rows: [] })).toEqual([])
  })

  it('drops blank, subagent-origin and archived rows', () => {
    const rows = read({
      rows: [
        row('keep'),
        row('blank', { blank: true }),
        row('sub', { origin: 'subagent' }),
        row('archived'),
      ],
      archivedSessionIds: ['archived'],
    })
    expect(rows?.map(entry => entry.id)).toEqual(['keep'])
  })

  it('folds a descendant family into its root row', () => {
    const rows = read({
      rows: [
        row('root', {
          contextTimeline: {
            ok: true,
            current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
            requests: [], events: [], nodes: [], archive: [], droppedNodes: 0,
            cost: { p: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
          },
        }),
        row('child', {
          parentId: 'root',
          contextTimeline: {
            ok: true,
            current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
            requests: [], events: [], nodes: [], archive: [], droppedNodes: 0,
            cost: { p: { m: { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
          },
        }),
      ],
    })
    const root = rows?.find(entry => entry.id === 'root')
    expect(root?.family).toEqual(['child'])
    // The family figure includes the row itself.
    expect(root?.familyCost?.p.m.peak?.uncached).toBe(15)
  })

  it('survives a cyclic parent chain', () => {
    const rows = read({
      rows: [row('a', { parentId: 'b' }), row('b', { parentId: 'a' })],
    })
    expect(rows).toHaveLength(2)
    expect(rows?.[0].family).toContain('b')
  })
})
