/**
 * The projection units as the registry sees them: key, stateVersion, init/apply/view. The two wire
 * generations are the subtle part — the unit must serve a slim head while the detail channel is live and a
 * fully inline value when it is not, folding the same state either way.
 *
 * The helpers below are deliberately loose: a unit's state and payload types differ per key, and the point of
 * these assertions is the published JSON, not the compile-time shape of each unit.
 */

import { describe, expect, it } from 'vitest'
import { createTimelineUnit, TIMELINE_KEY, TIMELINE_STATE_VERSION } from '../../../src/host/projections/timeline'
import { createHeadersUnit, HEADERS_KEY, HEADERS_STATE_VERSION } from '../../../src/host/projections/headers'
import { createActivityUnit, ACTIVITY_KEY, ACTIVITY_STATE_VERSION } from '../../../src/host/projections/activity'
import { createDegradedActivity, createDegradedHeaders, createDegradedTimeline } from '../../../src/host/projections/degraded'
import type { Config } from '../../../src/host/settings'
import type { Snapshot } from '../../../src/wire/model'

const CONFIG: Config = {}

/** One projection unit, seen only through what the registry uses. */
interface UnitLike {
  key: string
  stateVersion: number
  init(header: never, inherited: never): unknown
  apply(state: never, event: never): unknown
  wire?: { view(state: never): unknown; viewSchema: { safeParse(value: unknown): { success: boolean } } }
}

/** The registry always passes a header and the inherited prefix length; these units ignore both. */
function initOf(unit: UnitLike): never {
  return unit.init({} as never, 0 as never) as never
}

/** The served value. A unit this plugin registers always declares one; the guard keeps the failure legible. */
function viewOf(unit: UnitLike, state: never): unknown {
  if (unit.wire === undefined) throw new Error('unit has no wire block')
  return unit.wire.view(state)
}

/** Fold one event through a unit. */
function applyOf(unit: UnitLike, state: never, event: unknown): never {
  return unit.apply(state, event as never) as never
}

describe('contextTimeline unit', () => {
  it('declares the frozen key and state version', () => {
    const unit = createTimelineUnit(CONFIG, () => false) as unknown as UnitLike
    expect(unit.key).toBe('contextTimeline')
    expect(unit.key).toBe(TIMELINE_KEY)
    expect(unit.stateVersion).toBe(29)
    expect(unit.stateVersion).toBe(TIMELINE_STATE_VERSION)
  })

  it('serves the inline generation when the detail channel is dead', () => {
    const unit = createTimelineUnit(CONFIG, () => false) as unknown as UnitLike
    const value = viewOf(unit, initOf(unit)) as Snapshot
    // Inline: the collections are present as arrays and there is no split marker.
    expect(Array.isArray(value.requests)).toBe(true)
    expect(value.detailRev).toBeUndefined()
  })

  it('serves the slim head when the detail channel is live', () => {
    const unit = createTimelineUnit(CONFIG, () => true) as unknown as UnitLike
    const value = viewOf(unit, initOf(unit)) as Snapshot
    expect(value.detailRev).toBe(0)
    expect(value.requests).toEqual([])
    expect(value.counts).toEqual({ turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: 0 })
  })

  it('re-reads the liveness probe on every serve', () => {
    let live = false
    const unit = createTimelineUnit(CONFIG, () => live) as unknown as UnitLike
    const state = initOf(unit)
    expect((viewOf(unit, state) as Snapshot).detailRev).toBeUndefined()
    live = true
    expect((viewOf(unit, state) as Snapshot).detailRev).toBe(0)
  })

  it('folds an event through apply', () => {
    const unit = createTimelineUnit(CONFIG, () => true) as unknown as UnitLike
    const state = applyOf(unit, initOf(unit), {
      type: 'request/header',
      seq: 1,
      time: 1,
      data: { header: { config: { model: 'deepseek-flash' }, tools: [] }, reason: 'initial' },
    })
    expect((viewOf(unit, state) as Snapshot).model).toBe('deepseek-flash')
  })

  it('validates its own view payload', () => {
    const unit = createTimelineUnit(CONFIG, () => true) as unknown as UnitLike
    expect(unit.wire?.viewSchema.safeParse(viewOf(unit, initOf(unit))).success).toBe(true)
  })
})

describe('contextHeaders unit', () => {
  it('declares the frozen key and version, and folds an epoch', () => {
    const unit = createHeadersUnit(() => 'someone') as unknown as UnitLike
    expect(unit.key).toBe(HEADERS_KEY)
    expect(unit.stateVersion).toBe(HEADERS_STATE_VERSION)
    expect(unit.stateVersion).toBe(1)
    const state = applyOf(unit, initOf(unit), {
      type: 'request/header', seq: 1, time: 2, data: { header: { tools: [{ name: 'read', description: 'd' }] } },
    })
    const view = viewOf(unit, state) as { headers: Array<{ tools: Array<{ name: string }> }> }
    expect(view.headers).toHaveLength(1)
    expect(view.headers[0].tools[0]).toMatchObject({ name: 'read' })
  })

  it('ignores an unrelated event by reference', () => {
    const unit = createHeadersUnit(undefined) as unknown as UnitLike
    const state = initOf(unit)
    expect(applyOf(unit, state, { type: 'user/message', seq: 1, time: 1 })).toBe(state)
  })
})

describe('contextActivity unit', () => {
  it('declares the frozen key and version', () => {
    const unit = createActivityUnit([]) as unknown as UnitLike
    expect(unit.key).toBe(ACTIVITY_KEY)
    expect(unit.stateVersion).toBe(ACTIVITY_STATE_VERSION)
    expect(unit.stateVersion).toBe(6)
  })

  it('books a settlement into a local day', () => {
    const unit = createActivityUnit([]) as unknown as UnitLike
    let state = applyOf(unit, initOf(unit), {
      type: 'request/header', seq: 1, time: Date.UTC(2026, 9, 16, 2), data: { header: { config: { model: 'm', provider: 'p' } } },
    })
    state = applyOf(unit, state, {
      type: 'assistant/message', seq: 2, time: Date.UTC(2026, 9, 16, 3),
      data: { message: { content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 10, outputTokens: 1 } },
    })
    const days = (viewOf(unit, state) as { days: Record<string, { tokens: number; requests: number }> }).days
    expect(Object.keys(days)).toHaveLength(1)
    const day = Object.values(days)[0]
    expect(day.tokens).toBe(11)
    expect(day.requests).toBe(1)
  })
})

describe('degraded units', () => {
  it('folds nothing and serves a zeroed payload with the gate record', () => {
    const unit = createDegradedTimeline('0.0.9') as unknown as UnitLike
    expect(unit.stateVersion).toBe(1)
    const value = viewOf(unit, initOf(unit)) as Snapshot
    expect(value.unsupported).toEqual({ current: '0.0.9', minimum: '0.1.7-rc.2' })
    expect(value.current.total).toBe(0)
    expect(value.requests).toEqual([])
  })

  it('serves empty headers and days', () => {
    const headers = createDegradedHeaders() as unknown as UnitLike
    expect(viewOf(headers, initOf(headers))).toEqual({ headers: [] })
    const activity = createDegradedActivity() as unknown as UnitLike
    expect(viewOf(activity, initOf(activity))).toEqual({ days: {} })
  })
})
