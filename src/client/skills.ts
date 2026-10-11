/** Insights 页技能卡片背后的技能目录：面板每打开一次就向插件的
 * `/api/dsh-cost-breakdown/skills` 路由发一次 POST，锚定在当前 session 上；
 * 读取失败时统计数字照常渲染，只是没有补充信息。 */

import type { SkillInfo } from '../shared/types'
import { asRecord } from './services'

// host/skills.ts 的技能路由，在此重新声明：客户端 bundle 会内联
// 每个 import，而 host 模块绝不能进到这里。
const SKILLS_ROUTE = '/api/dsh-cost-breakdown/skills'

/** 收窄路由载荷：name 是连接键，必须自证有效；path 与 source 仅在通过校验时才带上。 */
export function skillInfoListOf(value: unknown): SkillInfo[] | null {
  const list = asRecord(value)?.skills
  if (!Array.isArray(list)) return null
  const out: SkillInfo[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === null || typeof record.name !== 'string' || record.name === '') continue
    out.push({
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      ...(typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {}),
      ...(typeof record.source === 'string' && record.source !== '' ? { source: record.source } : {}),
    })
  }
  return out
}

/** 一次路由读取，收窄成卡片按 name 索引的连接映射。session id
 * 让 host 既能解析工作区、也能解析预设范围（发现逻辑挂在
 * agent 预设上，只给 cwd 只会列出全局层）。永不 reject；同名后者胜出。
 *
 * 请求体的两个字段不可用时一律**省略**而不是发 null：host 的
 * 解析器会区分「键缺失」与「显式为空」，而空的 session id
 * 会把发现范围缩到什么都没有。 */
export async function readSkillCatalog(
  cwd: string | undefined,
  sessionId: string | undefined,
): Promise<ReadonlyMap<string, SkillInfo> | null> {
  try {
    const response = await fetch(SKILLS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(cwd === undefined ? {} : { cwd }),
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    })
    if (!response.ok) return null
    const body = asRecord(await response.json())
    // 路由用 harness 的 ClientResult 信封作答：`ok: false` 是带原因的
    // **拒绝**，此时如实展示无补充信息的卡片就是最诚实的解读。
    const list = body === null || body.ok !== true ? null : skillInfoListOf(body.value)
    // 就卡片的目的而言，空列表与读取失败无从区分，
    // 因此两者都渲染无补充信息的状态。
    if (list === null || list.length === 0) return null
    return new Map(list.map(info => [info.name, info]))
  } catch {
    return null
  }
}

type TextCopier = (text: string) => Promise<void>

/** 经由平台 API 的剪贴板写入（非安全上下文中不存在）。失败时 reject
 *  而不是悄悄空转，{@link copySkillPath} 才能如实汇报。 */
const defaultCopier: TextCopier = async (text) => {
  const clipboard = (globalThis.navigator as { clipboard?: { writeText?: unknown } } | undefined)?.clipboard
  if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard unavailable')
  await (clipboard.writeText as (text: string) => Promise<void>).call(clipboard, text)
}

let copier: TextCopier = defaultCopier

/** 剪贴板写入的测试接缝；传 null 恢复为平台 API。 */
export function setSkillCopier(next: TextCopier | null): void {
  copier = next ?? defaultCopier
}

/** 为卡片页脚的点击复制技能路径，并解析写入是否
 * 落地，「已复制」提示因此绝不会谎报一次失败的写入。 */
export async function copySkillPath(path: string): Promise<boolean> {
  try {
    await copier(path)
    return true
  } catch {
    return false
  }
}
