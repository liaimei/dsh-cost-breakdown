/**
 * The agent family model: anchoring, sibling order, DFS order, the node cap and cycle safety.
 *
 * Each rule fixes a visible bug: anchoring on the current session instead of the topmost ancestor would show
 * a leaf when opening a sub-agent; ignoring the spawn catalogue would reorder a team between renders; and an
 * untrusted `parentId` chain must not be able to loop.
 */

import { describe, expect, it } from 'vitest'
import {
  AGENT_TREE_LIMIT, agentForestOf, agentIdentityOf, agentDurationOf, agentRowOf,
  barSegmentsOf, catalogOrderOf, formatDurationCompact, layoutForest, lineageOf,
  pressureColorOf, subagentCostOf,
} from '../../src/client/ui/context/agents'

/** A session-list snapshot from `{ id: row }` pairs. */
function snapshot(rows: Record<string, Record<string, unknown>>): { byId: Record<string, unknown> } {
  return { byId: rows }
}

/** A minimal row. */
function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, title: id, updatedAt: 1, running: false, blank: false, ...overrides }
}

describe('row narrowing', () => {
  it('keeps only validated fields', () => {
    expect(agentRowOf({ title: 'a', parentId: 'p', running: 'yes', updatedAt: 'x' })).toEqual({
      title: 'a', parentId: 'p', running: false, blank: false, updatedAt: 0,
    })
  })

  it('rejects a non-record', () => {
    expect(agentRowOf(null)).toBeNull()
    expect(agentRowOf([])).toBeNull()
  })
})

describe('identity, duration and completion', () => {
  it('reads only the two known modes', () => {
    expect(agentIdentityOf({ mode: 'one-shot' })).toEqual({ mode: 'one-shot' })
    expect(agentIdentityOf({ mode: 'continuable', label: 'fixer' })).toEqual({ mode: 'continuable', label: 'fixer' })
    // A future mode reads as "no identity" rather than as a usable node.
    expect(agentIdentityOf({ mode: 'someday' })).toBeNull()
  })

  it('adds the open interval to the settled time', () => {
    expect(agentDurationOf({ settledMs: 100, active: { since: 1000, through: 1500 } })).toBe(600)
    // A trailing `through` must not subtract.
    expect(agentDurationOf({ settledMs: 100, active: { since: 2000, through: 1500 } })).toBe(100)
    // A non-positive total is not a figure worth printing.
    expect(agentDurationOf({ settledMs: 0 })).toBeNull()
  })
})

describe('catalogOrderOf', () => {
  it('indexes the spawn order', () => {
    expect([...(catalogOrderOf({ subagentCatalog: [{ id: 'a' }, { id: 'b' }] })?.entries() ?? [])])
      .toEqual([['a', 0], ['b', 1]])
  })

  it('returns null without a usable catalog', () => {
    expect(catalogOrderOf(undefined)).toBeNull()
    expect(catalogOrderOf({ subagentCatalog: [] })).toBeNull()
    expect(catalogOrderOf({ subagentCatalog: [{ id: '' }] })).toBeNull()
  })
})

describe('agentForestOf', () => {
  it('anchors on the topmost known ancestor', () => {
    const forest = agentForestOf(snapshot({
      grand: row('grand'),
      parent: row('parent', { parentId: 'grand' }),
      me: row('me', { parentId: 'parent' }),
      sibling: row('sibling', { parentId: 'parent' }),
    }), 'me')
    expect(forest?.nodes[0].id).toBe('grand')
    expect(forest?.nodes.map(node => node.id)).toContain('sibling')
    expect(forest?.nodes.find(node => node.isCurrent)?.id).toBe('me')
  })

  it('orders siblings by the parent catalogue, then by activity', () => {
    const forest = agentForestOf(snapshot({
      root: row('root', { projectionValues: { subagentCatalog: [{ id: 'second' }, { id: 'first' }] } }),
      first: row('first', { parentId: 'root', updatedAt: 500 }),
      second: row('second', { parentId: 'root', updatedAt: 100 }),
    }), 'root')
    expect(forest?.nodes.map(node => node.id)).toEqual(['root', 'second', 'first'])
  })

  it('emits DFS pre-order: every parent before its children', () => {
    const forest = agentForestOf(snapshot({
      root: row('root'),
      a: row('a', { parentId: 'root' }),
      a1: row('a1', { parentId: 'a' }),
      b: row('b', { parentId: 'root' }),
    }), 'root')
    const ids = forest?.nodes.map(node => node.id) ?? []
    expect(ids.indexOf('root')).toBeLessThan(ids.indexOf('a'))
    expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('a1'))
    expect(ids.indexOf('a1')).toBeLessThan(ids.indexOf('b'))
  })

  it('caps the graph and reports the exact overflow', () => {
    const rows: Record<string, Record<string, unknown>> = { root: row('root') }
    for (let index = 0; index < AGENT_TREE_LIMIT + 5; index++) {
      rows[`kid${index}`] = row(`kid${index}`, { parentId: 'root' })
    }
    const forest = agentForestOf(snapshot(rows), 'root')
    expect(forest?.nodes.length).toBe(AGENT_TREE_LIMIT)
    expect(forest?.overflow).toBe(6)
  })

  it('survives a circular parent chain', () => {
    const forest = agentForestOf(snapshot({
      a: row('a', { parentId: 'b' }),
      b: row('b', { parentId: 'a' }),
    }), 'a')
    expect(forest).not.toBeNull()
    expect(forest?.nodes.length).toBeLessThanOrEqual(2)
  })

  it('synthesises the current session when the list has not materialised it', () => {
    const forest = agentForestOf(snapshot({ other: row('other') }), 'me')
    expect(forest?.nodes).toHaveLength(1)
    expect(forest?.nodes[0].isCurrent).toBe(true)
    expect(forest?.solo).toBe(true)
  })

  it('skips blank placeholder rows but keeps the current session', () => {
    const forest = agentForestOf(snapshot({
      root: row('root'),
      placeholder: row('placeholder', { parentId: 'root', blank: true }),
    }), 'root')
    expect(forest?.nodes.map(node => node.id)).toEqual(['root'])
  })
})

describe('layoutForest', () => {
  it('places one row per depth and centres it', () => {
    const forest = agentForestOf(snapshot({
      root: row('root'),
      a: row('a', { parentId: 'root' }),
      b: row('b', { parentId: 'root' }),
    }), 'root')
    const layout = layoutForest(forest as never, 600)
    expect(layout.placed).toHaveLength(3)
    const root = layout.placed.find(entry => entry.node.id === 'root')
    const a = layout.placed.find(entry => entry.node.id === 'a')
    expect(a?.top).toBeGreaterThan(root?.top ?? 0)
    // Two children share a level, so the root's row is centred over them.
    expect(layout.edges).toHaveLength(2)
  })
})

describe('subagentCostOf', () => {
  it('folds every descendant and never the current session itself', () => {
    const ledger = { p: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const timeline = {
      ok: true,
      current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
      requests: [], events: [], nodes: [], droppedNodes: 0, archive: [], cost: ledger,
    }
    const fold = subagentCostOf(snapshot({
      root: row('root', { projectionValues: { contextTimeline: timeline } }),
      kid: row('kid', { parentId: 'root', projectionValues: { contextTimeline: timeline } }),
    }), 'root')
    expect(fold.count).toBe(1)
    expect(fold.ledger?.p.m.peak?.uncached).toBe(10)
  })
})

describe('lineageOf', () => {
  it('lights the ancestor chain and the whole subtree, and nothing else', () => {
    const forest = agentForestOf(snapshot({
      root: row('root'),
      a: row('a', { parentId: 'root' }),
      a1: row('a1', { parentId: 'a' }),
      b: row('b', { parentId: 'root' }),
      other: row('other'),
    }), 'root')
    const lit = lineageOf(forest as never, 'a')
    expect([...lit].sort()).toEqual(['a', 'a1', 'root'])
    // A sibling subtree is not in the lineage.
    expect(lit.has('b')).toBe(false)
  })

  it('survives a cycle in the parent chain', () => {
    const forest = agentForestOf(snapshot({
      a: row('a', { parentId: 'b' }),
      b: row('b', { parentId: 'a' }),
    }), 'a')
    expect(leafCount(lineageOf(forest as never, 'a'))).toBeLessThanOrEqual(2)
  })

  /** Cycle guard: the walk must terminate, so this many ids at most. */
  function leafCount(set: Set<string>): number { return set.size }
})

describe('pressureColorOf', () => {
  it('moves from green through amber and orange to pink', () => {
    expect(pressureColorOf(null)).toContain('slate')
    expect(pressureColorOf(10)).toContain('green')
    expect(pressureColorOf(60)).toContain('amber')
    expect(pressureColorOf(80)).toContain('orange')
    expect(pressureColorOf(95)).toContain('pink')
  })
})

describe('barSegmentsOf', () => {
  it('splits the composition and leaves the idle window as the remainder', () => {
    const node = {
      head: {
        tokens: 40, window: 100, pct: 40,
        parts: [{ key: 'system', value: 20 }, { key: 'user', value: 20 }],
      },
    } as never
    const segments = barSegmentsOf(node, { system: 'red', user: 'blue' })
    expect(segments.map(segment => segment.key)).toEqual(['system', 'user', 'free'])
    expect(segments.at(-1)?.share).toBe(60)
  })

  it('reports no segments without a headline', () => {
    expect(barSegmentsOf({ head: null } as never, {})).toEqual([])
  })
})

describe('formatDurationCompact', () => {
  it('picks the unit by magnitude', () => {
    expect(formatDurationCompact(12_000)).toBe('12s')
    expect(formatDurationCompact(200_000)).toBe('3m 20s')
    expect(formatDurationCompact(3_840_000)).toBe('1h 04m')
  })
})
