/**
 * The row configuration schema.
 *
 * Two failure modes matter here and neither is caught by the type checker:
 *   - an omitted field must resolve to its documented default, not arrive as `undefined`;
 *   - the hand-declared rate tables must survive resolution untouched, because the browser half
 *     validates them (a malformed entry is dropped there, not made fatal at load time).
 *
 * Volatile preference fields resolve to the harness's `cosmokit.volatile` binding: read the value
 * through `.get()`, which is also how the plugin reads a live-edited preference.
 */

import { describe, expect, it } from 'vitest'
import { Config, PREFERENCE_KEYS, resolveBounds } from '../../src/host/settings'

/** Resolve a raw row config the way Cordis validates it before `apply` runs. */
function resolve(raw: Record<string, unknown>): Record<string, unknown> {
  return (Config as unknown as (value: Record<string, unknown>) => Record<string, unknown>)(raw)
}

/** Read a resolved preference, whether it is a plain value or a volatile binding. */
function read(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): unknown }).get()
  }
  return value
}

describe('row config schema', () => {
  it('fills the documented defaults for an empty row', () => {
    const value = resolve({})
    expect(value.maxRequestSteps).toBe(1500)
    expect(value.maxKeptTurns).toBe(300)
    expect(read(value.defaultPlacement)).toBe('all')
    expect(read(value.defaultPlanTier)).toBe(0)
    expect(Array.isArray(value.holidays)).toBe(true)
    expect((value.holidays as string[]).length).toBeGreaterThan(0)
  })

  it('forwards hand-declared rate tables untouched', () => {
    const rates = { 'woyao-pro-2:gpt-5': { input: 1, output: 4, cacheRead: 0.5 } }
    const credits = { 'workbuddy:glm-5.3': 2 }
    const value = resolve({ thirdPartyRates: rates, creditRates: credits })
    expect(value.thirdPartyRates).toEqual(rates)
    expect(value.creditRates).toEqual(credits)
  })

  it('resolves the fold bounds without leaking the display preferences into them', () => {
    const bounds = resolveBounds(resolve({ maxNodes: 10, defaultPlacement: 'tab' }))
    expect(bounds.maxNodes).toBe(10)
    expect('defaultPlacement' in bounds).toBe(false)
  })

  it('keeps the preference key list aligned with the schema', () => {
    const value = resolve({})
    for (const key of PREFERENCE_KEYS) expect(read(value[key])).not.toBeUndefined()
    expect(PREFERENCE_KEYS).toContain('defaultPlanTier')
    expect(PREFERENCE_KEYS).not.toContain('defaultDeltaBase' as never)
  })
})
