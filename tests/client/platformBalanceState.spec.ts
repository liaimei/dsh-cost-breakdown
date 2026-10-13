// The shared platform-balance seat (src/client/platformBalanceState.ts).
//
// Three surfaces read the same balances — the statistics page, the in-session spend section and
// the composer readout — so the polling lives here once. One implementation is what keeps them
// from disagreeing about the same account or credit pool.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { usePlatformBalances } from '../../src/client/platformBalanceState'
import { resetPlatformBalance } from '../../src/client/balance'
import { resetPlatformCredits } from '../../src/client/platformCredits'
import { flush, mount, text } from './helpers/kit'

/** Renders the seat's state as text so assertions read the values it hands out. */
function Probe(): ReturnType<typeof h> {
  const { balance, credits } = usePlatformBalances()
  return h('span', null,
    'B:' + (balance === null ? 'none' : balance.balances.map(b => b.currency + b.total).join(',')),
    '|C:' + (credits === null ? 'none' : Object.entries(credits).map(([p, c]) => p + '=' + c.total).join(',')),
  )
}

describe('usePlatformBalances', () => {
  beforeEach(() => {
    resetPlatformBalance()
    resetPlatformCredits()
  })

  afterEach(() => {
    resetPlatformBalance()
    resetPlatformCredits()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test('both providers start empty and settle into the route values', async () => {
    vi.stubGlobal('fetch', async (url: unknown) => {
      const target = String(url)
      if (target.includes('/balance')) {
        return { ok: true, json: async () => ({ ok: true, value: { isAvailable: true, balances: [{ currency: 'CNY', total: 38.12, granted: 1.5, toppedUp: 36.62 }] } }) }
      }
      return { ok: true, json: async () => ({ ok: true, value: { workbuddy: { total: 6251, unlimited: false } } }) }
    })
    const m = await mount(h(Probe))
    await flush()
    // Both providers land together; a route that answered would never be papered over with a zero.
    assert.equal(text(m.container), 'B:CNY38.12|C:workbuddy=6251')
    await m.unmount()
  })

  test('a failing read leaves both empty instead of inventing a figure', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const m = await mount(h(Probe))
    await flush()
    assert.equal(text(m.container), 'B:none|C:none')
    await m.unmount()
  })

  test('the poll revalidates on the shared interval and clears it on unmount', async () => {
    vi.useFakeTimers()
    let balanceReads = 0
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (!String(url).includes('/balance')) {
        return { ok: true, json: async () => ({ ok: true, value: null }) }
      }
      balanceReads++
      return { ok: true, json: async () => ({ ok: true, value: { isAvailable: true, balances: [{ currency: 'USD', total: balanceReads, granted: 0, toppedUp: balanceReads }] } }) }
    })
    const m = await mount(h(Probe))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    assert.equal(balanceReads, 1, 'the first read fires on mount')
    assert.equal(text(m.container), 'B:USD1|C:none')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    assert.equal(balanceReads, 2, 'and the interval re-reads')
    assert.equal(text(m.container), 'B:USD2|C:none')
    await m.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    assert.equal(balanceReads, 2, 'an unmounted seat stops polling')
  })
})
