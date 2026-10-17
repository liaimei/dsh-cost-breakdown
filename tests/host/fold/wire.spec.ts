/**
 * The served value: the slim head, the heavy detail payload, and the inline generation.
 *
 * The split exists so the heavy collections stay off every pushed frame, and the pinning rule exists so a
 * long session still exposes the inject/skill nodes whose tokens count towards the live composition. Both
 * are asserted here, along with the event→request annotation that makes a compacted/pruned row readable.
 */

import { describe, expect, it } from 'vitest'
import { detailOf, detailPayloadOf, inlineOf, splitHeadOf } from '../../../src/host/fold/wire'
import { emptyTimeline, type TimelineState } from '../../../src/host/fold/state'
import type { FoldBounds } from '../../../src/host/settings'
import type { SurfaceEntry } from '../../../src/wire/model'

const BOUNDS: FoldBounds = {
  maxRequestSteps: 1500,
  maxKeptTurns: 300,
  maxEvents: 400,
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
  holidays: [],
}

/** A state with `count` healthy surface nodes plus one request and one event. */
function stateWith(count: number): TimelineState {
  const state = emptyTimeline()
  state.surface = Array.from({ length: count }, (_, index): SurfaceEntry => ({
    seq: index + 1,
    time: index,
    cat: index === 0 ? 'inject' : 'user',
    tokens: 10,
  }))
  state.sums = { user: (count - 1) * 10, inject: 10, skill: 0, assistant: 0, tool: 0 }
  state.requests = [{ seq: 2, time: 1, system: 1, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 1, turn: 1, step: 1 }]
  state.events = [{ seq: 3, time: 2, kind: 'model', from: 'a', to: 'b' }]
  return state
}

describe('the slim head', () => {
  it('carries scalars and counters but no collections', () => {
    const value = splitHeadOf(stateWith(3))
    expect(value.ok).toBe(true)
    expect(value.requests).toEqual([])
    expect(value.events).toEqual([])
    expect(value.nodes).toEqual([])
    expect(value.detailRev).toBe(0)
    expect(value.counts).toMatchObject({ turns: 1, steps: 1 })
  })

  it('counts dropped nodes per the pinning rule', () => {
    // Three nodes with a budget of one: the pinned inject node survives beside the tail.
    const state = stateWith(3)
    const detail = detailOf(state, { ...BOUNDS, maxNodes: 1 })
    expect(detail.nodes.map(node => node.cat)).toEqual(['inject', 'user'])
    expect(detail.droppedNodes).toBe(1)
    expect(detail.surfaceFloor).toBe(2)
  })
})

describe('the detail payload', () => {
  it('serves the collections and annotates events with the requests around them', () => {
    const detail = detailPayloadOf(stateWith(2), BOUNDS)
    expect(detail.rev).toBe(0)
    expect(detail.requests).toHaveLength(1)
    expect(detail.events).toHaveLength(1)
    // The event sits after the only request: it follows that request (`fromTurn`/`fromStep`) and belongs
    // to no later one (`turn`/`step` stay absent).
    expect(detail.events[0]).toMatchObject({ fromTurn: 1, fromStep: 1 })
    expect(detail.events[0].turn).toBeUndefined()
  })

  it('serves copies, so a consumer cannot mutate persisted state', () => {
    const state = stateWith(2)
    const detail = detailPayloadOf(state, BOUNDS)
    detail.requests[0].total = 999
    expect(state.requests[0].total).toBe(1)
  })
})

describe('the inline generation', () => {
  it('carries the head plus the collections', () => {
    const value = inlineOf(stateWith(2), BOUNDS)
    expect(value.requests).toHaveLength(1)
    expect(value.events).toHaveLength(1)
    // The split marker is absent: this generation is not the slim one.
    expect(value.detailRev).toBeUndefined()
    expect(value.counts).toBeUndefined()
  })
})
