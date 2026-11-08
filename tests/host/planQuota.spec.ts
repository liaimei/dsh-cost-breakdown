/**
 * The plan-quota reader: the host calls the vendor's own usage API with the user's key, and every
 * failure is a typed `null` rather than a guessed figure.
 *
 * The cases that matter are the ones where a naive reader would produce a *plausible wrong number*:
 * an unrecognised payload shape, a missing key, a non-ok status, and a window whose ceiling is zero.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  narrowZhipuQuota, planQuotas, resetQuota, setQuotaFetcher,
} from '../../src/host/http/planQuota'
import type { Context } from '@deepseek-ai/cordis'

/** A context stub: only `credentials`, `settings`, and `get` are consulted. */
function contextOf(options: {
  key?: string | null
  env?: string
  settings?: unknown
}): Context {
  return {
    get(name: string) {
      if (name === 'credentials') {
        return {
          resolve: async (ref: string) => (options.key === null ? undefined : { value: options.key ?? 'sk-test' }),
        }
      }
      if (name === 'settings') {
        return { describe: () => options.settings ?? [] }
      }
      return undefined
    },
  } as unknown as Context
}

afterEach(() => {
  resetQuota()
  setQuotaFetcher(null)
})

describe('narrowZhipuQuota', () => {
  it('reads a limits array into used/total windows', () => {
    const windows = narrowZhipuQuota({
      data: { limits: [{ type: '5h', used: 200, total: 2000 }, { type: 'weekly', used: 1000, total: 10000 }] },
    })
    expect(windows).toEqual([
      { label: '5h', total: 2000, used: 200 },
      { label: 'weekly', total: 10000, used: 1000 },
    ])
  })

  it('derives "used" from a remaining figure when the payload reports it that way', () => {
    const windows = narrowZhipuQuota({ limits: [{ type: '5h', remaining: 1500, total: 2000 }] })
    expect(windows?.[0].used).toBe(500)
  })

  it('rejects a shape it does not recognise instead of returning an empty success', () => {
    expect(narrowZhipuQuota({ nope: true })).toBeNull()
    expect(narrowZhipuQuota(null)).toBeNull()
    // A window with no ceiling is not a quota: dropping it leaves nothing.
    expect(narrowZhipuQuota({ limits: [{ type: '5h', used: 1, total: 0 }] })).toBeNull()
  })
})

describe('planQuotas', () => {
  it('serves a readable quota and never leaks the key to the wire', async () => {
    let seenAuth: string | undefined
    setQuotaFetcher(async (_url, init) => {
      seenAuth = init.headers.authorization
      return { ok: true, json: async () => ({ limits: [{ type: '5h', used: 100, total: 2000 }] }) }
    })
    const table = await planQuotas(contextOf({ key: 'sk-secret' }))
    expect(seenAuth).toBe('Bearer sk-secret')
    expect(table?.['zai-coding-cn'].windows[0]).toEqual({ label: '5h', total: 2000, used: 100 })
    expect(JSON.stringify(table)).not.toContain('sk-secret')
  })

  it('returns null when no credential can be resolved', async () => {
    setQuotaFetcher(async () => {
      throw new Error('must not be called without a key')
    })
    expect(await planQuotas(contextOf({ key: null }))).toBeNull()
  })

  it('returns null on a non-ok status or an unrecognised payload', async () => {
    setQuotaFetcher(async () => ({ ok: false, json: async () => ({}) }))
    expect(await planQuotas(contextOf({}))).toBeNull()
    resetQuota()
    setQuotaFetcher(async () => ({ ok: true, json: async () => ({ unexpected: 1 }) }))
    expect(await planQuotas(contextOf({}))).toBeNull()
  })

  it('honours the provider row own credential reference over the built-in default', async () => {
    let resolved: string | undefined
    setQuotaFetcher(async () => ({ ok: true, json: async () => ({ limits: [{ type: '5h', used: 1, total: 10 }] }) }))
    const ctx = {
      get(name: string) {
        if (name === 'credentials') {
          return { resolve: async (ref: string) => { resolved = ref; return { value: 'sk-x' } } }
        }
        if (name === 'settings') {
          return { describe: () => [{ ns: 'zai-coding-cn', value: { apiKeyEnv: 'MY_OWN_KEY' } }] }
        }
        return undefined
      },
    } as unknown as Context
    await planQuotas(ctx)
    expect(resolved).toBe('MY_OWN_KEY')
  })
})
