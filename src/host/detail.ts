/**
 * 拆分 `contextTimeline` 世代里按需拉取的 DETAIL 路由。
 *
 * projection 的 wire 值是瘦身 head（fold.ts 的 `buildTimelineHead`）；
 * 沉重集合改由「这里」提供——每个正在查看的 client 各读一次，
 * 且只在它的 Context 标签页或 /context 弹窗打开时读，
 * 而不是整份挂在每一行 session.list 和每一帧推送上。
 *
 * 传输走 Connection 的精确 Fetch 路由注册表（`ctx.connection.fetch.register`），
 * 与 harness 的文件上传、媒体引用路由挂载在同一道接缝上，
 * 位于需要鉴权的 `/api` 栅栏之后。存活 session 的 state 直接从注册表的 `stateOf` 取（不做第二次 fold）；
 * 只被冷看过的 session 则通过 `ctx.sessionQuery` 观察，
 * 并从 init 起折叠其不可变日志。其他情况一律解析为类型化的 `null`。
 *
 * 绝不假设加载顺序：connection + sessions 上的嵌套 `ctx.inject` 让路由即使面对更晚激活的 service 也能武装；
 * 返回的闸门每次服务都重新读
 * 取，wire 世代因此随路由一起翻转。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import { buildTimelineDetail } from './foldWire'

/** 插件的 detail 路由，位于需要鉴权的 `/api` 栅栏之后。 */
export const DETAIL_ROUTE = '/api/dsh-cost-breakdown/detail'

/** detail 通道的存活标记，时间线单元的 view 每次服务都会读：路由已注册时为 true，
 * connection/sessions service 卸载后为 false。 */
export interface DetailChannelGate {
  readonly live: boolean
}

/** 路由用到的 host `sessions` service 形态（严格全局读取的写法）。 */
interface SessionsHostFace {
  get?(id: string): unknown
}

/** 预先准备的 observation 读取，用来折叠一个只被冷看过的 session。 */
interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

/** 在响应上禁用存储：detail 是实时快照，任何缓存都可能提供过期版本。 */
function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

/** wire 上类型化的失败信封；client 按 `code` 索引对应的错误文案。 */
function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

/** connection 与 sessions 两个 service 都装配好时才提供 detail 路由（见模块头）。
 * 任一 service 卸载都会撤下路由并关闭闸门。 */
export function watchDetailChannel(ctx: Context, bounds: FoldBounds, coldReads: ColdReadGate = makeColdReadGate()): DetailChannelGate {
  const gate = { live: false }
  ctx.inject(['connection', 'sessions'], (c) => {
    const sessions = c.get('sessions') as SessionsHostFace | undefined
    // 取值时即绑定：不绑定的交接会让真实接口上的 `this` 丢失。
    const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
    if (getSession === undefined) return
    const projections = ctx.sessionProjections

    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      try {
        const body: unknown = await request.json()
        sessionId = body !== null && typeof body === 'object'
          ? (body as { sessionId?: unknown }).sessionId
          : undefined
      } catch {
        return failure('dsh-cost-breakdown/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-cost-breakdown/bad-request', 'missing sessionId')
      }
      try {
        const session = getSession(sessionId)
        if (session !== undefined && session !== null) {
          // 存活 session：直接用注册表当前的 fold state——不做第二次 fold，也绝不修改它。
          const state = projections.stateOf(session as never, 'contextTimeline')
          if (state === undefined) return reply({ ok: true, value: null })
          return reply({ ok: true, value: buildTimelineDetail(state, bounds) })
        }
        // 冷 session：观察它并从其不可变日志折叠 detail。
        // 该读取要过共用的冷读闸门；堆压力下被跳过时，
        // 解析结果与「无法观察的 session」一样是类型化的 null。
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        if (observe === undefined) return reply({ ok: true, value: null })
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' })
          const events = (observation as { events?: unknown } | null)?.events
          if (!Array.isArray(events)) return null
          let state = createTimelineState()
          try {
            for (const ev of events) state = applyTimeline(state, ev as never, bounds)
          } finally {
            const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
            if (typeof dispose === 'function') dispose.call(observation)
          }
          return buildTimelineDetail(state, bounds)
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }

    // 敌意或拒绝注册的注册表会让路由缺席：闸门保持关闭。
    if (!registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, DETAIL_ROUTE, handler, 'dsh-cost-breakdown: detail route')) return
    gate.live = true
    return () => {
      gate.live = false
    }
  })
  return gate
}
