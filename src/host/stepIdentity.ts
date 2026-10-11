/**
 * step 边界的消息身份守卫（issue #51 兼容）。
 *
 * 若持久日志里有一条 `user/message` 没有非空字符串 `id`，harness 会拒绝加载该 session （`assertMessageEventShape`: "session event at seq N lacks an identified message"），
 * 而运行时追加路径并无此检查——一条没有身份的消息会悄悄持久化，
 * 并在下次加载时
 * 把 session 弄废。
 *
 * 这个守卫加固持久化边界：`agent/pre-step` 是所有被认领的 inbox 输入在持久化之前流经的唯一接缝，
 * 而 prepend 的监听器位于该 waterfall 的最外层，
 * 因此 `next()` 之后能看到最终的消息列表。契约上按失败即放行处理：
 * 敌意条目、缺失列表或任何意外形态都让决策原样通过。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

/** 铸造出的 id 上的命名空间，让身份一眼可辨是插件铸造的，而非 provider 提供。 */
const MINTED_ID_PREFIX = 'dshctx-'

/** `agent/pre-step` waterfall 的决策，收窄到守卫会改写的字段。 */
export interface PreStepDecision {
  kind?: unknown
  messages?: unknown[]
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(
      this: Context,
      input: { agent: unknown; messages: unknown[]; signal: AbortSignal; step: number; turn: number },
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
  }
}

/** 该消息是否过不了 harness 恢复时的身份检查（要求非空字符串 id）。
 * 非对象条目无法修补——id 需要一个容器——因此原样保留。 */
function lacksId(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const id = (message as { id?: unknown }).id
  return typeof id !== 'string' || id === ''
}

/** 为那些会以无身份状态持久化的消息铸造 id；未改动的条目按引用透传，
 * 返回 undefined 表示所有条目都已有身份。 */
export function identifiedMessages(messages: readonly unknown[]): unknown[] | undefined {
  let copy: unknown[] | undefined
  for (const [index, message] of messages.entries()) {
    if (!lacksId(message)) {
      copy?.push(message)
      continue
    }
    copy ??= messages.slice(0, index)
    copy.push({ ...(message as object), id: MINTED_ID_PREFIX + randomUUID() })
  }
  return copy
}

/** 在 `agent/pre-step` 上装好守卫；`prepend: true` 让该监听器处于最外层，
 * 其 `next()` 会在所有后续监听器之后返回，因此能看到最终的消息列表。 */
export function watchStepIdentity(ctx: Context): void {
  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const identified = identifiedMessages(decision.messages)
      return identified === undefined
        ? decision
        : { ...decision, messages: identified }
    } catch {
      return decision
    }
  }, { prepend: true })
}
