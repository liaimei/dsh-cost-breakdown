/**
 * 第三方平台的费率表：插件的**唯一**第三方计价权威。
 *
 * 为什么要用户声明而不是插件推断：注册表里同一个模型往往由几十家厂商提供，
 * 价格从免费到数倍不等（`glm-5.3` 有 31 家、`kimi-k3` 有 31 家，费率相差十几倍），
 * 而第三方平台自身通常**不在注册表里**（`workbuddy` 就是如此）。到底用哪家、
 * 按什么价，是用户的部署事实，插件无从推断——猜错会静默给出一个看起来合理的错数字，
 * 比显示「不可定价」糟得多。
 *
 * 键的格式是 `<dsh provider id>:<model id>`，两段都与账本里的键**逐字相同**
 * （格式说明见 `docs/third-party-pricing.md`）。载荷是不可信的 wire 输入，
 * 因此每一项都独立校验，坏项整条丢弃而不是让整张表失效。
 */

import type { PriceTriple } from './types'

/** 一个平台的费率表：模型 id（**保持原样**，比对时忽略大小写）→ 每 100 万 token 的美元费率。 */
export type ThirdPartyRates = Record<string, Record<string, PriceTriple>>

/** 一个 `<provider>:<model>` 键的两段。provider 段可能自身含 `:`（实测的
 *  `workbuddy-ai:` 就带尾冒号），因此按**第一个**冒号切分，
 *  并把 provider 里的尾冒号规整掉。 */
export function splitRateKey(key: string): { provider: string; model: string } | null {
  const at = key.indexOf(':')
  if (at <= 0) return null
  const provider = key.slice(0, at).replace(/:+$/, '').toLowerCase()
  const model = key.slice(at + 1).replace(/^:+/, '').trim().toLowerCase()
  if (provider === '' || model === '') return null
  return { provider, model }
}

/** 非负有限数；其余一律视为缺失。 */
function rateOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 收窄一条费率：`input` 与 `output` 必需，缓存两项缺省时回退到 `input`
 *  （与 `pricesBookOf` 对注册表载荷的既有规则一致）。 */
function tripleOf(value: unknown): PriceTriple | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const rec = value as Record<string, unknown>
  const miss = rateOf(rec.input ?? rec.miss)
  const out = rateOf(rec.output ?? rec.out)
  if (miss === null || out === null) return null
  return {
    hit: rateOf(rec.cacheRead ?? rec.hit) ?? miss,
    miss,
    write: rateOf(rec.cacheWrite ?? rec.write) ?? miss,
    out,
  }
}

/**
 * 收窄设置里的费率表。接受 `{ "<provider>:<model>": {...} }` 形态；
 * 任何键格式不对、或费率不合规的项都跳过，其余照常生效——
 * 一行配置写错不该让整张表失效。
 */
export function thirdPartyRatesOf(value: unknown): ThirdPartyRates | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: ThirdPartyRates = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parts = splitRateKey(key)
    if (parts === null) continue
    const triple = tripleOf(raw)
    if (triple === null) continue
    const models = out[parts.provider] ?? {}
    models[parts.model] = triple
    out[parts.provider] = models
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 查一条用户配置的费率；provider 与 model 都忽略大小写，逐字匹配。 */
export function configuredRateOf(
  rates: ThirdPartyRates | null | undefined,
  provider: string,
  model: string,
): PriceTriple | null {
  if (rates === null || rates === undefined) return null
  const pv = provider.trim().toLowerCase()
  const md = model.trim().toLowerCase()
  for (const [pid, models] of Object.entries(rates)) {
    if (pid !== pv) continue
    for (const [mid, rate] of Object.entries(models)) {
      if (mid === md) return rate
    }
    return null
  }
  return null
}

/** 设置里那份费率表的可读回显（设置界面用），按 provider → model 排序。 */
export function formatRatesForDisplay(rates: ThirdPartyRates | null): string[] {
  if (rates === null) return []
  const lines: string[] = []
  for (const provider of Object.keys(rates).sort()) {
    for (const model of Object.keys(rates[provider]).sort()) {
      const r = rates[provider][model]
      lines.push(`${provider}:${model} → in ${r.miss} / out ${r.out} / read ${r.hit} / write ${r.write}`)
    }
  }
  return lines
}
