/**
 * projection 预热：一次性的后台回填遍历，
 * 为每个已存 session 补上`contextActivity` + `contextTimeline` 行，由它唯一的读取方按需触发。
 *
 * session 列表只提供持久缓存行，因此某个单元存在之前就折叠过的 session、
 * 或缓存行版本过期的 session，在下一次活跃前都没有可用行：
 * 热力图一直空白，卡片一直挂着无数据提示。
 * 缓存的冷读阶梯（`sessionProjectionCache.coldSnapshot`）正好补上这个缺口——把已存日志读一次，
 * 用缓存行种入各单元，折叠剩余部分，再把刷新后的 checkpoint 写回。
 *
 * 该遍历在 client 首次打开 Context Insights 页时 POST 触发路由才运行，
 * 而不是启动时：启动即跑会在每次开机时冷读整个语料库，
 * 不管页面是否会被打开。每个进程只跑一次，
 * 并跳过那些自己会折叠的存活 session。
 *
 * 契约上属于可选：延迟 inject、每个接口使用前重新核验、
 * 每个 session 的读取相互隔离——没有 connection 路由或冷路径 service 的部署永远不会武装这次遍历。harness 拒绝迁移的日志属于永久性问题，
 * 其逐 session 明细因此降级到 debug，
 * 遍历以一行汇总 info 收尾。
 */

import { asRecord } from './record'
import type { Context } from '@deepseek-ai/cordis'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** 插件的预热触发路由，位于需要鉴权的 `/api` 栅栏之后。 */
export const BACKFILL_ROUTE = '/api/dsh-cost-breakdown/backfill'

/** 消费到的语料库列表接口。 */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

/** 消费到的缓存两条冷路径方法（运行时重新核验）。 */
interface ProjectionCacheLike {
  cachedSnapshot(meta: SessionHeader, keys?: readonly string[]): unknown
  coldSnapshot(header: SessionHeader, inheritedEventCount: unknown, events: readonly SessionEvent[]): unknown
}

/** 消费到的一个持久化读取句柄。 */
interface ReadHandleLike {
  header: SessionHeader
  inheritedEventCount: unknown
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleLike>
}

/** session 之间的节流：每次冷读都是整份日志解码，持续读取压力下的 host
 * 会拖住自己的 client 握手。 */
const YIELD_MS = 100

/** dsh 对无法解释的持久日志抛出的 `name` 族：持久化接缝把格式边界的拒绝翻译成
 * `SessionFormatUnsupportedError`，因此只按前缀分类，不 import 任何 dsh 符号。 */
const UNSUPPORTED_FORMAT = 'SessionFormatUnsupported'

/** 把一条列表项重新核验成 session header；返回 null 即丢弃该项，
 * 敌意或残缺的列表行因此永远无法种入一次读取。 */
function headerOf(record: unknown): SessionHeader | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header as unknown as SessionHeader
}

/** 预热必须让这两个单元对外可用；两者都存在时，该 session 才算已折叠。 */
const PROBE_KEYS = ['contextActivity', 'contextTimeline']

/** 缓存是否已为该 session 提供两个单元的行，
 * 也就是热路径与本次遍历都可以跳过它。 */
function servesRows(cache: ProjectionCacheLike, header: SessionHeader): boolean {
  try {
    // 未种入的 session 没有继承前缀（切点 0），而已种入 header 的真实切点要到下面读日志时
    // 才知道，因此这里探不中，该 session 会走冷读路径。版本过期的行同样读作缺失；
    // 敌意接口抛出异常也是同样结果。
    const block = asRecord(cache.cachedSnapshot(header, PROBE_KEYS))
    const values = asRecord(block?.values)
    return values !== null
      && values.contextActivity !== undefined
      && values.contextTimeline !== undefined
  } catch {
    return false
  }
}

/** 通过读取句柄读取一份已存日志，对齐 dsh-session-query 的 readColdSessionLog。 */
async function readColdLog(
  persistence: PersistenceLike,
  id: string,
  signal: AbortSignal,
): Promise<{ header: SessionHeader; inheritedEventCount: unknown; events: SessionEvent[] }> {
  const handle = await persistence.open(id, 'read', { signal })
  let events: readonly SessionEvent[]
  try {
    const raw: unknown = await handle.read(0, undefined, { signal })
    // 敌意的持久化结果一律当作空日志，绝不抛错。
    const result = asRecord(raw)?.events
    events = Array.isArray(result) ? result : []
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch { /* 读取失败才是真正要处理的原因 */ }
    throw error
  }
  await handle.close()
  return {
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events, ...interruptedTurnClosers(events)],
  }
}

/** 某个 session 是否存活（它自己会折叠——冷写只会与它自己的 checkpoint
 * 抢写）。注册表读取抛错时也保守地跳过该 session：
 * 宁可留下未折叠的行，也不要覆写一个可能存活的 session。 */
function isLive(sessions: Record<string, unknown> | null, id: string): boolean {
  if (sessions === null || typeof sessions.get !== 'function') return false
  try {
    return (sessions.get as (id: string) => unknown)(id) !== undefined
  } catch {
    return true
  }
}

/** 抛出的错误是否表示日志格式不可读（无法迁移）；按错误「名称」前缀匹配，
 * 因此不必 import 任何 dsh 错误类。 */
function isUnsupportedFormat(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith(UNSUPPORTED_FORMAT)
  } catch {
    return false
  }
}

/** 可打印形式——敌意的 error 可能在自己的 toString 上抛错。 */
function messageOf(error: unknown): string {
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

/** 在触发路由背后武装预热：页面首次打开时路由把 `requested` 置真，
 * 冷路径接口完成装配时设好 `launch`；后到的一方启动这一次遍历。
 * 返回延迟 inject 的 disposer（卸载时中止）。 */
export function watchActivityBackfill(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): () => void {
  let requested = false
  let started = false
  let launch: (() => void) | null = null
  const tryLaunch = (): void => {
    if (!requested || started || launch === null) return
    started = true
    launch()
  }

  const routeFiber = ctx.inject(['connection'], (c) => {
    const handler = () => {
      requested = true
      tryLaunch()
      return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, BACKFILL_ROUTE, handler, 'dsh-cost-breakdown: backfill route')
  })

  const runnerFiber = ctx.inject(['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'], (raw) => {
    const injected = raw as unknown as {
      sessionQuery?: unknown
      sessionProjectionCache?: unknown
      sessionPersistence?: unknown
      sessions?: unknown
    }
    const query = asRecord(injected.sessionQuery)
    const cache = asRecord(injected.sessionProjectionCache)
    const persistence = asRecord(injected.sessionPersistence)
    if (query === null || typeof query.listSessions !== 'function') return
    if (cache === null
      || typeof cache.cachedSnapshot !== 'function'
      || typeof cache.coldSnapshot !== 'function') return
    if (persistence === null || typeof persistence.open !== 'function') return
    const sessions = asRecord(injected.sessions)

    const abort = new AbortController()
    const run = async (): Promise<void> => {
      const listed = await (query as unknown as SessionQueryLike).listSessions(abort.signal)
      if (!Array.isArray(listed)) return
      let folded = 0
      let refused = 0
      let paused = false
      for (const record of listed) {
        if (abort.signal.aborted) return
        const header = headerOf(record)
        if (header === null || typeof header.cwd !== 'string') continue
        if (isLive(sessions, header.id)) continue
        if (servesRows(cache as unknown as ProjectionCacheLike, header)) continue
        try {
          const admitted = await coldReads.admit(async () => {
            const log = await readColdLog(persistence as unknown as PersistenceLike, header.id, abort.signal)
            // 句柄的 header 才是权威（打开时就已确定）；列表里那条只是它的探针。
            ;(cache as unknown as ProjectionCacheLike).coldSnapshot(log.header, log.inheritedEventCount, log.events)
            return true
          })
          if (admitted === undefined) {
            // 压力不会在一个节流间隔内消退，逐 session 重探只会耽误 host 自己的活。
            paused = true
            break
          }
          folded++
        } catch (error: unknown) {
          if (isUnsupportedFormat(error)) {
            // 这属于永久性的源头问题：逐 session 明细降级到
            // debug；下面的汇总才是本次遍历唯一高于 debug 的记录。
            refused++
            ctx.logger.debug(`dsh-cost-breakdown: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          } else {
            ctx.logger.warn(`dsh-cost-breakdown: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          }
        }
        await new Promise(resolve => setTimeout(resolve, YIELD_MS))
      }
      if (folded > 0) ctx.logger.info(`dsh-cost-breakdown: projection rows backfilled for ${folded} session(s)`)
      if (paused) {
        ctx.logger.info('dsh-cost-breakdown: projection backfill stopped early under heap pressure (remaining sessions refold on their next live activity)')
      }
      if (refused > 0) {
        ctx.logger.info(`dsh-cost-breakdown: projection backfill skipped ${refused} session(s) (legacy log format is not migratable; sources left unchanged)`)
      }
    }
    launch = () => {
      void run().catch((error: unknown) => {
        if (!abort.signal.aborted) ctx.logger.warn(`dsh-cost-breakdown: projection backfill stopped early (${messageOf(error)})`)
      })
    }
    tryLaunch()
    return () => { abort.abort() }
  })

  return () => {
    for (const fiber of [routeFiber, runnerFiber]) {
      const handle = fiber as { dispose?: () => unknown } | undefined
      void handle?.dispose?.()
    }
  }
}
