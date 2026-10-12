/**
 * 积分制平台的**按次**费率：`<provider>:<model>` → 每次请求扣多少积分。
 *
 * 与 `thirdPartyRates` 的区别是语义而非形状——那张表是「每 100 万 token 多少美元」，
 * 这张是「每次请求多少积分」。两者都放在 shared，因为 host（读出费率）与 client
 * （显示读数）要用同一个收窄规则。
 *
 * 为什么读平台目录而不是让用户填：积分平台把费率写在它自己的模型目录里
 * （workbuddy 的 `.workbuddy-catalog.json`，`billing.credits`），客户端够不着。
 */

/** 平台目录里一条 `billing.credits` 的两种写法：带 `x` 前缀与 `credits` 后缀。 */
const CREDIT_AMOUNT = /^\s*x?\s*([0-9]+(?:\.[0-9]+)?)\s*(?:credits?)?\s*$/i

/**
 * 解析平台给的积分文案，如 `"x0.11 credits"` → `0.11`。
 *
 * 只接受**能确定是数字**的写法；解析不出来就返回 `null`，调用方据此退回金额路径。
 * 特别地，`free: true` 的模型费率为 0，那是真实取值，不是缺失。
 */
export function creditAmountOf(text: unknown): number | null {
  if (typeof text === 'number') {
    return Number.isFinite(text) && text >= 0 ? text : null
  }
  if (typeof text !== 'string') return null
  const m = CREDIT_AMOUNT.exec(text)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** 收窄成 `provider → model → 每次请求的积分数`。
 *
 *  接受**两种**写入形态，因为这张表的两个来源天然不同：
 *  - 平台目录（host 读出）：已经是 `{ provider: { model: number } }` 的嵌套形状；
 *  - 用户设置：`{ "<provider>:<model>": number }` 的扁平键。
 *
 *  两者都在这里归一：坏项整条丢弃，一行写错不该让整张表失效。 */
export function creditRatesOf(value: unknown): Record<string, Record<string, number>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, Record<string, number>> = {}
  const put = (provider: string, model: string, n: number): void => {
    if (provider === '' || model === '') return
    const models = out[provider] ?? {}
    models[model] = n
    out[provider] = models
  }
  const amount = (raw: unknown): number | null => (
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null
  )
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const at = key.indexOf(':')
    if (at > 0) {
      // 扁平键形态：`<provider>:<model>` → 数值。
      const n = amount(raw)
      if (n !== null) put(key.slice(0, at).trim().toLowerCase(), key.slice(at + 1).trim().toLowerCase(), n)
      continue
    }
    // 嵌套形态：键就是 provider，值再往下一层。
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const provider = key.trim().toLowerCase()
    for (const [model, inner] of Object.entries(raw as Record<string, unknown>)) {
      const n = amount(inner)
      if (n !== null) put(provider, model.trim().toLowerCase(), n)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 查一次请求的积分数；provider 与 model 都忽略大小写，逐字匹配。 */
export function creditRateOf(
  rates: Record<string, Record<string, number>> | null | undefined,
  provider: string,
  model: string,
): number | null {
  if (rates === null || rates === undefined) return null
  const models = rates[provider.trim().toLowerCase()]
  if (models === undefined) return null
  const rate = models[model.trim().toLowerCase()]
  return rate === undefined ? null : rate
}
