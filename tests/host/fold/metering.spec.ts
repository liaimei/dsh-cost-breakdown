/**
 * Metering: which billing period a settlement lands in, and the three ledgers written from one point.
 *
 * The rule that matters most here is the **model-keyed** period decision: an official-table model bills by
 * the Beijing windows whichever route carried it (a proxied DeepSeek call must not be booked into the peak
 * bucket without the peak multiplier), while an unlisted model books at its face rate in the peak bucket.
 */

import { describe, expect, it } from 'vitest'
import { reduceTimeline } from '../../../src/host/fold/reducer'
import { emptyTimeline, type TimelineEvent } from '../../../src/host/fold/state'
import type { FoldBounds } from '../../../src/host/settings'

/** Beijing wall-clock instant as an epoch millisecond. */
function beijing(year: number, month: number, day: number, hour: number): number {
  return Date.UTC(year, month - 1, day, hour - 8)
}

const BOUNDS: FoldBounds = {
  maxRequestSteps: 1500, maxKeptTurns: 300, maxEvents: 400, maxNodes: 2000,
  maxArchiveNodes: 400, maxFileOps: 400, holidays: [],
}

/** Fold a header and one billed assistant message at `time`. */
function settle(provider: string, model: string, time: number, holidays: string[] = []): ReturnType<typeof emptyTimeline> {
  const bounds = { ...BOUNDS, holidays }
  const events: TimelineEvent[] = [
    {
      type: 'request/header',
      seq: 1,
      time,
      data: { header: { config: { model, provider }, tools: [] }, reason: 'initial' },
    },
    {
      type: 'assistant/message',
      seq: 2,
      time,
      data: {
        message: { content: [{ type: 'text', text: 'x' }] },
        usage: { inputTokens: 100, outputTokens: 10 },
        turn: 1,
      },
      surfaceOp: 'append',
    },
  ]
  let state = emptyTimeline()
  for (const event of events) state = reduceTimeline(state, event, bounds)
  return state
}

describe('period resolution', () => {
  it('books an official model into the peak bucket during a Beijing peak window', () => {
    // 2026-10-16 is a Friday; 10:00 Beijing is inside 09:00–12:00.
    const state = settle('deepseek-official', 'deepseek-flash', beijing(2026, 10, 16, 10))
    const entry = state.cost?.['deepseek-official']?.['deepseek-flash']
    expect(entry?.peak?.uncached).toBe(100)
    expect(entry?.off).toBeUndefined()
  })

  it('books the same model off-peak outside the windows', () => {
    const state = settle('deepseek-official', 'deepseek-flash', beijing(2026, 10, 16, 13))
    const entry = state.cost?.['deepseek-official']?.['deepseek-flash']
    expect(entry?.off?.uncached).toBe(100)
    expect(entry?.peak).toBeUndefined()
  })

  it('keeps a proxied official model on the model-keyed period rule', () => {
    // The route is a third-party proxy, but the model is on the official table: it must still split by the
    // Beijing windows rather than being booked peak and left undoubled.
    const peak = settle('workbuddy', 'deepseek-flash', beijing(2026, 10, 16, 10))
    expect(peak.cost?.['workbuddy']?.['deepseek-flash']?.peak?.uncached).toBe(100)
    const off = settle('workbuddy', 'deepseek-flash', beijing(2026, 10, 16, 13))
    expect(off.cost?.['workbuddy']?.['deepseek-flash']?.off?.uncached).toBe(100)
  })

  it('books an unlisted model into the peak bucket at its face rate', () => {
    const state = settle('some-proxy', 'mystery-model', beijing(2026, 10, 16, 13))
    expect(state.cost?.['some-proxy']?.['mystery-model']?.peak?.uncached).toBe(100)
    expect(state.cost?.['some-proxy']?.['mystery-model']?.off).toBeUndefined()
  })

  it('bills a public holiday at off-peak all day', () => {
    const state = settle('deepseek-official', 'deepseek-flash', beijing(2026, 10, 1, 10), ['2026-10-01'])
    expect(state.cost?.['deepseek-official']?.['deepseek-flash']?.off?.uncached).toBe(100)
  })
})

describe('one settlement, three ledgers', () => {
  it('writes the session ledger, the call count and the turn ledger together', () => {
    const state = settle('deepseek-official', 'deepseek-flash', beijing(2026, 10, 16, 10))
    expect(state.cost).toBeDefined()
    expect(state.calls?.['deepseek-official']?.['deepseek-flash']).toBe(1)
    expect(state.turnCost?.['1']?.requests?.['deepseek-official']?.['deepseek-flash']).toBe(1)
    expect(state.turnCost?.['1']?.usage?.['deepseek-official']?.['deepseek-flash']?.peak?.uncached).toBe(100)
  })

  it('accumulates successive settlements into the same bucket', () => {
    const bounds = BOUNDS
    const time = beijing(2026, 10, 16, 10)
    let state = emptyTimeline()
    state = reduceTimeline(state, {
      type: 'request/header', seq: 1, time, data: { header: { config: { model: 'deepseek-flash', provider: 'deepseek-official' }, tools: [] }, reason: 'initial' },
    } as never, bounds)
    for (const seq of [2, 4]) {
      state = reduceTimeline(state, {
        type: 'assistant/message', seq, time,
        data: { message: { content: [{ type: 'text', text: 'x' }] }, usage: { inputTokens: 100 }, turn: 1 },
        surfaceOp: 'append',
      } as never, bounds)
    }
    expect(state.cost?.['deepseek-official']?.['deepseek-flash']?.peak?.uncached).toBe(200)
    expect(state.calls?.['deepseek-official']?.['deepseek-flash']).toBe(2)
  })

  it('ignores a hostile usage payload rather than throwing', () => {
    let state = emptyTimeline()
    state = reduceTimeline(state, {
      type: 'request/header', seq: 1, time: 1, data: { header: { config: { model: 'deepseek-flash', provider: 'deepseek-official' }, tools: [] }, reason: 'initial' },
    } as never, BOUNDS)
    state = reduceTimeline(state, {
      type: 'assistant/message', seq: 2, time: 1,
      data: { message: { content: [] }, usage: { inputTokens: 'lots', cacheReadTokens: {}, outputTokens: Number.NaN } },
      surfaceOp: 'append',
    } as never, BOUNDS)
    // Every bucket is unreadable, so nothing is booked (and nothing throws).
    expect(state.cost).toBeUndefined()
  })
})
