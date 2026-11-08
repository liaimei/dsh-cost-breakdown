/**
 * Subscription-plan maths.
 *
 * These numbers are vendor-published and are what separates "a subscription" from "paying the
 * metered API": a wrong coefficient or a wrong quota unit turns a plan-billed session into a
 * plausible-looking imaginary bill. The tests therefore assert the transcribed figures, not just
 * the shape of the result.
 */

import { describe, expect, it } from 'vitest'
import {
  GLM_CODING, GLM_CODING_INTL, KIMI_CODE, MINIMAX_MPLAN, PLAN_FAMILIES, QWEN_TOKEN_PLAN,
  WEEKS_PER_MONTH, XIAOMI_TOKEN_PLAN, amortisedFeeOf, creditsOfModel, monthlyShareOf, planCoversModel,
  planCreditRateOf, planFamilyOf, planUsageOf, tierAt, tierValueOf, weeklyQuotaOf,
} from '../../src/core/plans'

/** A bucket payload with one column filled. */
function buckets(partial: Partial<{ uncached: number; cacheRead: number; cacheWrite: number; output: number }>) {
  return { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0, ...partial }
}

describe('plan family routing', () => {
  it('recognises every documented route, case- and whitespace-insensitively', () => {
    expect(planFamilyOf('zai-coding-cn')?.id).toBe('glm-coding')
    expect(planFamilyOf(' ZAI-CODING-CN ')?.id).toBe('glm-coding')
    expect(planFamilyOf('zai')?.id).toBe('glm-coding-intl')
    expect(planFamilyOf('minimax-cn')?.id).toBe('minimax-mplan')
    expect(planFamilyOf('kimi-coding')?.id).toBe('kimi-code')
    expect(planFamilyOf('qwen-token-plan')?.id).toBe('qwen-token-plan')
    expect(planFamilyOf('xiaomi-token-plan-sgp')?.id).toBe('xiaomi-token-plan')
  })

  it('returns null for a metered or unknown route', () => {
    expect(planFamilyOf('deepseek-official')).toBeNull()
    expect(planFamilyOf('deepseek-account')).toBeNull()
    expect(planFamilyOf('woyao-pro-2')).toBeNull()
    expect(planFamilyOf('')).toBeNull()
  })

  it('publishes a vendor source and a unique id for every family', () => {
    const ids = PLAN_FAMILIES.map(family => family.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const family of PLAN_FAMILIES) expect(family.source).toMatch(/^https:\/\//)
    for (const family of PLAN_FAMILIES) expect(family.tiers.length).toBeGreaterThan(0)
  })
})

describe('tier selection', () => {
  it('clamps one preference index across families with different tier counts', () => {
    expect(tierAt(GLM_CODING, 0)?.label).toBe('Lite')
    expect(tierAt(GLM_CODING, 1)?.label).toBe('Pro')
    expect(tierAt(GLM_CODING, 2)?.label).toBe('Max')
    expect(tierAt(GLM_CODING, 99)?.label).toBe('Max')
    expect(tierAt(GLM_CODING, -3)?.label).toBe('Lite')
    expect(tierAt(MINIMAX_MPLAN, 1)?.label).toBe('Explore')
  })

  it('returns null for a family with no tiers', () => {
    expect(tierAt({ ...GLM_CODING, tiers: [] }, 0)).toBeNull()
  })
})

describe('model coverage and coefficients', () => {
  it('matches models by prefix, case-insensitively', () => {
    expect(planCoversModel(GLM_CODING, 'glm-5.3')).toBe(true)
    expect(planCoversModel(GLM_CODING, 'GLM-5.3')).toBe(true)
    expect(planCoversModel(GLM_CODING, 'claude-4')).toBe(false)
    expect(planCoversModel(XIAOMI_TOKEN_PLAN, 'mimo-7b')).toBe(true)
  })

  it('takes the longest matching coefficient row', () => {
    // `glm-5.3-flash` starts with `glm-5.3`; the flash column (input 2.3) must win over the base row.
    expect(planCreditRateOf(GLM_CODING, 'glm-5.3')?.input).toBe(6.9)
    expect(planCreditRateOf(GLM_CODING, 'glm-5.3-flash')?.input).toBe(2.3)
    expect(planCreditRateOf(GLM_CODING, 'gpt-5')).toBeNull()
    expect(planCreditRateOf(MINIMAX_MPLAN, 'minimax-m3')).toBeNull()
  })
})

describe('credits one model consumed', () => {
  it('applies the vendor formula per bucket (divide by 10⁴)', () => {
    expect(creditsOfModel(GLM_CODING, 'glm-5.3', buckets({ uncached: 10_000 }), false)).toBeCloseTo(6.9)
    expect(creditsOfModel(GLM_CODING, 'glm-5.3', buckets({ cacheRead: 10_000 }), false)).toBeCloseTo(1.7)
    expect(creditsOfModel(GLM_CODING, 'glm-5.3', buckets({ output: 10_000 }), false)).toBeCloseTo(24)
  })

  it('bills cache writes as ordinary input (the vendor has no separate write column)', () => {
    expect(creditsOfModel(GLM_CODING, 'glm-5.3', buckets({ cacheWrite: 10_000 }), false))
      .toBe(creditsOfModel(GLM_CODING, 'glm-5.3', buckets({ uncached: 10_000 }), false))
  })

  it('applies the off-peak factor only when the family has a peak rule', () => {
    expect(creditsOfModel(GLM_CODING, 'glm-5.3', buckets({ uncached: 10_000 }), true)).toBeCloseTo(3.45)
    // No peak rule on the international family: `offPeak` is not a discount it publishes.
    expect(creditsOfModel(GLM_CODING_INTL, 'glm-5.3', buckets({ uncached: 10_000 }), true)).toBeCloseTo(3.45)
  })

  it('returns null for a model the plan does not meter', () => {
    expect(creditsOfModel(GLM_CODING, 'gpt-5', buckets({ uncached: 10_000 }), false)).toBeNull()
  })
})

describe('credits a ledger consumed', () => {
  it('sums computable models and keeps the uncomputable ones distinguishable', () => {
    const usage = {
      'zai-coding-cn': {
        'glm-5.3': { peak: buckets({ uncached: 10_000 }) },
        'gpt-5': { peak: buckets({ uncached: 10_000 }) },
      },
    }
    const plan = planUsageOf(GLM_CODING, usage)
    expect(plan.any).toBe(true)
    expect(plan.credits).toBeCloseTo(6.9)
    expect(plan.byModel).toEqual([
      { model: 'glm-5.3', credits: expect.closeTo(6.9) },
      { model: 'gpt-5', credits: null },
    ])
  })

  it('folds the period split with the family’s own off-peak factor', () => {
    const usage = { 'zai-coding-cn': { 'glm-5.3': { off: buckets({ uncached: 10_000 }) } } }
    expect(planUsageOf(GLM_CODING, usage).credits).toBeCloseTo(3.45)
  })

  it('ignores routes belonging to another family', () => {
    const usage = { 'glm-coding-intl-route': { 'glm-5.3': { peak: buckets({ uncached: 10_000 }) } } }
    expect(planUsageOf(GLM_CODING, usage)).toMatchObject({ credits: 0, any: false, byModel: [] })
  })
})

describe('quota share and fee amortisation', () => {
  it('states the weekly quota as published', () => {
    expect(weeklyQuotaOf(GLM_CODING.tiers[0])).toBe(10_000)
    expect(weeklyQuotaOf(MINIMAX_MPLAN.tiers[0])).toBeNull()
  })

  it('converts a weekly quota into a monthly share on the Gregorian mean', () => {
    const lite = GLM_CODING.tiers[0]
    expect(WEEKS_PER_MONTH).toBeCloseTo(4.3482)
    expect(monthlyShareOf(10_000, lite)).toBeCloseTo(10_000 / (10_000 * WEEKS_PER_MONTH))
  })

  it('uses a published monthly quota directly when the plan meters by month', () => {
    const qwenLite = QWEN_TOKEN_PLAN.tiers[0]
    expect(qwenLite.creditsMonth).toBe(11_500)
    expect(monthlyShareOf(1_150, qwenLite)).toBeCloseTo(0.1)
  })

  it('refuses to invent a share or a fee for an unpublished quota or price', () => {
    expect(monthlyShareOf(1_000, MINIMAX_MPLAN.tiers[0])).toBeNull()
    expect(amortisedFeeOf(10_000, MINIMAX_MPLAN.tiers[0])).toBeNull()
    const lite = GLM_CODING.tiers[0]
    expect(amortisedFeeOf(10_000, lite)).toBeCloseTo(lite.monthlyCny! * monthlyShareOf(10_000, lite)!)
  })

  it('derives the per-million-CNY value of a tier only when both sides are published', () => {
    const lite = GLM_CODING.tiers[0]
    expect(tierValueOf(lite)).toBeCloseTo(lite.monthlyCny! / (lite.creditsWeek! * WEEKS_PER_MONTH))
    expect(tierValueOf(KIMI_CODE.tiers[0])).toBeNull()
  })
})
