/**
 * DeepSeek 开放平台「余额」
 * 路由——成本统计页顶栏胶囊与输入区 dock 读数背后的数据（client/balance.ts）。
 *
 * 两个来源，按此顺序尝试：
 *
 * 1. harness「自身」的账号登录（`ctx.deepseekAccount`），
 * 无需密钥。登录 DSH 的用户就是按这条计费的，
 * 该 service 会分别报告赠送钱包和充值钱包。 2. DeepSeek API-key provider，
 * 用于没有上述 service 的部署：
 * 从 provider 的设置行（读自 Config 表单 projection）
 * 取凭证引用和端点覆盖，再由 credentials service 解析出密钥。
 *
 * 无论哪条路，
 * 密钥都不会流到浏览器：host 读取后只提供脱敏数字。service 或事实缺失时返回类型化的 `null`，
 * 读取失败或格式错误也一样——这些界面宁可不渲染，也不显示过期数字。
 *
 * 传输走 Connection 的 fetch 路由注册表，通过延迟 inject 完成，
 * 因此加载顺序无关紧要，没有该注册表的 harness 干脆不会武装这条路由。
 */

import { asRecord } from './record'
import type { Context } from '@deepseek-ai/cordis'
import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** 插件的 balance 路由，位于需要鉴权的 `/api` 栅栏之后。 */
export const BALANCE_ROUTE = '/api/dsh-cost-breakdown/balance'

/** DeepSeek API-key provider 提供其设置分区所用的 settings id，优先于它的条目名。 */
const DEEPSEEK_SETTINGS_NS = 'llm-deepseek'

/** DeepSeek 平台的公开 API 根地址（`GET /user/balance`）。 */
const PUBLIC_BASE_URL = 'https://api.deepseek.com'

/** 平台读取的硬性上限：胶囊宁可不渲染，也不把页面挂住。 */
const FETCH_TIMEOUT_MS = 10_000

/** harness `settings` service：对外只用 Config 表单的 `describe()` projection 这一个接口。 */
interface SettingsHostFace {
  describe?(): unknown
}

interface CredentialsHostFace {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>
}

/** 本路由用到的 harness 自身账号登录（`ctx.deepseekAccount`）。 */
interface AccountHostFace {
  getState?(): Promise<unknown>
  getBalance?(client: unknown): Promise<unknown>
}

/** 重新核验一个平台金额：平台会把部分数字以十进制「字符串」下发，而负数或非有限值不算数；
 * 返回 null 即丢弃该钱包，而不是渲染一个错误数字。 */
function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** 账号 service 转发给平台的客户端元数据：固定的版本/语言环境，加上本机相对 UTC
 * 「东向」的偏移量，由计算得出而非假定。 */
function clientMetadata(): Record<string, unknown> {
  return {
    version: '1',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

/** 把一份钱包列表折叠成按币种归并的条目，并标记它属于拆分出的哪一半。
 * 形状不成立的钱包整条丢弃；留下的条目累加到自己币种的总额上。 */
function addWallets(
  into: Map<string, PlatformBalanceEntry>,
  wallets: unknown,
  field: 'granted' | 'toppedUp',
): void {
  for (const wallet of Array.isArray(wallets) ? wallets : []) {
    try {
      const entry = asRecord(wallet)
      if (entry === null) continue
      const amount = amountOf(entry.balance)
      if (typeof entry.currency !== 'string' || entry.currency === '' || amount === null) continue
      const current = into.get(entry.currency) ?? { currency: entry.currency, total: 0, granted: 0, toppedUp: 0 }
      current[field] += amount
      current.total += amount
      into.set(entry.currency, current)
    } catch {
      continue
    }
  }
}

/** 从 DSH 自身的账号登录读取余额；service 缺失、账号已登出或读取失败时返回 null，
 * 调用方因此回落到 API-key provider。 */
async function readWithAccount(ctx: Context): Promise<PlatformBalance | null> {
  const account = ctx.get('deepseekAccount') as AccountHostFace | undefined
  const getBalance = typeof account?.getBalance === 'function' ? account.getBalance.bind(account) : undefined
  if (getBalance === undefined) return null
  try {
    if (typeof account?.getState === 'function') {
      const state = asRecord(await account.getState())
      if (state?.status === 'signed-out') return null
    }
  } catch {
    /* 状态探测失败并不等于结论：下面的余额读取会给出自己的结果。 */
  }
  try {
    const outcome = asRecord(await getBalance(clientMetadata()))
    if (outcome === null || outcome.status !== 'ready') return null
    // 该 service 按结构拆分钱包：`value` 是充值（topped-up）
    // 的那些，`bonusWallets` 是赠送的那些，
    // 因此控制台展示的明细能原样传到 UI。
    const byCurrency = new Map<string, PlatformBalanceEntry>()
    addWallets(byCurrency, outcome.value, 'toppedUp')
    addWallets(byCurrency, outcome.bonusWallets, 'granted')
    const balances = [...byCurrency.values()]
    return balances.length > 0 ? { isAvailable: true, balances } : null
  } catch {
    return null
  }
}

interface DeepSeekFacts { baseUrl: string; apiKey: string }

/** DeepSeek API-key provider 的设置分区，从 Config 表单的 `describe()` projection 折叠而来：
 * 它的行声明顶层 `apiKeyEnv` 凭证引用，这是只有该 provider 才会声明的形状。
 * 各行独立折叠——敌意行整条丢弃，其余有效行照常。 */
function deepseekSectionOf(ctx: Context): Record<string, unknown> | null {
  const settings = ctx.get('settings') as SettingsHostFace | undefined
  if (typeof settings?.describe !== 'function') return null
  try {
    const rows = settings.describe()
    if (!Array.isArray(rows)) return null
    let shaped: Record<string, unknown> | null = null
    for (const row of rows) {
      try {
        const record = asRecord(row)
        if (record === null) continue
        const value = asRecord(record.value)
        if (value === null || typeof value.apiKeyEnv !== 'string' || value.apiKeyEnv === '') continue
        if (record.ns === DEEPSEEK_SETTINGS_NS || record.ns === 'llm-deepseek-api-key') return value
        shaped ??= value
      } catch {
        continue
      }
    }
    return shaped
  } catch {
    return null
  }
}

/** 解析该 provider 实际发请求所用的连接事实；任一事实缺失时返回 `null`。 */
async function resolveFacts(ctx: Context): Promise<DeepSeekFacts | null> {
  const section = deepseekSectionOf(ctx)
  if (section === null) return null
  const apiKeyEnv = section.apiKeyEnv as string
  const baseUrl = typeof section.baseURL === 'string' && section.baseURL !== ''
    ? section.baseURL
    : PUBLIC_BASE_URL
  const credentials = ctx.get('credentials') as CredentialsHostFace | undefined
  const resolve = typeof credentials?.resolve === 'function' ? credentials.resolve.bind(credentials) : undefined
  if (resolve === undefined) return null
  let hit: { value?: unknown } | undefined
  try {
    hit = await resolve(apiKeyEnv)
  } catch {
    return null
  }
  const apiKey = typeof hit?.value === 'string' ? hit.value : ''
  return apiKey === '' ? null : { baseUrl, apiKey }
}

/** 把平台 payload 收窄成 wire 值：总额由两个重新核验过的分项相加而来，
 * 以界面自己的算术为准。形状不成立的条目整条丢弃，
 * 没有任何有效条目的 payload 就等于没有余额。 */
export function balanceOfPayload(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // 敌意条目可能在读取属性时抛错；整条丢弃。
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const granted = amountOf(entry.granted_balance)
      const toppedUp = amountOf(entry.topped_up_balance)
      if (typeof currency !== 'string' || currency === ''
        || granted === null || toppedUp === null) continue
      balances.push({ currency, total: granted + toppedUp, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.is_available === true, balances }
    : null
}

type BalanceFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: BalanceFetcher = (url, init) => fetch(url, init)

let fetcher: BalanceFetcher = defaultFetcher

/** 替换平台 fetcher（供测试用），传 `null` 则恢复默认。 */
export function setBalanceFetcher(next: BalanceFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let inFlight: Promise<PlatformBalance | null> | null = null

/** 丢弃共享的进行中读取（供测试用），让下一次请求真的发一次 fetch。 */
export function resetBalance(): void {
  inFlight = null
}

/** 针对这组事实的一次平台读取，与已在途的相同读取共享；不做任何记忆，
 * 因为余额会随每个计费请求变化。所有失败路径——传输、超时、非 ok 状态、格式错误的 payload
 * ——都 resolve 出 `null`。 */
async function readBalance(facts: DeepSeekFacts): Promise<PlatformBalance | null> {
  if (inFlight !== null) return inFlight
  inFlight = (async () => {
    let value: PlatformBalance | null = null
    try {
      const response = await fetcher(facts.baseUrl.replace(/\/+$/, '') + '/user/balance', {
        headers: { accept: 'application/json', authorization: 'Bearer ' + facts.apiKey },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (response.ok) value = balanceOfPayload(await response.json())
    } catch {
      // 任何失败都返回 null——胶囊保持不显示。
    }
    return value
  })()
  const settled = inFlight
  try {
    return await settled
  } finally {
    // 有 `inFlight !== null` 这层守卫，已结算的读取只会清掉它自己的那一份值。
    inFlight = null
  }
}

/** connection service 一装配好就提供 balance 路由；注册随被注入的 fiber 走，
 * 因此卸载时会一并撤下。 */
export function watchBalanceChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {

    const handler = async (): Promise<Response> => {
      // 先走账号登录：登录用户就是按这条计费的，而且不需要密钥。
      // 账号已登出或缺失时再落到 provider。
      let value = await readWithAccount(ctx)
      if (value === null) {
        const facts = await resolveFacts(ctx)
        value = facts !== null ? await readBalance(facts) : null
      }
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
    }

    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, BALANCE_ROUTE, handler, 'dsh-cost-breakdown: balance route')
  })
}
