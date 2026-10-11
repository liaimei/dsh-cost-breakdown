/**
 * 客户端的模型价目册：经由官方 @opencode-ai/models SDK 取 models.dev
 * 注册表。载荷是不可信的 wire 输入，因此 `pricesBookOf` 会重新校验
 * 每个字段，不合规的条目整条丢弃。每次页面加载抓取一次，首个订阅
 * 时触发；失败会显示可见状态并退避重试，
 * 绝不出现加载动画或未处理的 rejection。
 */

import { Models } from '@opencode-ai/models'
import { useSyncExternalStore } from 'react'
import { asRecord } from './services'
import { priceIndexOf } from './cost'
import type { ModelBook, ModelPrices, PriceTriple } from './cost'

function rateOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 从下发的 providers 载荷（`/api.json`）中提取注册表按模型计的美元费率，
 * 并在其上构建解析索引。任何形态错误都跳过该条目；
 * 载荷不是记录时返回 null（视为抓取失败）。 */
export function pricesBookOf(value: unknown): ModelBook | null {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return null
  const book: ModelPrices = {}
  const npmOf: Record<string, string | null> = {}
  for (const providerId of Object.keys(data)) {
    const provider = asRecord(data[providerId])
    if (provider === null) continue
    const modelList = asRecord(provider.models)
    if (modelList === null) continue
    const npm: unknown = provider.npm
    npmOf[providerId] = typeof npm === 'string' ? npm : null
    const models: Record<string, PriceTriple> = {}
    for (const id of Object.keys(modelList)) {
      const model = asRecord(modelList[id])
      const cost = model !== null ? asRecord(model.cost) : null
      if (cost === null) continue
      const miss = rateOf(cost.input)
      const out = rateOf(cost.output)
      if (miss === null || out === null) continue
      models[id] = {
        hit: rateOf(cost.cache_read) ?? miss,
        miss,
        write: rateOf(cost.cache_write) ?? miss,
        out,
      }
    }
    if (Object.keys(models).length > 0) book[providerId] = models
  }
  return { prices: book, index: priceIndexOf(book, npmOf) }
}

/** 价目册，外加**上一轮**是否失败；`failed` 驱动可见的重试提示。它
 *  刻意不是加载标志——价目册只抓取一次，后续失败绝不会把它清成 null，
 *  因此重试也不会让卡片变空白。 */
export interface ModelPricesSnap {
  book: ModelBook | null
  failed: boolean
}

type Loader = () => Promise<unknown>

const defaultLoader: Loader = () => Models.make().providers()

const RETRY_BASE_MS = 30_000

let loader: Loader = defaultLoader
let snap: ModelPricesSnap = { book: null, failed: false }
let inFlight = false
let failures = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function fail(): void {
  // fail() 每个抓取周期只执行一次（只有 fire() 会调它，而定时器已
  // 武装时 fire() 的两个调用方都被挡住），因此重新武装也不会泄漏。
  // 重试按**失败次数**指数退避，最多翻三倍（8×），长时间
  // 故障因此稳定在两次尝试间隔约 4 分钟，而不会无限增长。
  snap = { ...snap, failed: true }
  failures++
  timer = setTimeout(() => {
    timer = null
    // 已经没人读价目册了（订阅它的面板已不在）：结束这个周期，
    // 而不是在整个页面生命周期里轮询一个不可达的注册表。
    if (listeners.size === 0) return
    void fire()
  }, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 3))
}

async function fire(): Promise<void> {
  inFlight = true
  try {
    const book = pricesBookOf(await loader())
    if (book !== null) {
      snap = { book, failed: false }
      failures = 0
    } else {
      fail()
    }
  } catch {
    fail()
  }
  inFlight = false
  for (const fn of listeners) fn()
}

function kick(): void {
  if (snap.book !== null || inFlight || timer !== null) return
  void fire()
}

/** React 座位。它同时充当抓取触发器：第一个订阅者会触发加载，
 *  因此从不打开计价卡片的部署永远不会请求注册表。 */
export const subscribeModelPrices = (fn: () => void): (() => void) => {
  listeners.add(fn)
  kick()
  return () => {
    listeners.delete(fn)
  }
}

/** 供 `useSyncExternalStore` 比较的引用稳定快照；只有价目册或
 *  失败标志真正变化时该对象才会被替换。 */
export const getModelPricesSnap = (): ModelPricesSnap => snap

/** 统计面板对价目册的读取。 */
export function useModelPrices(): ModelPricesSnap {
  return useSyncExternalStore(subscribeModelPrices, getModelPricesSnap)
}

/** 丢弃价目册、退避状态与全部监听者；供测试以及「切换配置后不得
 *  按另一个账户的注册表计价」的场景使用。清空监听者意味着之后的
 *  订阅会触发一次全新抓取，而不是复活本周期。 */
export function resetModelPrices(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  snap = { book: null, failed: false }
  inFlight = false
  failures = 0
  listeners.clear()
}

/** 注册表抓取的测试接缝；传 null 恢复为 models.dev SDK 的加载器。 */
export function setModelPricesLoader(next: Loader | null): void {
  loader = next ?? defaultLoader
}
