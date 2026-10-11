/** Plugin-info 卡片的惰性版本检查，TTL 1 小时：先问 npm，失败再退到 npmmirror，
 *  同一时刻只发一个请求；所有源都失败则解析为 null。 */

import { PLUGIN_NAME } from './meta'

const REGISTRY_HOSTS = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
]

/** 一小时：长到卡片重挂载不会反复打注册表，短到新发布的版本
 *  能在同一个 session 内显示出来。 */
const TTL_MS = 60 * 60 * 1000

// 缓存里存的是 **Promise** 而非已敲定的版本：TTL 内的每个调用方都并入
// 同一个请求，失败同样会被缓存（它随 TTL 过期，而不是靠重试刷新）。
let cached: { at: number; promise: Promise<string | null> } | null = null

/** 各 host 按列表顺序尝试，同一时刻只有一个在途，因此镜像站是
 *  后备而不是第二个请求。非 ok 状态码、非 JSON 响应体、网络
 *  故障、缺少 `version`，一律解析为 null——永不 reject。 */
function readVersion(host: string): Promise<string | null> {
  return fetch(host + '/' + PLUGIN_NAME + '/latest')
    .then(res => (res.ok ? res.json() as Promise<{ version?: unknown }> : null))
    .then(body => (body !== null && typeof body.version === 'string' ? body.version : null))
    .catch(() => null)
}

/** 解析已发布的版本；没有任何注册表应答时返回 null。永不 reject，
 *  因此卡片渲染「无更新」状态时无需错误分支。 */
export function fetchLatestVersion(): Promise<string | null> {
  // `at` 在**发起请求**时打戳，而不是在敲定时：否则一次长达一小时的在途
  // 抓取会无限延长自己的 TTL。
  if (!cached || Date.now() - cached.at >= TTL_MS) {
    cached = {
      at: Date.now(),
      promise: (async () => {
        for (const host of REGISTRY_HOSTS) {
          const v = await readVersion(host)
          if (v !== null) return v
        }
        return null
      })(),
    }
  }
  return cached.promise
}

/** 数值化的 semver 比较；预发布后缀被丢弃（1.2.0-rc.1 == 1.2.0）。 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/, '').split('-', 1)[0].split('.').map(n => parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  // 短版本对缺失段按 0 比较，因此 `1.2` 与 `1.2.0` 相等。
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x !== y) return x > y
  }
  return false
}
