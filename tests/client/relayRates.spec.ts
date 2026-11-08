/**
 * Turning the relay's published table into the plugin's rate vocabulary.
 *
 * The precedence rule is the point: the relay's own table is the default, and a user-declared rate
 * wins per model (their group multiplier is authoritative).
 */

import { describe, expect, it } from 'vitest'
import { quadOfRow, relayRatesOf, relayTableOf } from '../../src/client/data/relayPrices'

const wire = {
  relays: {
    woyao: {
      'gpt-5.6-sol': { model: 'gpt-5.6-sol', mode: 'token', input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
      'gpt-image-2.5': { model: 'gpt-image-2.5', mode: 'image' },
    },
  },
}

describe('relayTableOf', () => {
  it('narrows a wire table', () => {
    const table = relayTableOf(wire)
    expect(table?.woyao['gpt-5.6-sol'].input).toBe(5)
  })

  it('rejects a shape it does not recognise', () => {
    expect(relayTableOf(null)).toBeNull()
    expect(relayTableOf({ relays: [] })).toBeNull()
    expect(relayTableOf({ relays: { woyao: {} } })).toBeNull()
  })
})

describe('quadOfRow', () => {
  it('builds a rate quadruple, caching falling back to input', () => {
    expect(quadOfRow({ model: 'm', mode: 'token', input: 2, output: 8 })).toEqual({ hit: 2, miss: 2, write: 2, out: 8 })
  })

  it('refuses an image row: it has no per-token rate', () => {
    expect(quadOfRow({ model: 'img', mode: 'image' })).toBeNull()
  })
})

describe('relayRatesOf', () => {
  it('publishes the relay rates when the user declared none', () => {
    const rates = relayRatesOf(relayTableOf(wire), null)
    expect(rates?.woyao['gpt-5.6-sol'].miss).toBe(5)
    // The image row has no token rate, so it must not appear as a free model.
    expect(rates?.woyao['gpt-image-2.5']).toBeUndefined()
  })

  it('lets a user-declared rate win over the relay default', () => {
    const declared = { woyao: { 'gpt-5.6-sol': { hit: 0.1, miss: 1, write: 1, out: 4 } } }
    const rates = relayRatesOf(relayTableOf(wire), declared)
    expect(rates?.woyao['gpt-5.6-sol'].miss).toBe(1)
    expect(rates?.woyao['gpt-5.6-sol'].out).toBe(4)
  })

  it('returns null when neither source has a rate', () => {
    expect(relayRatesOf(null, null)).toBeNull()
  })
})

describe('publishing a relay table under its account rows', () => {
  it('resolves the same prices under every woyao-* row the ledger bills', () => {
    // A rate lookup is an exact match and the relay publishes one list for all its account rows, so the
    // table has to be published under `woyao-pro-1` / `woyao-pro-2` as well as `woyao` — otherwise the
    // relay keeps reporting "no rate configured" while the prices sit right there.
    const rates = relayRatesOf(relayTableOf(wire), null, ['woyao-pro-1', 'woyao-pro-2'])
    expect(rates?.woyao['gpt-5.6-sol'].miss).toBe(5)
    expect(rates?.['woyao-pro-1']?.['gpt-5.6-sol'].miss).toBe(5)
    expect(rates?.['woyao-pro-2']?.['gpt-5.6-sol'].miss).toBe(5)
  })

  it('does not invent a branch for an unrelated route', () => {
    const rates = relayRatesOf(relayTableOf(wire), null, ['deepseek-official', 'woyao-pro-3'])
    expect(rates?.['deepseek-official']).toBeUndefined()
    // A row of the same relay still gets it, even if the table was read before that row existed.
    expect(rates?.['woyao-pro-3']?.['gpt-5.6-sol'].miss).toBe(5)
  })
})
