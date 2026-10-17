/**
 * Ledger arithmetic: booking, copying and merging. The projection cache persists these structures, so a
 * copy that aliases the persisted state silently corrupts it, and a merge that adds across currencies
 * produces a number that is not money.
 */

import { describe, expect, it } from 'vitest'
import {
  addBuckets, billedTokensOf, bookCall, bookUsage, copyCallLedger, copyCostLedger, copyTurnLedger,
  emptyBuckets, ledgerCalls, ledgerTokens, mergeCallLedgers, mergeCostLedgers,
} from '../../src/core/ledger'
import type { CostLedger } from '../../src/wire/model'

const empty: CostLedger = {}

describe('bucket arithmetic', () => {
  it('adds buckets without mutating the input', () => {
    const base = { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }
    const sum = addBuckets(base, { uncached: 10, cacheRead: 20, cacheWrite: 30, output: 40 })
    expect(sum).toEqual({ uncached: 11, cacheRead: 22, cacheWrite: 33, output: 44 })
    expect(base).toEqual({ uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 })
  })

  it('sums the four billed buckets', () => {
    expect(billedTokensOf({ uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 })).toBe(10)
    expect(billedTokensOf(emptyBuckets())).toBe(0)
  })
})

describe('booking', () => {
  it('books a peak settlement into the peak bucket', () => {
    const ledger = bookUsage(empty, 'deepseek-official', 'deepseek-flash', 'peak', { uncached: 5, cacheRead: 1, cacheWrite: 0, output: 2 })
    expect(ledger['deepseek-official']['deepseek-flash'].peak).toEqual({ uncached: 5, cacheRead: 1, cacheWrite: 0, output: 2 })
    expect(ledger['deepseek-official']['deepseek-flash'].off).toBeUndefined()
  })

  it('accumulates successive settlements of the same key', () => {
    let ledger = bookUsage(empty, 'p', 'm', 'off', { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 })
    ledger = bookUsage(ledger, 'p', 'm', 'off', { uncached: 2, cacheRead: 0, cacheWrite: 0, output: 0 })
    expect(ledger.p.m.off?.uncached).toBe(3)
  })

  it('counts requests separately from tokens', () => {
    let calls = bookCall({}, 'p', 'm')
    calls = bookCall(calls, 'p', 'm')
    expect(calls.p.m).toBe(2)
    expect(ledgerCalls(calls)).toBe(2)
  })

  it('never mutates the ledger it was given', () => {
    const before: CostLedger = { p: { m: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const snapshot = JSON.parse(JSON.stringify(before)) as CostLedger
    bookUsage(before, 'p', 'm', 'peak', { uncached: 9, cacheRead: 0, cacheWrite: 0, output: 0 })
    expect(before).toEqual(snapshot)
  })
})

describe('copying', () => {
  it('deep-copies a ledger so a served value cannot alias persisted state', () => {
    const source: CostLedger = { p: { m: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const copy = copyCostLedger(source)
    copy.p.m.peak!.uncached = 99
    expect(source.p.m.peak?.uncached).toBe(1)
  })

  it('copies call and turn ledgers independently', () => {
    const calls = copyCallLedger({ p: { m: 1 } })
    calls.p.m = 5
    expect(calls.p.m).toBe(5)
    const turns = copyTurnLedger({ '1': { usage: { p: { m: {} } }, requests: { p: { m: 2 } } } })
    turns['1'].requests.p.m = 7
    expect(turns['1'].requests.p.m).toBe(7)
  })
})

describe('merging', () => {
  it('sums overlapping buckets and keeps distinct paths apart', () => {
    const left = bookUsage(empty, 'a', 'x', 'peak', { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 })
    const right = bookUsage(empty, 'a', 'x', 'peak', { uncached: 2, cacheRead: 0, cacheWrite: 0, output: 0 })
    const merged = mergeCostLedgers(left, right)
    expect(merged?.a.x.peak?.uncached).toBe(3)
    expect(mergeCostLedgers(left, bookUsage(empty, 'b', 'y', 'off', { uncached: 4, cacheRead: 0, cacheWrite: 0, output: 0 }))?.b.y.off?.uncached).toBe(4)
  })

  it('returns null when there is nothing to merge', () => {
    expect(mergeCostLedgers(null, null)).toBeNull()
    expect(mergeCostLedgers(empty, empty)).toBeNull()
    expect(mergeCallLedgers(null, undefined)).toBeNull()
  })

  it('sums token and call totals', () => {
    const ledger = mergeCostLedgers(
      bookUsage(empty, 'a', 'x', 'peak', { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }),
      bookUsage(empty, 'a', 'x', 'off', { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 }),
    )
    expect(ledgerTokens(ledger)).toBe(20)
    expect(ledgerTokens(null)).toBeNull()
  })
})
