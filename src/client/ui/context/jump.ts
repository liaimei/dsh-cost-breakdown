/**
 * The chat → Context jump relay.
 *
 * The assistant-actions button records the request seq of the reply it was clicked on and opens the
 * surface; the view then **consumes** that record once its data has landed. The record deliberately
 * outlives the click: the projection may still be in flight, and the target view may not even be
 * mounted yet (opening the right-sidebar tab mounts it moments later). A relay that dropped the value
 * on the first unrelated notification would lose the jump.
 *
 * The one-shot take is what keeps a stale jump from re-firing on every later render.
 */

import { faceOf } from '../../shell/contracts'
import type { ClientContext } from '../../shell/contracts'

/** The right-sidebar tab kind this plugin registers (mirrors `shell/sidebar.ts`). */
const SIDEBAR_KIND = 'dsh-cost-breakdown'

/** One pending seq per session; each view only ever takes its own. */
const pendingFocus = new Map<string, number>()

const listeners = new Set<() => void>()

/** Record `seq` as the jump target for `sessionId` and wake every mounted view. */
export function requestContextFocus(sessionId: string, seq: number): void {
  pendingFocus.set(sessionId, seq)
  // Set iteration is safe under removal; no copy is needed to notify the current listeners.
  for (const listener of listeners) listener()
}

/** Every record wakes all views; a listener takes only its own session's entry, so another session's
 * record stays pending for its own view. */
export function subscribeContextFocus(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The view's one-shot consume after its data is ready. `null` when this session has no pending focus —
 * which is exactly why an old jump cannot replay. */
export function takeContextFocus(sessionId: string): number | null {
  const seq = pendingFocus.get(sessionId)
  if (seq === undefined) return null
  pendingFocus.delete(sessionId)
  return seq
}

/** Drop every pending jump (tests). */
export function resetContextFocus(): void {
  pendingFocus.clear()
}

/**
 * Open the plugin's right-sidebar tab. Optional seam, re-validated at call time: a trimmed deployment, a
 * registry without this tab kind, or a hostile face all report `false`, and the caller keeps its
 * "fall back to the conversation tab" behaviour.
 *
 * `openTab` is invoked through `call` because the face is a class instance — a method lifted off the
 * tracked proxy must never be called bare.
 */
export function openContextSidebar(ctx: ClientContext): boolean {
  try {
    const face = faceOf(ctx.get('sidebarRight'))
    if (face === null || typeof face.openTab !== 'function') return false
    ;(face.openTab as (kind: string) => void).call(face, SIDEBAR_KIND)
    return true
  } catch {
    return false
  }
}

/**
 * Activate the conversation's own Context tab by clicking its chip.
 *
 * Why the DOM: the harness hands `openView` only to the currently active view entry, so a nested chat
 * action cannot reach it. The chip is found by its accessible text — the same string the `tab` key
 * renders, which is why this takes the label rather than owning a copy of it. Reports whether a chip
 * was found.
 */
export function activateContextTab(label: string): boolean {
  const buttons = document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
  for (const button of buttons) {
    if (button.textContent === null || button.textContent.trim() !== label) continue
    if (button.getAttribute('aria-selected') !== 'true') button.click()
    return true
  }
  return false
}

/**
 * Scroll an anchor to the top of its nearest real scroll viewport.
 *
 * Host-independent on purpose: the conversation tab scrolls a shared shell container, while the sidebar
 * column's scroll container depends on the shell layout. "Real" means `overflow-y` is auto/scroll **and**
 * the box actually overflows — the view's own root grows with its content, so it reports `auto` but never
 * moves. The walk stops at `document.body`, whose scrolling belongs to the page, not to the caller.
 */
export function revealInScrollParent(anchor: Element): boolean {
  try {
    for (let element = anchor.parentElement; element !== null && element !== document.body; element = element.parentElement) {
      const overflowY = window.getComputedStyle(element).overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight) {
        element.scrollTop += anchor.getBoundingClientRect().top - element.getBoundingClientRect().top
        return true
      }
    }
  } catch {
    // A hostile layout tree degrades the reveal to "do nothing"; it must not throw during a jump.
  }
  return false
}
