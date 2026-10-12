/**
 * 会话成本估算：为 host 折叠出的累计计费总额定价。
 *
 * DeepSeek 模型用本插件自己的官方人民币价目表
 * （shared/officialRates.ts）计价，按固定的 1 CNY = 0.15 USD 汇率
 * 换算到账面所用的美元空间。这里只保留该价目表的谷时列，
 * 峰时列通过 {@link PEAK_FACTOR} 翻倍得出，官方每一行都恰好满足该关系。
 * 其他厂商用客户端内置的 models.dev 价目表计价；
 * 注册表不认识的 provider id 则走模型侧索引计价。
 */

import type { PriceTriple, SessionCostUsage } from '../shared/types'
import { modelsDevProviderOf, pricedByOfficialPeriod } from '../shared/providers'
import { configuredRateOf, type ThirdPartyRates } from '../shared/thirdPartyRates'
import { matchOfficialModel } from '../shared/officialRates'
import { asRecord, numOf } from './services'

/** 统计格与 composer 停靠区用什么货币渲染；wire 与
 *  所有计算都保持美元，只有显示时换算。 */
export type CostCurrency = 'usd' | 'cny'

/** 固定为官方人民币价目表发布时所用的汇率，不做实时汇率查询，
 *  因此用户看到的数字不会在同一 session 的两次渲染之间漂移。 */
const USD_PER_CNY = 0.15

/** host 把 DeepSeek 峰时窗口按谷时费率的两倍记账；把系数留在这里，
 *  官方价目表每个费率就只需带一列。 */
const PEAK_FACTOR = 2

/* `PriceTriple` 的唯一声明在 shared/types.ts；这里再导出，
   既有 `from './cost'` 的导入路径因此不用改。 */
export type { PriceTriple } from '../shared/types'

/** 注册表结构：provider id → model id → 费率。 */
export type ModelPrices = Record<string, Record<string, PriceTriple>>

/** 一个跨 provider 候选：承载它的 provider（models.dev id）及其费率，
 * 外加它是否为该模型的自有厂商（`primary`）。`mid` 是注册表里的
 * model id 拼写，也就是 tooltip 上列出所依据的面孔。 */
export interface PriceCandidate { pid: string; mid: string; rate: PriceTriple; primary: boolean }

/** 按模型建的索引：小写化后的 model id（精确 id 加上其
 * `-` 后缀尾巴，例如 `kimi-k3` 下的 `k3`）→ 承载它的那些 provider。 */
export interface PriceIndex { byModel: Map<string, PriceCandidate[]> }

/** 解析完成的价目册：原始注册表费率，加上按模型建的索引，
 *  使 provider 分支未收录的 model id 仍能找到价格。 */
export interface ModelBook { prices: ModelPrices; index: PriceIndex }

/** 为一个计费模型定价的结果：tooltip 打印的 provider/model 面孔
 *  以及实际套用的费率。`official` 标明来源是人民币价目表，它只改变
 *  tooltip 的措辞，不改变算式。 */
export interface PriceFace { pid: string; mid: string; rate: PriceTriple; official?: boolean }

/** 把美元数字换算成显示货币；`usd` 原样通过，
 *  这样从未经历过人民币换算的美元数字不会混入取整误差。 */
export function toCurrency(usd: number, currency: CostCurrency): number {
  return currency === 'cny' ? usd / USD_PER_CNY : usd
}

/** {@link toCurrency} 的逆运算，用于**本身就以**人民币报价的数字
 *  （官方价目表）：美元显示时换算，人民币显示时原样呈现。 */
export function fromCny(cny: number, currency: CostCurrency): number {
  return currency === 'cny' ? cny : cny * USD_PER_CNY
}

/**
 * 把官方人民币价目表变成价目册形状的费率，取谷时、换算到美元空间。
 * 缓存写入不单独计费，因此按缓存未命中的费率计价。
 * 官方价目表未收录的模型返回 null，随后改由价目册计价。
 */
export function officialRateOf(model: string): PriceTriple | null {
  const row = matchOfficialModel(model)
  if (row === null) return null
  return { hit: cnyToUsd(row.offPeak.hit), miss: cnyToUsd(row.offPeak.miss), write: cnyToUsd(row.offPeak.miss), out: cnyToUsd(row.offPeak.out) }
}

/** 固定的 CNY→USD 换算，并清掉二进制表示噪声（`4.5 * 0.15`
 *  会舍入成 `0.6749999999999999`）：官方价格最多两位小数，
 *  保留六位已远超真实精度，结果就是价目表所隐含的那个值。 */
function cnyToUsd(cny: number): number {
  return Math.round(cny * USD_PER_CNY * 1e6) / 1e6
}

/** 官方行的展示标签，即官方费率在 tooltip 上列出所依据的面孔。 */
function officialLabel(model: string): string {
  /* v8 ignore next -- 只有经过验证的官方匹配才会走到这里，因此标签必然存在。 */
  return matchOfficialModel(model)?.label ?? model
}

/** 在注册表的浮点噪声范围内比较费率是否相等（同步漂移会打印出 0.125000…003）。 */
function sameRate(a: PriceTriple, b: PriceTriple): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x))
  // 用相对容差而非绝对容差：费率跨了七个数量级。
  return close(a.hit, b.hit) && close(a.miss, b.miss) && close(a.write, b.write) && close(a.out, b.out)
}

function rateOfEntry(value: unknown): PriceTriple | null {
  const v: unknown = value
  if (v === null || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  return num(r.hit) && num(r.miss) && num(r.write) && num(r.out)
    ? { hit: r.hit, miss: r.miss, write: r.write, out: r.out }
    : null
}

/** 在已校验的价目册上构建解析索引。`npmOf` 携带每个
 * provider 的注册表 `npm` 包（缺失时为 null）：`@ai-sdk/<它自己的 id>`
 * 标记一方 provider，而镜像站与网关则挂通用包或外来包。 */
export function priceIndexOf(prices: ModelPrices, npmOf: Record<string, string | null>): PriceIndex {
  const byModel = new Map<string, PriceCandidate[]>()
  const push = (key: string, cand: PriceCandidate): void => {
    const list = byModel.get(key)
    if (list === undefined) byModel.set(key, [cand])
    else if (!list.some(c => c.pid === cand.pid && sameRate(c.rate, cand.rate))) list.push(cand)
  }
  for (const pid of Object.keys(prices)) {
    const branch = branchOf(prices, pid)
    if (branch === null) continue
    const npm: unknown = npmOf[pid]
    // 一方意味着 provider 以自己的 id 发布包（`deepseek` 对应 `@ai-sdk/deepseek`）；
    // 镜像站或网关复用外来包，永远不会是 primary。
    const primary = typeof npm === 'string' && npm.startsWith('@ai-sdk/') && npm.slice('@ai-sdk/'.length) === pid
    for (const mid of Object.keys(branch)) {
      const rate = rateOfEntry(branch[mid])
      if (rate === null) continue
      const lower = mid.toLowerCase()
      const cand: PriceCandidate = { pid, mid, rate, primary }
      push(lower, cand)
      // 每个以 `-` 分隔的**尾段**也会入索引：注册表把某些模型
      // 归入命名空间（`kimi-k3`），而 dsh 用简称（`k3`），尾段正是二者的接合点。
      const parts = lower.split('-')
      for (let i = 1; i < parts.length; i++) push(parts.slice(i).join('-'), cand)
    }
  }
  return { byModel }
}

/** 取费率被最多候选共享的那个候选，打平时返回 null。 */
function majorityCandidate(cands: PriceCandidate[]): PriceCandidate | null {
  const groups: { cand: PriceCandidate; n: number }[] = []
  for (const c of cands) {
    const g = groups.find(g => sameRate(g.cand.rate, c.rate))
    if (g === undefined) groups.push({ cand: c, n: 1 })
    else g.n++
  }
  groups.sort((a, b) => b.n - a.n)
  return groups.length > 1 && groups[0].n === groups[1].n ? null : groups[0].cand
}

function resolveCandidates(lower: string, cands: PriceCandidate[], org: string | null): PriceCandidate | null {
  if (org !== null) {
    // `vendor/model` 式目录：org 段指认厂商，可能是精确名，
    // 也可能是变体 org 背后的注册表 id（`deepseek-ai` → `deepseek`）。
    const named = cands.filter(c => c.pid === org || org.startsWith(c.pid + '-') || (org.length >= 4 && org.startsWith(c.pid)))
    if (named.length > 0) {
      const cand = majorityCandidate(named)
      if (cand !== null) return cand
    }
  }
  const primaries = cands.filter(c => c.primary)
  if (primaries.length > 0) {
    const cand = majorityCandidate(primaries)
    if (cand !== null) return cand
  }
  const prefixed = cands.filter(c => lower.startsWith(c.pid + '-') || lower.startsWith(c.pid + '/'))
  if (prefixed.length > 0) {
    const cand = majorityCandidate(prefixed)
    if (cand !== null) return cand
  }
  return cands.length === 1 ? cands[0] : null
}

/** 在全册范围内解析一个 model id：先试完整 id，再试最后一段 `/` 之后的片段。 */
function resolveRate(index: PriceIndex, model: string): PriceCandidate | null {
  const lower = model.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const org = slash > 0 ? lower.slice(0, slash) : null
  for (const key of slash > 0 ? [lower, lower.slice(slash + 1)] : [lower]) {
    const cands = index.byModel.get(key)
    if (cands === undefined) continue
    const cand = resolveCandidates(key, cands, org)
    if (cand !== null) return cand
  }
  return null
}

function branchOf(book: ModelPrices, id: string): Record<string, PriceTriple> | null {
  const v: unknown = book[id]
  return v !== null && typeof v === 'object' ? (v as Record<string, PriceTriple>) : null
}

/** 一个分支内的查表结果：先试精确的本键（价目册是不可信的 wire
 * 数据），再忽略大小写，最后按 id 后缀——注册表把某些模型
 * 归入命名空间（`kimi-k3`），而 dsh 用简称（`k3`）。若干后缀候选有歧义，此时不计价。 */
function lookupFace(models: Record<string, PriceTriple>, model: string): { mid: string; rate: PriceTriple } | null {
  if (Object.hasOwn(models, model)) return { mid: model, rate: models[model] }
  const m = model.toLowerCase()
  let found: { mid: string; rate: PriceTriple } | null = null
  let seen: string | null = null
  for (const id in models) {
    const lower = id.toLowerCase()
    if (lower !== m && !lower.endsWith('-' + m)) continue
    if (seen !== null && seen !== lower) return null
    seen = lower
    found = { mid: id, rate: models[id] }
  }
  return found
}

/**
 * 单个计费模型的价格与注册表面孔。
 *
 * 官方价目表对它收录的每个模型都优先，无论 provider id 是
 * 什么：它才是本插件存在的意义、权威的人民币价目，否则同一模型的
 * dsh provider id 会按第三方镜像站计价。其余模型
 * 落到价目册：dsh provider id 按 model id 查（精确、忽略大小写
 * 或后缀），而价目册未收录的 provider 则回退到
 * 模型侧索引。
 *
 * 唯一一处厂商级接缝：官方价目表未收录的 `deepseek-` 开头 model id
 * 优先按 DeepSeek 自己的注册表分支计价，因为该分支是带缓存费率的
 * 一方价目册，而模型侧分层可能把同一个 id 交给自称同名的宿主，
 * 后者把缓存命中当作普通输入计费（issue #93）。
 */
export function priceFaceOf(
  book: ModelBook | null | undefined,
  provider: string,
  model: string,
  rates?: ThirdPartyRates | null,
): PriceFace | null {
  const official = officialRateOf(model)
  if (official !== null) {
    return { pid: 'deepseek', mid: officialLabel(model), rate: official, official: true }
  }
  // 用户声明的平台费率优先于注册表：注册表里同一个模型常由几十家厂商提供、
  // 价格相差十几倍，而第三方平台自身往往不在注册表里。用户知道自己的套餐，
  // 插件不知道（规范见 docs/third-party-pricing.md）。
  const configured = configuredRateOf(rates, provider, model)
  if (configured !== null) {
    return { pid: provider, mid: model, rate: configured }
  }
  if (book === null || book === undefined) return null
  const registryPid = modelsDevProviderOf(provider)
  const direct = branchOf(book.prices, registryPid)
  // 已收录 provider 自己的分支是终局：其中未知的模型按 null 计价。
  if (direct !== null) {
    const found = lookupFace(direct, model)
    return found === null ? null : { pid: registryPid, mid: found.mid, rate: found.rate }
  }
  if (model.toLowerCase().startsWith('deepseek-')) {
    const firstParty = branchOf(book.prices, 'deepseek')
    if (firstParty !== null) {
      const officialEntry = lookupFace(firstParty, model)
      if (officialEntry !== null) return { pid: 'deepseek', mid: officialEntry.mid, rate: officialEntry.rate }
    }
  }
  const cand = resolveRate(book.index, model)
  return cand === null ? null : { pid: cand.pid, mid: cand.mid, rate: cand.rate }
}

/** 只查费率——需要注册表面孔的调用方（tooltip 的 provider/model
 *  那一行）应改用 {@link priceFaceOf}，二者必须对「哪一行定价」保持一致。 */
export function priceOf(
  book: ModelBook | null | undefined,
  provider: string,
  model: string,
  rates?: ThirdPartyRates | null,
): PriceTriple | null {
  return priceFaceOf(book, provider, model, rates)?.rate ?? null
}

/** 一次遍历的结果：每个定价时段的美元成本，以及是否有任何费率被套用。 */
export interface CostByPeriod { peak: number; off: number; any: boolean }

/** 一次遍历的结果：四个计费分桶各自的美元成本，加上峰谷拆分与总量。
 *  `total` 恒等于四分桶之和、也恒等于 `peak + off`——三者出自同一次
 *  累加，因此卡片上的任何两个数字都不会互相矛盾。 */
export interface CostByBucket extends CostByPeriod {
  cacheRead: number
  uncached: number
  cacheWrite: number
  output: number
  total: number
}

/** 为一个账本定价，同时给出**两套**拆分：按计费分桶（钱花在哪种
 *  token 上）与按定价时段（钱花在哪段时间）。
 *
 *  费率与峰谷接缝与 {@link estimateSessionCostByPeriod} 完全共用，
 *  后者如今只是取走这里的时段两项——一次遍历产出的数字因此不会
 *  在两张卡片之间漂移。某个桶记录存在即为 `any`（即便全为零），
 *  真正免费的范围因此显示 ¥0.00 而不是破折号。 */
export function estimateSessionCostByBucket(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  rates?: ThirdPartyRates | null,
): CostByBucket {
  const out: CostByBucket = {
    cacheRead: 0, uncached: 0, cacheWrite: 0, output: 0, total: 0,
    peak: 0, off: 0, any: false,
  }
  if (usage === null || usage === undefined) return out
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      // 官方价目表对它所收录的内容是权威；峰值翻倍的时段
      // 走同一处接缝。其余一切按用户的第三方费率（若声明）再按价目册计价。
      const official = officialRateOf(model)
      const rate = official ?? priceOf(book, provider, model, rates)
      const periods = asRecord(models[model])
      if (rate === null || periods === null) continue
      // 桶标签沿用 **host** 的记账规则：只有按官方峰谷计费的结算才拆时段
      // （官方价目表收录的模型，或 DeepSeek 自家路由），因此只有它的 `peak`
      // 桶携带翻倍时段。其他 provider 的 `peak` 桶始终按普通牌价记账。
      const doubles = pricedByOfficialPeriod(provider, model)
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        // 翻倍施加在整段上，所以逐桶同样按比例放大，分桶之和与时段之和才严丝合缝。
        const scale = (doubles && period === 'peak' ? PEAK_FACTOR : 1) / 1e6
        const hit = numOf(bucket.cacheRead) * rate.hit * scale
        const miss = numOf(bucket.uncached) * rate.miss * scale
        const write = numOf(bucket.cacheWrite) * rate.write * scale
        const outCost = numOf(bucket.output) * rate.out * scale
        out.cacheRead += hit
        out.uncached += miss
        out.cacheWrite += write
        out.output += outCost
        out[period] += hit + miss + write + outCost
        out.any = true
      }
    }
  }
  out.total = out.cacheRead + out.uncached + out.cacheWrite + out.output
  return out
}

/** 为一个账本定价，并按 **host** 的定价时段标签拆分。
 *  时段两项取自 {@link estimateSessionCostByBucket}，与分桶拆分同源。 */
export function estimateSessionCostByPeriod(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
): CostByPeriod {
  const { peak, off, any } = estimateSessionCostByBucket(usage, book)
  return { peak, off, any }
}

/** 为 session 的累计计费总额定价。
 *
 * 官方价目表收录的模型在两个时段都按它计价（峰时即该表的
 * 峰时列，也就是谷时费率翻倍），即便注册表价目册从未加载；
 * 其他模型都需要价目册。什么都没能定价时返回 null，
 * 于是单元格可以显示破折号。 */
export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): number | null {
  const { peak, off, any } = estimateSessionCostByPeriod(usage, book)
  return any ? toCurrency(peak + off, currency) : null
}

/** 两个定价时段的计费 prompt+output token 总量，含缓存读写：
 *  即 token 卡片角标与停靠区计数展示的数字，与是否找到价格无关。
 *  没有任何计费时为 0，单元格因此总能依赖一个数字。 */
export function billedTokensOf(usage: SessionCostUsage | null | undefined): number {
  if (usage === null || usage === undefined) return 0
  let total = 0
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        total += numOf(bucket.uncached) + numOf(bucket.cacheRead) + numOf(bucket.cacheWrite) + numOf(bucket.output)
      }
    }
  }
  return total
}

/** 把一份用量的桶累加进 `out`。只要有任何桶记录合并进来
 * 就返回 true（哪怕全为零），估算器因此把它定价为 $0 而不是破折号。 */
function mergeInto(out: SessionCostUsage, usage: SessionCostUsage | null | undefined): boolean {
  if (usage === null || usage === undefined) return false
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null || Array.isArray(models)) continue
    const branch = out[provider] ?? (out[provider] = {})
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) continue
      const target = branch[model] ?? (branch[model] = {})
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null || Array.isArray(bucket)) continue
        const prev = target[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        target[period] = {
          uncached: prev.uncached + numOf(bucket.uncached),
          cacheRead: prev.cacheRead + numOf(bucket.cacheRead),
          cacheWrite: prev.cacheWrite + numOf(bucket.cacheWrite),
          output: prev.output + numOf(bucket.output),
        }
        any = true
      }
    }
  }
  return any
}

/** 把多份 session 成本用量深合并成一份——供统计面板的总成本口径
 * 与 subagent 折叠使用。任何一方都没有桶记录时返回 null。 */
export function mergeCostUsage(...usages: (SessionCostUsage | null | undefined)[]): SessionCostUsage | null {
  const out: SessionCostUsage = {}
  let any = false
  for (const usage of usages) {
    if (mergeInto(out, usage)) any = true
  }
  return any ? out : null
}

/** 低于 $1 时保留两位有效数字，之上则取到分：否则不到一分的
 *  单 session 数字会打印成 `$0.00`。货币符号直接拼接，不做本地化。 */
export function formatCost(amount: number, currency: CostCurrency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  return symbol + (amount >= 1 ? amount.toFixed(2) : amount.toPrecision(2))
}

/** 价目表数字：始终两位小数（tooltip 的 `¥ XX.XX` 费率格式）。 */
export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return (currency === 'cny' ? '¥' : '$') + amount.toFixed(2)
}
