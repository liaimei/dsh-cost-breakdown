/// <reference types="node" />
/**
 * The message-identity guard at the step boundary (harness issue #51 compatibility).
 *
 * A persisted `user/message` event without a non-empty string `id` is silently accepted by the
 * runtime append path, but the load path asserts message identity — so one id-less message
 * quietly destroys its session on the next load. `agent/pre-step` is the only seam every
 * claimed inbox input passes through before it is persisted, which makes it the one place a
 * missing id can be minted in time.
 *
 * The listener is registered `prepend: true`, i.e. at the outermost layer of the waterfall, so
 * its `next()` returns after every inner listener has run and it edits the *final* message
 * list. Failure is contained: any unexpected shape passes the decision through unchanged.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'

/** Namespace on minted ids so identity is recognisable as plugin-minted, not provider-supplied. */
const MINTED_ID_PREFIX = 'dshctx-'

/** The `agent/pre-step` waterfall's decision, narrowed to the fields the guard rewrites. */
export interface PreStepDecision {
  kind?: unknown
  messages?: unknown[]
}

/** The `agent/pre-step` input the guard ignores; declared so the listener is typed. */
export interface PreStepInput {
  agent: unknown
  messages: unknown[]
  signal: AbortSignal
  step: number
  turn: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(
      this: Context,
      input: PreStepInput,
      next: () => Promise<PreStepDecision>,
    ): Promise<PreStepDecision>
  }
}

/**
 * Whether this message would fail the harness's identity check on restore, which requires a
 * non-empty string `id`. Non-object entries are left alone: minting an id needs a container.
 */
function lacksId(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false
  const id = (message as { id?: unknown }).id
  return typeof id !== 'string' || id === ''
}

/**
 * Mint ids for the messages that would otherwise persist unidentified. Untouched entries pass
 * by reference, so an already-identified list allocates nothing.
 *
 * @returns the patched list, or `undefined` when every entry already has identity.
 */
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

/**
 * Install the guard on the plugin's fiber. `prepend: true` puts this listener outermost, so its
 * `next()` resolves after all subsequent listeners and it observes the final message list.
 */
export function watchInboxIdentity(ctx: Context): void {
  ctx.on('agent/pre-step', async (_input, next) => {
    const decision = await next()
    try {
      if (decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const identified = identifiedMessages(decision.messages)
      return identified === undefined ? decision : { ...decision, messages: identified }
    } catch {
      return decision
    }
  }, { prepend: true })
}
