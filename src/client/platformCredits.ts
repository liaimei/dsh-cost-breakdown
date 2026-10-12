/**
 * 平台的剩余积分（积分制平台）：客户端侧的读取与记忆。
 *
 * 数字由 host 的路由转发（`/api/dsh-cost-breakdown/credits`），因为只有 host 能访问
 * 平台自己的状态路由——它只接受**回环**请求，且要读平台自己的登录凭据。
 *
 * 读不到时不返回任何值，界面就不显示余额：宁可少一截，也不显示一个过期或编造的额度。
 */

import { asRecord } from './services'

const CREDITS_ROUTE = '/api/dsh-cost-breakdown/credits'

/** 一个版本的余额：剩余积分合计，以及是否不限量。 */
export interface PlatformCredits {
  total: number
  unlimited: boolean
}

/** provider → 该版本的余额（`workbuddy` / `workbuddy-ai`）。
 *  两版是两套账号、两个积分池，因此各存各的——绝不用一版的数字顶另一版。 */
export type PlatformCreditsTable = Record<string, PlatformCredits>

/** 只做形状收窄：不可信 wire。`total` 必须是有限非负数，否则视为无值。 */
export function platformCreditsOf(value: unknown): PlatformCredits | null {
  const r = asRecord(value)
  if (r === null) return null
  const total = r.total
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null
  return { total, unlimited: r.unlimited === true }
}

let cached: PlatformCreditsTable | null = null
let refreshing: Promise<void> | null = null
const landingCallbacks = new Set<(value: PlatformCreditsTable) => void>()

/** 一次路由 POST，并经 `platformCreditsOf` 收窄。永不 reject。 */
async function readRoute(): Promise<PlatformCreditsTable | null> {
  try {
    const response = await fetch(CREDITS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    if (!response.ok) return null
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true) return null
    // wire 上是 provider → 余额；逐条收窄，坏项丢掉而不牵连其它版本。
    const raw = asRecord(r.value)
    if (raw === null) return null
    const out: PlatformCreditsTable = {}
    for (const [provider, value] of Object.entries(raw)) {
      const one = platformCreditsOf(value)
      if (one !== null) out[provider] = one
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

/** 读一次余额，拿到后回调 `onRefresh`；与 balance 同一套「搭车」语义：
 *  进行中的读取不会被重复发起，失败时不通知任何人（沿用上一次的数字）。
 *  返回记忆中的值，供首帧直接渲染。 */
export function readPlatformCredits(onRefresh: (value: PlatformCreditsTable) => void): PlatformCreditsTable | null {
  landingCallbacks.add(onRefresh)
  if (refreshing === null) {
    refreshing = (async () => {
      const value = await readRoute()
      if (value === null) return
      cached = value
      for (const waiter of landingCallbacks) waiter(value)
    })().finally(() => {
      refreshing = null
      landingCallbacks.clear()
    })
  }
  return cached
}

/** 重置模块状态（供测试用）。 */
export function resetPlatformCredits(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
}
