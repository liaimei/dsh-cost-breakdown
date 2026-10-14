/** DeepSeek 开放平台余额背后的客户端读取：上一次打开记住的数字先立即绘制，
 *  随后由插件 `/api/dsh-cost-breakdown/balance` 路由（host/balance.ts）的一次
 *  后台读取校正。没记住、也没返回结果时就什么都不渲染——
 *  读数位置上永远不出现加载动画或错误提示。
 *
 *  读者是费用卡上那一行余额、平台卡的剩余额度与输入框下方的读数；
 *  本模块只负责「读」，不决定它出现在哪个界面。 */

import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { asRecord } from './services'

// host/balance.ts 的余额路由。客户端 bundle 会把每个 import 内联，因此这里重新声明；
// 走同源 POST，位于 harness 受鉴权保护的 `/api` 栅栏之内。
const BALANCE_ROUTE = '/api/dsh-cost-breakdown/balance'

const STORAGE_KEY = 'dsh-cost-breakdown:platform-balance'

/** 本模块消费的 Web storage——`window.localStorage` 满足的那个子集；
 *  测试会换成普通对象。 */
export interface StorageFace {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 测试接缝：替换记住的数字背后的存储；传入 undefined 则重新探测。 */
export function setPlatformBalanceStorage(next: StorageFace | null | undefined): void {
  storage = next
}

/** 记住的数字写入所用的 localStorage 键；存储结构若发生 schema 变更，
 *  直接丢弃而非迁移（见 {@link platformBalanceOf}）。 */
export const PLATFORM_BALANCE_STORAGE_KEY = STORAGE_KEY

/** API 用十进制字符串报金额以保精度；wire 上传来的数值型也接受。
 *  负数或非有限值读作 null，造假条目因此被丢弃而不参与计价。 */
function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** 校验一份余额响应。没有任何条目通过时返回 null，界面据此读作「无可展示」——
 *  与「合法但条目为零的响应」刻意区分开，也正是它让过期的记忆数字
 *  比一行空白更可取。 */
export function platformBalanceOf(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balances) ? data.balances : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // 恶意条目可能在取属性时抛错；它整条丢弃，通过形态校验的条目继续服务。
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const total = amountOf(entry.total)
      const granted = amountOf(entry.granted)
      const toppedUp = amountOf(entry.toppedUp)
      if (typeof currency !== 'string' || currency === ''
        || total === null || granted === null || toppedUp === null) continue
      balances.push({ currency, total, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.isAvailable === true, balances }
    : null
}

/** 展示币种对应的条目，取不到则回退到账户的第一条——别的币种的数字也好过没有。 */
export function balanceEntryOf(
  balance: PlatformBalance | null | undefined,
  currency: 'cny' | 'usd',
): PlatformBalanceEntry | null {
  if (balance === null || balance === undefined || balance.balances.length === 0) return null
  const want = currency === 'cny' ? 'CNY' : 'USD'
  return balance.balances.find(entry => entry.currency === want) ?? balance.balances[0]
}

let cached: PlatformBalance | null = null
/** 正在进行中的路由读取；第二次打开会并入它，而不是另起一次。 */
let refreshing: Promise<void> | null = null
/** 所有搭在本次读取上的打开回调（含并入者）；读取落定后清空，
 *  这样下一次打开会开启全新的读取和全新的回调集合。 */
const landingCallbacks = new Set<(value: PlatformBalance) => void>()

let storage: StorageFace | null | undefined

function storageFn(): StorageFace | null {
  if (storage !== undefined) return storage
  try {
    const found: unknown = globalThis.localStorage
    storage = found === null || found === undefined ? null : found as StorageFace
  } catch {
    // 某些隐私模式下光是访问 storage 就会抛错：此时就没有记住的数字可用。
    storage = null
  }
  return storage
}

function storedBalance(): PlatformBalance | null {
  try {
    const raw = storageFn()?.getItem(STORAGE_KEY)
    return raw === null || raw === undefined ? null : platformBalanceOf(JSON.parse(raw))
  } catch {
    return null
  }
}

function rememberBalance(value: PlatformBalance | null): void {
  try {
    storageFn()?.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // 写入被拒（配额、隐私模式）只损失下一次打开的抢先显示，实时数字照常渲染。
  }
}

/** 一次路由 POST，并经 `platformBalanceOf` 收窄。永不 reject。 */
async function readRoute(): Promise<PlatformBalance | null> {
  try {
    const response = await fetch(BALANCE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    if (!response.ok) return null
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true || r.value === null || r.value === undefined) return null
    return platformBalanceOf(r.value)
  } catch {
    return null
  }
}

/** 每次打开读一次路由，拿到数字后回调 `onRefresh`。`refreshing` 在任何 await 之前
 * 就已赋值，因此中途到来的打开会并入本次读取而不会另起一次，
 * 读取落地后向所有搭车者汇报。读取失败或无结果时不通知任何人，
 * 继续沿用记忆中的数字；返回 `null` 表示暂时无物可展示。 */
export function readPlatformBalance(onRefresh: (value: PlatformBalance) => void): PlatformBalance | null {
  landingCallbacks.add(onRefresh)
  if (refreshing === null) {
    // 缓存值在回调执行之前就已写入，这样由回调触发的另一次打开（比如重渲染）
    // 看到的是新数字而不是旧数字。
    refreshing = (async () => {
      const value = await readRoute()
      if (value === null) return
      cached = value
      rememberBalance(value)
      for (const waiter of landingCallbacks) waiter(value)
    })().finally(() => {
      // `refreshing` 与搭车回调都在 `finally` 里清理，因此即便读取 reject
      // 也不会把标志位挂死；两者都赶在下一次打开发起读取之前完成。
      refreshing = null
      landingCallbacks.clear()
    })
  }
  // 内存中的值优先于存储（它才是本 session 的真值）；存储只是下一次打开时的
  // 抢先量，且只有通过形态校验的值才会被取回来。
  return cached ?? storedBalance()
}

/** 重置模块的全部状态，包括存储探测缓存与已存数字；
 *  供测试以及「设置变更后不得展示过期账户」的场景使用。 */
export function resetPlatformBalance(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
  try {
    storageFn()?.removeItem(STORAGE_KEY)
  } catch {
    /* 没有可丢弃的内容 */
  }
  storage = undefined
}
