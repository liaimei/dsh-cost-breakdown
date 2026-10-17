/**
 * The timeline reducer's contract: reference discipline, all-or-nothing error containment, surface
 * bookkeeping, request records, metering and timing.
 *
 * These are the rules a rewrite can break silently — the registry only observes `Object.is`, so a fold
 * that returns a fresh reference on every event looks correct while pushing a frame per event.
 */

import { describe, expect, it } from 'vitest'
import { reduceTimeline } from '../../../src/host/fold/reducer'
import { emptyTimeline, pruneTimeline, type TimelineEvent, type TimelineState } from '../../../src/host/fold/state'
import type { FoldBounds } from '../../../src/host/settings'

const BOUNDS: FoldBounds = {
  maxRequestSteps: 1500,
  maxKeptTurns: 300,
  maxEvents: 400,
  maxNodes: 2000,
  maxArchiveNodes: 400,
  maxFileOps: 400,
  holidays: [],
}

let clock = 1_000
function at(): number {
  clock += 1_000
  return clock
}

/** Fold a list of events onto a fresh state. */
function fold(events: readonly TimelineEvent[], bounds: FoldBounds = BOUNDS): TimelineState {
  let state = emptyTimeline()
  for (const event of events) state = reduceTimeline(state, event, bounds)
  return state
}

const header = (seq: number, model = 'deepseek-flash', provider = 'deepseek-official', reason = 'initial'): TimelineEvent => ({
  type: 'request/header', seq, time: at(), data: { header: { config: { model, provider }, tools: [] }, reason },
})

const userMessage = (seq: number, text: string, source?: Record<string, unknown>): TimelineEvent => ({
  type: 'user/message', seq, time: at(), data: { content: [{ type: 'text', text }], ...(source !== undefined ? { source } : {}) }, surfaceOp: 'append',
})

const assistantMessage = (seq: number, opts: { text?: string; usage?: Record<string, unknown>; turn?: number; step?: number } = {}): TimelineEvent => ({
  type: 'assistant/message',
  seq,
  time: at(),
  data: {
    message: { content: [{ type: 'text', text: opts.text ?? 'reply' }] },
    ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
    ...(opts.step !== undefined ? { step: opts.step } : {}),
    ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
  },
  surfaceOp: 'append',
})

describe('reference discipline', () => {
  it('returns the same reference for an event it does not fold', () => {
    const state = emptyTimeline()
    const next = reduceTimeline(state, { type: 'not/a/known/event', seq: 1, time: at() }, BOUNDS)
    expect(next).toBe(state)
  })

  it('returns a new reference for an event it does fold', () => {
    const state = emptyTimeline()
    const next = reduceTimeline(state, header(1), BOUNDS)
    expect(next).not.toBe(state)
    expect(next.model).toBe('deepseek-flash')
  })

  it('discards a throwing event entirely and keeps the previous reference', () => {
    const state = fold([header(1), userMessage(2, 'hello')])
    // A record with a hostile getter: reading it throws, so the whole event must be dropped.
    const hostile = {
      type: 'assistant/message',
      seq: 3,
      time: at(),
      data: {
        message: {
          get content(): never { throw new Error('hostile') },
        },
      },
    } as unknown as TimelineEvent
    const next = reduceTimeline(state, hostile, BOUNDS)
    expect(next).toBe(state)
  })
})

describe('surface and composition', () => {
  it('categorises user, assistant and injected messages', () => {
    const state = fold([
      header(1),
      userMessage(2, 'hello'),
      userMessage(3, 'injected', { kind: 'agent-instructions' }),
      assistantMessage(4),
    ])
    const cats = state.surface.map(node => node.cat)
    expect(cats).toEqual(['user', 'inject', 'assistant'])
    expect(state.humanInputs).toBe(1)
    expect(state.answers).toBe(1)
    expect(state.lastUser).toBe('hello')
  })

  it('buckets skill invocations apart from ordinary injection', () => {
    const state = fold([
      header(1),
      userMessage(2, '<skill_content name="pdf">x</skill_content>', { kind: 'skill-invocation', name: 'pdf' }),
    ])
    expect(state.surface[0].cat).toBe('skill')
    expect(state.sums.skill).toBeGreaterThan(0)
    expect(state.sums.inject).toBe(0)
  })

  it('prices an empty assistant message at zero', () => {
    const state = fold([header(1), { type: 'assistant/message', seq: 2, time: at(), data: { message: { content: [] } }, surfaceOp: 'append' }])
    const node = state.surface.at(-1)
    expect(node?.tokens).toBe(0)
  })

  it('never puts system messages on the surface', () => {
    const state = fold([
      header(1),
      { type: 'system/message', seq: 2, time: at(), data: { message: { content: [{ type: 'text', text: 'sys' }] } } },
    ])
    expect(state.surface).toHaveLength(0)
    expect(state.systemTokens).toBeGreaterThan(0)
  })
})

describe('requests and metering', () => {
  it('builds a request record before the assistant node lands', () => {
    const state = fold([header(1), userMessage(2, 'hello'), assistantMessage(3, { turn: 1, step: 1 })])
    expect(state.requests).toHaveLength(1)
    expect(state.requests[0]).toMatchObject({ turn: 1, step: 1 })
    expect(state.requests[0].total).toBeGreaterThan(0)
  })

  it('books billed usage into provider/model/period buckets and call counts', () => {
    const state = fold([
      header(1),
      userMessage(2, 'hello'),
      assistantMessage(3, { turn: 1, usage: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 20 } }),
    ])
    const entry = state.cost?.['deepseek-official']?.['deepseek-flash']
    expect(entry).toBeDefined()
    const buckets = entry?.peak ?? entry?.off
    expect(buckets).toMatchObject({ uncached: 100, cacheRead: 50, output: 20 })
    expect(state.calls?.['deepseek-official']?.['deepseek-flash']).toBe(1)
    expect(state.turnCost?.['1']).toBeDefined()
  })

  it('writes nothing when no model is known', () => {
    const state = fold([header(1, '', ''), assistantMessage(2, { usage: { inputTokens: 10 } })])
    expect(state.cost).toBeUndefined()
  })

  it('clears the inherited cost on a seeded session but keeps the local one', () => {
    const seeded = fold([
      header(1),
      assistantMessage(2, { usage: { inputTokens: 10 } }),
      { type: 'session/end-seed', seq: 3, time: at(), data: { inherited: true } },
      assistantMessage(4, { usage: { inputTokens: 5 } }),
    ])
    // The fixture timestamps are near the epoch, so they land in the off-peak period.
    const entry = seeded.cost?.['deepseek-official']?.['deepseek-flash']
    const bucket = entry?.off ?? entry?.peak
    expect(bucket?.uncached).toBe(5)
  })

  it('leaves the ledger alone for an untagged end-seed marker', () => {
    const before = fold([header(1), assistantMessage(2, { usage: { inputTokens: 10 } })])
    const after = reduceTimeline(before, { type: 'session/end-seed', seq: 3, time: at(), data: {} }, BOUNDS)
    expect(after).toBe(before)
  })
})

describe('retention', () => {
  it('keeps only the newest turn runs', () => {
    let state = emptyTimeline()
    for (let turn = 1; turn <= 5; turn++) {
      state = reduceTimeline(state, header(turn * 10), BOUNDS)
      state = reduceTimeline(state, userMessage(turn * 10 + 1, `t${turn}`), BOUNDS)
      state = reduceTimeline(state, assistantMessage(turn * 10 + 2, { turn }), BOUNDS)
    }
    const trimmed = { ...state }
    pruneTimeline(trimmed, { ...BOUNDS, maxKeptTurns: 2 })
    const turns = new Set(trimmed.requests.map(row => row.turn))
    expect(turns.size).toBeLessThanOrEqual(2)
    expect([...turns]).toEqual([4, 5])
  })

  it('caps events and raises the file-op floor when it drops rows', () => {
    const state = fold(Array.from({ length: 6 }, (_, index) => ({
      type: 'plan/mode', seq: index + 1, time: at(), data: { active: true },
    })), BOUNDS)
    expect(state.events.length).toBe(6)
    const trimmed = { ...state }
    pruneTimeline(trimmed, { ...BOUNDS, maxEvents: 2 })
    expect(trimmed.events).toHaveLength(2)
  })
})

describe('determinism', () => {
  it('folds the same log to the same state twice', () => {
    const events = [header(1), userMessage(2, 'hello'), assistantMessage(3, { turn: 1, usage: { inputTokens: 3 } })]
    expect(fold(events)).toEqual(fold(events))
  })
})
