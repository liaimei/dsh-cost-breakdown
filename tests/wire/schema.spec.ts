/**
 * The wire contract: the mutation-free schemas must accept exactly what the host produces and reject
 * anything else. The projection registry parses every published value against these, so a drifting field
 * would surface as a refused serve rather than a wrong number — which is why `.strict()` matters.
 */

import { describe, expect, it } from 'vitest'
import {
  activityStateSchema, activityViewSchema, headerStateSchema, headerViewSchema, timelineDetailSchema,
  timelineStateSchema, timelineViewSchema,
} from '../../src/wire/schema'
import { emptyTimeline } from '../../src/host/fold/state'

/** A minimal, valid timeline payload. */
function snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 1, inject: 0, skill: 0, assistant: 2, tool: 0, total: 3 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...overrides,
  }
}

describe('timelineViewSchema', () => {
  it('accepts a minimal payload', () => {
    expect(timelineViewSchema.safeParse(snapshot()).success).toBe(true)
  })

  it('rejects a payload missing the required current block', () => {
    const bad = snapshot()
    delete bad.current
    expect(timelineViewSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects an extra field at the top level', () => {
    // An extra wire field is a field nobody prices; failing loudly beats shipping it.
    expect(timelineViewSchema.safeParse(snapshot({ surplus: 1 })).success).toBe(false)
  })

  it('accepts the optional split-generation markers', () => {
    const parsed = timelineViewSchema.safeParse(snapshot({
      detailRev: 7,
      counts: { turns: 1, steps: 2, injects: 0, compactions: 0, prunes: 0, skills: 0 },
      last: { seq: 4, total: 12, prompt: 9 },
    }))
    expect(parsed.success).toBe(true)
  })

  it('validates the embedded ledger shape', () => {
    const parsed = timelineViewSchema.safeParse(snapshot({
      cost: { p: { m: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    }))
    expect(parsed.success).toBe(true)
  })
})

describe('timelineDetailSchema', () => {
  it('accepts the collections payload', () => {
    const parsed = timelineDetailSchema.safeParse({
      rev: 3, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a negative revision', () => {
    expect(timelineDetailSchema.safeParse({
      rev: -1, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [],
    }).success).toBe(false)
  })
})

describe('state schemas', () => {
  it('accepts the empty fold state', () => {
    expect(timelineStateSchema.safeParse(emptyTimeline()).success).toBe(true)
  })

  it('accepts a headers epoch list and its legacy superset', () => {
    expect(headerViewSchema.safeParse({ headers: [] }).success).toBe(true)
    // A pre-split row carried the system text where the price now lives; it must still seed a fold.
    expect(headerStateSchema.safeParse({
      headers: [{ seq: 1, time: 2, system: 'text', tools: [{ name: 'a', tokens: 1, description: 'd', schema: {} }] }],
    }).success).toBe(true)
  })

  it('validates activity day keys', () => {
    expect(activityViewSchema.safeParse({ days: {} }).success).toBe(true)
    expect(activityViewSchema.safeParse({ days: { '2026-10-16': { tokens: 1, requests: 1 } } }).success).toBe(true)
    expect(activityViewSchema.safeParse({ days: { '16-10-2026': { tokens: 1, requests: 1 } } }).success).toBe(false)
    expect(activityStateSchema.safeParse({ days: {}, model: 'm' }).success).toBe(true)
  })
})
