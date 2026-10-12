/**
 * 积分制平台的**剩余积分**，供输入框下方那行读数使用。
 *
 * 唯一来源是平台自己的状态路由（workbuddy 的
 * `/plugins/dsh-workbuddy-connect/status`）。它只接受**回环**请求，且要读它自己的
 * 登录凭据打上游——因此只有本机 host 能取，客户端够不着。
 *
 * 取不到时返回 `null`，界面就不显示余额那一截：宁可少一个数字，也不显示一个
 * 过期或编造的额度。
 */

import type { Context } from '@deepseek-ai/cordis'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** 该 reader 认得的响应形状的最小子集；其余字段一概不读。 */
export interface PlatformCredits {
  /** 剩余积分合计；`unlimited` 为真时该值无意义，界面应显示「不限」。 */
  total: number
  unlimited: boolean
  /** 周期重置时间，原样来自上游（可能缺失）。 */
  cycleResetTime?: string
}

/**
 * 两版各有一条余额路由，**必须分别读**：国内版与国际版是两套账号、两个积分池
 * （实测 `…/status` 报 `www.workbuddy.cn` 的额度，`…/ai/status` 报 `www.workbuddy.ai` 的）。
 * 把其中一条的余额贴到另一条的路由上，会让用户看到两行一样的数字——那比不显示更糟。
 */
const CREDITS_ROUTES: readonly { provider: string; url: string }[] = [
  { provider: 'workbuddy', url: 'http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/status' },
  { provider: 'workbuddy-ai', url: 'http://127.0.0.1:19387/plugins/dsh-workbuddy-connect/ai/status' },
]

/** 缓存时长：余额变动不频繁，而每次读取都会让平台去打一次上游。 */
const CACHE_MS = 60_000

/** 只做形状收窄：不可信 wire。`total` 必须是有限非负数，否则整体放弃。 */
export function creditsOfPayload(value: unknown): PlatformCredits | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const root = value as { status?: unknown; credits?: unknown }
  if (root.status !== 'signed-in') return null
  const credits = root.credits
  if (credits === null || typeof credits !== 'object' || Array.isArray(credits)) return null
  const raw = credits as { total?: unknown; unlimited?: unknown; cycleResetTime?: unknown }
  const total = typeof raw.total === 'number' && Number.isFinite(raw.total) && raw.total >= 0
    ? raw.total
    : null
  if (total === null) return null
  return {
    total,
    unlimited: raw.unlimited === true,
    ...typeof raw.cycleResetTime === 'string' && raw.cycleResetTime !== ''
      ? { cycleResetTime: raw.cycleResetTime }
      : {},
  }
}

type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

const defaultFetcher: Fetcher = (url, init) => fetch(url, init) as unknown as ReturnType<Fetcher>

let fetcher: Fetcher = defaultFetcher
/** provider → 该版本的余额；读不到的版本不出现在表里。 */
export type PlatformCreditsTable = Record<string, PlatformCredits>

let cached: { at: number; value: PlatformCreditsTable | null } | null = null

/** 替换 fetcher（供测试用），传 `null` 恢复默认。 */
export function setPlatformCreditsFetcher(next: Fetcher | null): void {
  fetcher = next ?? defaultFetcher
}

/** 丢弃缓存（供测试用）。 */
export function resetPlatformCredits(): void {
  cached = null
}

/** 读**两版各自**的剩余积分；某个版本超时、连接失败、未登录或形状变了，
 *  它就整条缺席——绝不拿另一版的数字顶上。 */
export async function platformCredits(now = Date.now()): Promise<PlatformCreditsTable | null> {
  if (cached !== null && now - cached.at < CACHE_MS) return cached.value
  const table: PlatformCreditsTable = {}
  await Promise.all(CREDITS_ROUTES.map(async ({ provider, url }) => {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(8_000) })
      if (!response.ok) return
      const value = creditsOfPayload(await response.json())
      if (value !== null) table[provider] = value
    } catch { /* 该版本未安装或未登录：它这一条没有余额 */ }
  }))
  const value = Object.keys(table).length > 0 ? table : null
  cached = { at: now, value }
  return value
}

/** 该余额的路由；客户端据此取平台的剩余积分。 */
export const CREDITS_ROUTE = '/api/dsh-cost-breakdown/credits'

/** 挂上余额路由，与 balance 通道同一套注册方式（延迟 inject `connection`）。 */
export function watchPlatformCreditsChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (): Promise<Response> => (
      Response.json({ ok: true, value: await platformCredits() },
        { headers: { 'cache-control': 'no-store' } })
    )
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined,
      CREDITS_ROUTE, handler, 'dsh-cost-breakdown: platform credits route')
  })
}
