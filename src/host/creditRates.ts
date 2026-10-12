/**
 * 从**平台自己的目录**读出按次积分费率，供每轮读数使用。
 *
 * 目前只有一个来源：workbuddy 的 `.workbuddy-catalog.json`（在 Harness home 下）。
 * 它由 workbuddy 的宿主写入并持续刷新，字段 `billing.credits` 形如 `"x0.11 credits"`
 * ——即**每次请求**扣 0.11 积分（它的界面文案就是「积分/次」）。
 *
 * 设计要点：
 * - **读不到就返回 null**，绝不给一个猜的费率。调用方据此退回金额路径。
 * - 文件是别的插件写的，属于不可信输入：版本号、结构、每个字段都自证后才采用，
 *   任何一步不合规都整体放弃，而不是部分采用一个半可信的表。
 * - 一次读取缓存一小段时间：目录是按需刷新的，每帧都读盘没有意义。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { creditAmountOf, creditRatesOf } from '../shared/creditRates'

export type CreditRateTable = Record<string, Record<string, number>>

/** 该 reader 接受的目录格式版本；其他版本整体丢弃。 */
const CATALOG_FORMAT_VERSION = 1

/** workbuddy 目录在 Harness home 下的文件名（与它自己的读取器一致）。 */
const WORKBUDDY_CATALOG_FILENAME = '.workbuddy-catalog.json'

/** workbuddy 的两条 DSH 路由键（实测账本里就是这两个）。 */
const WORKBUDDY_PROVIDERS = ['workbuddy', 'workbuddy-ai'] as const

/** 缓存时长：目录按需刷新，每帧读盘没有意义。 */
const CACHE_MS = 30_000

/** Harness home：与 workbuddy 一致地优先读 `DSH_HOME`，否则用家目录下的 `.dsh`。 */
export function dshHome(): string {
  const env = process.env.DSH_HOME
  return env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
}

/** 从一份已解析的目录载荷里提取费率；结构和字段逐层自证，不合规即整体放弃。 */
export function creditRatesFromCatalog(value: unknown): CreditRateTable | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const root = value as { version?: unknown; entries?: unknown }
  // 版本不认识就整体丢弃：宁可没有读数，也不按猜测的结构读出一张错表。
  if (root.version !== CATALOG_FORMAT_VERSION) return null
  if (root.entries === null || typeof root.entries !== 'object' || Array.isArray(root.entries)) return null

  // 一份目录里有多个账号条目，取**最新抓取**的那份：旧账号的费率可能已经过期。
  let best: { fetchedAtMs: number; models: unknown } | null = null
  for (const raw of Object.values(root.entries as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as { fetchedAtMs?: unknown; models?: unknown }
    const at = typeof entry.fetchedAtMs === 'number' && Number.isFinite(entry.fetchedAtMs) ? entry.fetchedAtMs : -1
    if (!Array.isArray(entry.models)) continue
    if (best === null || at > best.fetchedAtMs) best = { fetchedAtMs: at, models: entry.models }
  }
  if (best === null) return null

  const out: CreditRateTable = {}
  for (const provider of WORKBUDDY_PROVIDERS) out[provider] = {}
  for (const raw of best.models as unknown[]) {
    if (raw === null || typeof raw !== 'object') continue
    const model = raw as { id?: unknown; billing?: unknown }
    if (typeof model.id !== 'string' || model.id === '') continue
    const billing = model.billing
    if (billing === null || typeof billing !== 'object') continue
    const amount = creditAmountOf((billing as { credits?: unknown }).credits)
    // 解析不出来就跳过这一条：它的费率未知，界面应当对它退回金额路径或什么都不显示。
    if (amount === null) continue
    for (const provider of WORKBUDDY_PROVIDERS) out[provider][model.id.toLowerCase()] = amount
  }
  return Object.values(out).some(models => Object.keys(models).length > 0) ? out : null
}

let cached: { at: number; value: CreditRateTable | null } | null = null

/** 读并缓存平台的积分费率；任何失败（文件缺失、JSON 损坏、结构变了）都返回 null。 */
export function platformCreditRates(now = Date.now()): CreditRateTable | null {
  if (cached !== null && now - cached.at < CACHE_MS) return cached.value
  let value: CreditRateTable | null = null
  try {
    const text = readFileSync(join(dshHome(), WORKBUDDY_CATALOG_FILENAME), 'utf8')
    value = creditRatesFromCatalog(JSON.parse(text) as unknown)
  } catch { /* 文件缺失或不可读：没有费率，界面自会退回金额路径 */ }
  cached = { at: now, value }
  return value
}

/** 测试用：清掉缓存。 */
export function resetPlatformCreditRates(): void {
  cached = null
}

/** 把 host 读出的费率并进会话投影。找不到就返回 `undefined`，字段整体缺席。 */
export function creditRatesForWire(): Record<string, Record<string, number>> | undefined {
  return creditRatesOf(platformCreditRates()) ?? undefined
}
