/**
 * skill 目录路由——Insights 页 skill 卡片背后的元数据（client/skills.ts）：
 * 说明每个已加载 skill 是什么（description、来源分桶、磁盘路径），再按名称与
 * activity 账本的计数关联。
 *
 * harness 自带的 `skills/list` Remote 在 wire 形状里剥掉了来源，因此插件直接读 host 侧注册表。
 * 关键在于 session 寻址：web 组合把 skill 发现挂到 agent preset 上，
 * 光靠全局注册表什么都列不出来——harness 自己的目录
 * （session-controller 的 skill-catalog.ts）也是这么解析的。
 *
 * 传输走 Connection 的 fetch 路由注册表，通过延迟 inject 完成。
 */

import { asRecord } from './record'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillInfo } from '../shared/types'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** 插件的 skill 目录路由，位于需要鉴权的 `/api` 栅栏之后。 */
export const SKILLS_ROUTE = '/api/dsh-cost-breakdown/skills'

/** 对外提供条目的渲染上限：否则一个为每个目录生成 skill 的注册表可能返回数 MB 数据。 */
const MAX_SKILLS = 500

interface SkillRegistryLike {
  list(options: { cwd?: string; scope?: unknown }): Promise<unknown>
}

/** 非空字符串，否则 undefined——所有可选注册表字段都走这一处收窄，
 * 下游因此分不出「空字段」和「字段缺失」。 */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 释放重新核验过的 observation/lease，且不把异常抛进路由。 */
async function disposeOf(resource: unknown): Promise<void> {
  if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function')) return
  try {
    const asyncDispose = (resource as { [Symbol.asyncDispose]?: unknown })[Symbol.asyncDispose]
    if (typeof asyncDispose === 'function') {
      await (asyncDispose as () => Promise<void>).call(resource)
      return
    }
    const syncDispose = (resource as { [Symbol.dispose]?: unknown })[Symbol.dispose]
    if (typeof syncDispose === 'function') (syncDispose as () => void).call(resource)
  } catch {
    // 敌意的 disposer 无关紧要——数据已经读到手了。
  }
}

/** 把一条注册表摘要收窄成 wire 条目：名称是连接键，必须自身成立，
 * 否则整条丢掉，而其余有效条目照常服务。 */
function skillInfoOf(value: unknown): SkillInfo | null {
  const record = asRecord(value)
  if (record === null || typeof record.name !== 'string' || record.name === '') return null
  return {
    name: record.name,
    description: typeof record.description === 'string' ? record.description : '',
    ...(typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {}),
    ...(typeof record.source === 'string' && record.source !== '' ? { source: record.source } : {}),
  }
}

/** 该 session 的目录视角：从 sessionQuery observation 取它的工作区与记录的 preset；
 * session 未知时，只剩请求自带的 cwd 作为唯一选择器。 */
async function sessionViewOf(ctx: Context, sessionId: string | undefined): Promise<{ cwd?: string; agentPreset?: string }> {
  if (sessionId === undefined) return {}
  const query = asRecord(ctx.get('sessionQuery'))
  if (typeof query?.observeSession !== 'function') return {}
  let observation: unknown
  try {
    observation = await (query.observeSession as (id: string) => Promise<unknown>).call(query, sessionId)
  } catch {
    return {}
  }
  try {
    const obs = asRecord(observation)
    const cwd = stringOf(asRecord(obs?.header)?.cwd)
    const agentPreset = stringOf(asRecord(asRecord(obs?.projections)?.values)?.agentPreset)
    return {
      ...(cwd === undefined ? {} : { cwd }),
      ...(agentPreset === undefined ? {} : { agentPreset }),
    }
  } finally {
    await disposeOf(observation)
  }
}

/** 一次目录读取解析到的注册表与 scope（对齐 harness 的 skill-catalog.ts）：
 * 存活 agent 的 preset 作用域注册表优先；冷 session 的 preset 则依托全局注册表上的长期 scope
 * lease；两者都没有时就只能用无 scope 的全局注册表——卡片此时不做任何增强。 */
async function resolveRegistry(
  ctx: Context,
  sessionId: string | undefined,
  agentPreset: string | undefined,
): Promise<{ registry: SkillRegistryLike; scope: unknown; lease: unknown } | null> {
  const presets = asRecord(ctx.get('agentPresets'))
  let live: unknown
  if (sessionId !== undefined) {
    const agents = asRecord(ctx.get('agents'))
    if (typeof agents?.get === 'function') {
      try {
        live = (agents.get as (id: string) => unknown).call(agents, sessionId)
      } catch {
        live = undefined
      }
    }
  }
  if (live !== undefined && live !== null && typeof presets?.serviceFor === 'function') {
    const scoped = asRecord((presets.serviceFor as (agent: unknown, name: string) => unknown).call(presets, live, 'skills'))
    if (scoped !== null && typeof scoped.list === 'function') {
      return { registry: scoped as unknown as SkillRegistryLike, scope: live, lease: undefined }
    }
  }
  const registry = asRecord(ctx.get('skills'))
  if (registry === null || typeof registry.list !== 'function') return null
  let scope: unknown
  let lease: unknown
  if (typeof presets?.acquireScope === 'function') {
    try {
      lease = await (presets.acquireScope as (id?: string) => Promise<unknown>).call(presets, agentPreset)
      scope = asRecord(lease)?.key
    } catch {
      // preset 未知或不可用时回落到全局层。
      lease = undefined
    }
  }
  return { registry: registry as unknown as SkillRegistryLike, scope, lease }
}

/** 只要 connection service 完成装配就提供目录路由；每个 harness 接口都通过请求时
 * 重新核验的 `ctx.get` 读取，子系统缺失时返回 `null`。 */
export function watchSkillCatalog(ctx: Context): void {
  ctx.inject(['connection'], (c) => {

    const handler = async (request: Request): Promise<Response> => {
      let value: { skills: SkillInfo[] } | null = null
      let lease: unknown
      try {
        const body = asRecord(await request.json())
        const sessionId = stringOf(body?.sessionId)
        const view = await sessionViewOf(ctx, sessionId)
        const cwd = view.cwd ?? stringOf(body?.cwd)
        const resolved = await resolveRegistry(ctx, sessionId, view.agentPreset)
        if (resolved !== null) {
          lease = resolved.lease
          const listed: unknown = await resolved.registry.list({
            ...(cwd === undefined ? {} : { cwd }),
            ...(resolved.scope === undefined ? {} : { scope: resolved.scope }),
          })
          const rows = Array.isArray(listed) ? listed : []
          const skills: SkillInfo[] = []
          for (const row of rows) {
            const info = skillInfoOf(row)
            if (info !== null) skills.push(info)
            if (skills.length >= MAX_SKILLS) break
          }
          value = { skills }
        }
      } catch {
        // 任何失败都返回 null——卡片只渲染计数，不做增强。
      } finally {
        await disposeOf(lease)
      }
      return Response.json({ ok: true, value }, { headers: { 'cache-control': 'no-store' } })
    }

    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, SKILLS_ROUTE, handler, 'dsh-cost-breakdown: skills route')
  })
}
