/**
 * The `/context` modal's open flag, one boolean per session, plus the consume-once guard that lets the
 * close path clean up the slash token that opened it.
 *
 * Module-level on purpose: the overlay is remounted whenever the conversation view re-mounts (a watch
 * rebuild does that), and the dialog must survive that. The map is tiny — one boolean per session the
 * user ever opened — so it is never evicted.
 *
 * The guard exists because the input shell owns token consumption: it wants proof that the token it is
 * about to eat is the one that opened this dialog (the draft may have moved since). Two shapes, because
 * the two open paths know different things: a pick carries the draft's span, exact Enter matches only
 * the literal line.
 */

import type { TriggerPick } from '../../shell/contracts'

/** What the input shell must verify before consuming the token it is asked to drop. */
export type ConsumeGuard =
  | { kind: 'span'; span: TriggerPick['span'] }
  | { kind: 'bare-token'; token: string }

/** The observable open flag of one session's dialog. `subscribe`/`getSnapshot` are the
 * `useSyncExternalStore` pair. */
export interface ModalStore {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  set(open: boolean): void
}

const stores = new Map<string, ModalStore>()

/** The store for one session, created on first use and kept for the page's lifetime. */
export function modalStoreOf(sessionId: string): ModalStore {
  const known = stores.get(sessionId)
  if (known !== undefined) return known
  let open = false
  const listeners = new Set<() => void>()
  const store: ModalStore = {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => open,
    set(next) {
      // Same value ⇒ same reference ⇒ nothing to do. The close path can fire twice (Escape and a backdrop
      // click in the same tick), and `useSyncExternalStore` would re-render for each notification.
      if (next === open) return
      open = next
      for (const listener of [...listeners]) listener()
    },
  }
  stores.set(sessionId, store)
  return store
}

/** One guard per session, overwritten by every open: only the most recent open may consume. */
const pending = new Map<string, ConsumeGuard>()

/** Record the guard the next close must present. */
export function setPendingConsume(sessionId: string, guard: ConsumeGuard): void {
  pending.set(sessionId, guard)
}

/** Take the guard, exactly once: a second close for the same session finds nothing, so the token can
 * never be dispatched twice. */
export function takePendingConsume(sessionId: string): ConsumeGuard | undefined {
  const guard = pending.get(sessionId)
  if (guard === undefined) return undefined
  pending.delete(sessionId)
  return guard
}

/** Drop every store and guard (tests, and a scope change that must not carry another account's dialog
 * state). */
export function resetModalStores(): void {
  stores.clear()
  pending.clear()
}
