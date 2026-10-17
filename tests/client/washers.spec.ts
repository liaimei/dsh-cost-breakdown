/**
 * The boundary washers. Two properties are load-bearing: a well-formed payload must be returned by
 * reference (so a selector does not re-render on every event), and a malformed one must be repaired rather
 * than thrown on during render.
 */

import { describe, expect, it } from 'vitest'
import { activityOf, collectionsOf, headersOf, snapshotOf, timingOf } from '../../src/client/shell/washers'

const current = { system: 0, tools: 0, user: 1, inject: 0, skill: 0, assistant: 2, tool: 0, total: 3 }

/** A payload that passes the fast path. */
function fast(): Record<string, unknown> {
  return { ok: true, current, requests: [], events: [], nodes: [], archive: [], droppedNodes: 0 }
}

describe('snapshotOf', () => {
  it('returns a well-formed payload by reference', () => {
    const value = fast()
    expect(snapshotOf(value)).toBe(value)
  })

  it('returns null for a non-record', () => {
    expect(snapshotOf(null)).toBeNull()
    expect(snapshotOf('x')).toBeNull()
  })

  it('repairs a malformed payload instead of throwing', () => {
    const repaired = snapshotOf({ current: { user: 'x' }, requests: [null], nodes: 'nope' })
    expect(repaired).not.toBeNull()
    expect(repaired?.current.user).toBe(0)
    expect(repaired?.requests).toEqual([])
    expect(repaired?.nodes).toEqual([])
  })

  it('keeps the gate record through the slow path', () => {
    const repaired = snapshotOf({ ...fast(), current: undefined, unsupported: { current: '0.0.1', minimum: '0.1.7-rc.2' } })
    expect(repaired?.unsupported).toEqual({ current: '0.0.1', minimum: '0.1.7-rc.2' })
  })

  it('truncates an over-long last-user preview on the repair path', () => {
    // The fast path trusts the payload (the fold already bounds this to 80), so the bound is asserted on a
    // payload that has to be rebuilt.
    const repaired = snapshotOf({ ...fast(), current: undefined, lastUser: 'x'.repeat(500) })
    expect(repaired?.lastUser?.length).toBe(200)
  })

  it('passes a well-formed payload through without copying', () => {
    const value = { ...fast(), lastUser: 'x'.repeat(500) }
    expect(snapshotOf(value)).toBe(value)
  })
})

describe('collectionsOf', () => {
  it('distinguishes an absent fileOps from an empty one', () => {
    const absent = collectionsOf({})
    expect(absent.fileOps).toBeUndefined()
    const present = collectionsOf({ fileOps: [] })
    expect(present.fileOps).toEqual([])
  })

  it('drops null elements', () => {
    expect(collectionsOf({ requests: [null, { seq: 1 }] }).requests).toEqual([{ seq: 1 }])
  })
})

describe('timingOf', () => {
  it('keeps optional scalars absent rather than zero', () => {
    const timing = timingOf({ wallMs: 1, ttftMs: 0, genMs: 0, calls: 1, toolsMs: 0, toolCalls: 0, tools: {} })
    expect(timing?.reasoningMs).toBeUndefined()
    expect(timing?.wallMs).toBe(1)
  })

  it('drops a malformed per-tool row only', () => {
    const timing = timingOf({
      wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0,
      tools: { good: { calls: 1, ms: 2 }, bad: { calls: -1, ms: 2 }, worse: null },
    })
    expect(Object.keys(timing?.tools ?? {})).toEqual(['good'])
  })
})

describe('headersOf', () => {
  it('nulls the whole projection when an epoch is malformed', () => {
    expect(headersOf({ headers: [{ tools: 'nope' }] })).toBeNull()
    expect(headersOf({ headers: [{ tools: [{ name: 'a', tokens: 1 }] }] })).not.toBeNull()
  })

  it('repairs a legacy epoch that carried the system text', () => {
    const repaired = headersOf({ headers: [{ seq: 1, time: 2, system: 'abcd', tools: [] }] })
    expect(repaired?.headers[0].systemTokens).toBe(5)
  })
})

describe('activityOf', () => {
  it('returns the payload by reference when nothing needs repair', () => {
    const value = { days: { '2026-10-16': { tokens: 1, requests: 1 } } }
    expect(activityOf(value)).toBe(value)
  })

  it('drops malformed day keys and repairs bad days', () => {
    const washed = activityOf({ days: { bad: { tokens: 1 }, '2026-10-16': { tokens: 'x' } } })
    expect(Object.keys(washed?.days ?? {})).toEqual(['2026-10-16'])
    expect(washed?.days['2026-10-16'].tokens).toBe(0)
  })
})
