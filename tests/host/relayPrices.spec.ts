/**
 * The relay price reader: the vendor publishes per-token decimals plus a multiplier, and this module
 * scales them into the plugin's "USD per million tokens" vocabulary.
 *
 * The cases that matter are the ones where a naive reader reports a plausible wrong number: the
 * per-token → per-million scale, a missing cache column (not free), an image row (no token rate at
 * all), and a failed read (must not look like "these models are free").
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  relayPriceOf, relayPriceTableOf, relayPrices, resetRelayPrices, setRelayFetcher,
} from '../../src/host/http/relayPrices'

/** One vendor row, shaped like the live payload. */
const sol = {
  model: 'gpt-5.6-sol',
  platform: 'openai',
  group: 'GPT Pro',
  rate_multiplier: 0.3,
  billing_mode: 'token',
  input_price: 5e-06,
  output_price: 3e-05,
  cache_write_price: 6.25e-06,
  cache_read_price: 5e-07,
  per_request_price: null,
  image_output_price: 0,
  intervals: [{ min_tokens: 272000, max_tokens: null, per_request_price: null, input_price: 1e-05, output_price: 4.5e-05 }],
}

afterEach(() => {
  resetRelayPrices()
  setRelayFetcher(null)
})

describe('relayPriceOf', () => {
  it('scales per-token decimals into USD per million tokens', () => {
    const price = relayPriceOf(sol)
    // 5e-06 per token is $5 per million — the figure the vendor's own page prints.
    expect(price?.input).toBeCloseTo(5, 9)
    expect(price?.output).toBeCloseTo(30, 9)
    expect(price?.cacheRead).toBeCloseTo(0.5, 9)
    expect(price?.cacheWrite).toBeCloseTo(6.25, 9)
    expect(price?.multiplier).toBe(0.3)
    expect(price?.mode).toBe('token')
  })

  it('keeps the long-context tiers the vendor prices separately', () => {
    expect(relayPriceOf(sol)?.tiers?.[0]).toEqual({ minTokens: 272000, input: 10, output: 45 })
  })

  it('leaves an omitted cache column absent rather than zero', () => {
    // Zero would claim cache reads are free; absent lets the pricing path fall back to the input rate.
    const price = relayPriceOf({ model: 'm', billing_mode: 'token', input_price: 1e-06, output_price: 2e-06 })
    expect(price?.cacheRead).toBeUndefined()
    expect(price?.input).toBeCloseTo(1, 9)
  })

  it('drops an image row that publishes no per-image price', () => {
    expect(relayPriceOf({ model: 'gpt-image-2', billing_mode: 'image', per_request_price: null, image_output_price: 0 })).toBeNull()
  })

  it('reads an image row that does publish one', () => {
    const price = relayPriceOf({ model: 'gpt-image-2.5', billing_mode: 'image', per_request_price: 0.1 })
    expect(price?.mode).toBe('image')
    expect(price?.perImage).toBe(0.1)
  })

  it('drops a row with no model id or no price at all', () => {
    expect(relayPriceOf({ billing_mode: 'token', input_price: 1e-06 })).toBeNull()
    expect(relayPriceOf({ model: 'm', billing_mode: 'token' })).toBeNull()
    expect(relayPriceOf(null)).toBeNull()
  })
})

describe('relayPriceTableOf', () => {
  it('indexes by model id and skips bad rows without dropping the rest', () => {
    const table = relayPriceTableOf({ data: [sol, { model: 'bad' }, { model: 'ok', billing_mode: 'token', input_price: 1e-06, output_price: 2e-06 }] })
    expect(Object.keys(table?.relays.woyao ?? {})).toEqual(['gpt-5.6-sol', 'ok'])
  })

  it('returns null for a payload with no usable row', () => {
    expect(relayPriceTableOf({ data: [] })).toBeNull()
    expect(relayPriceTableOf({ nope: true })).toBeNull()
  })
})

describe('relayPrices', () => {
  it('serves the fetched table', async () => {
    setRelayFetcher(async () => ({ ok: true, json: async () => ({ data: [sol] }) }))
    const table = await relayPrices()
    expect(table?.relays.woyao['gpt-5.6-sol'].input).toBeCloseTo(5, 9)
  })

  it('reports null — not an empty free table — when the read fails', async () => {
    setRelayFetcher(async () => ({ ok: false, json: async () => ({}) }))
    expect(await relayPrices()).toBeNull()
  })

  it('keeps the last good table when a later read fails', async () => {
    setRelayFetcher(async () => ({ ok: true, json: async () => ({ data: [sol] }) }))
    await relayPrices()
    resetRelayPrices()
    // Prime the cache, then make the transport fail and force a re-read past the TTL.
    setRelayFetcher(async () => ({ ok: true, json: async () => ({ data: [sol] }) }))
    const good = await relayPrices(1_000)
    setRelayFetcher(async () => ({ ok: false, json: async () => ({}) }))
    const afterFailure = await relayPrices(1_000 + 11 * 60_000)
    expect(good).not.toBeNull()
    expect(afterFailure).toEqual(good)
  })
})

describe('the published price already includes the multiplier', () => {
  it('does not re-apply rate_multiplier to the quoted prices', () => {
    // Verified against the vendor's own page: gpt-5.6-sol is `0.3x` and `输入 $5/M` — the $5 is final.
    // Applying 0.3 again would report $1.50 and under-count every relay cost by 3.3x.
    const price = relayPriceOf({
      model: 'gpt-5.6-sol',
      rate_multiplier: 0.3,
      billing_mode: 'token',
      input_price: 5e-06,
      output_price: 3e-05,
    })
    expect(price?.input).toBeCloseTo(5, 9)
    expect(price?.output).toBeCloseTo(30, 9)
    // The multiplier is still carried, so the UI can show "0.3x" beside the figure.
    expect(price?.multiplier).toBe(0.3)
  })
})
