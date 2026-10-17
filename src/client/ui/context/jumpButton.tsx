/**
 * The chat → context jump button, mounted in the assistant-actions row.
 *
 * One click should land the reader on the part of the Context surface that explains the reply they are
 * looking at. Two steps: the button *asks* (records the surface seq for that session), and the surface
 * *consumes* it once its detail collections have landed — consuming earlier would scroll to a bar that
 * is not rendered yet.
 */

import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { ClientContext, ContextSeatProps, ConversationNode } from '../../shell/contracts'
import { conversationNodesOf, serviceOf } from '../../shell/contracts'
import type { Translate } from '../../i18n/dict'
import { GlyphInsights } from '../glyphs'
import { activateContextTab, openContextSidebar, requestContextFocus } from './jump'

/** The label the Context tab chip carries, so the jump can find and click it. */
export const CONTEXT_TAB_LABEL_KEY = 'tab'

/**
 * Build the button.
 *
 * The target comes from the chat node the action belongs to: `messageId` first (a stable identity),
 * then the node's own `seq` (the surface event it was projected from). A node with neither cannot be
 * located, and the button falls back to simply opening the surface.
 */
export function makeJumpButton(ctx: ClientContext, t: Translate): (props: ContextSeatProps) => ReactElement | null {
  return function ContextJumpButton(props: ContextSeatProps): ReactElement | null {
    const nodes = conversationNodesOf(props)
    const target = typeof props.sessionId === 'string' ? props.sessionId : ''
    if (target === '') return null
    const component = h(
      'button',
      {
        type: 'button',
        className: 'cb-jump',
        title: t('jump.title'),
        'aria-label': t('jump.title'),
        onClick: () => { jump() },
      },
      h(GlyphInsights, { size: 14 }),
    )
    return component

    /** Locate the reply's surface seq, remember it, then bring the surface into view. */
    function jump(): void {
      const seq = targetSeq(nodes)
      if (seq !== null) requestContextFocus(target, seq)
      // Prefer the sidebar column (it pins the turn), then the conversation tab chip; a deployment with
      // neither still records the focus, so the next open lands on it.
      if (openContextSidebar(ctx)) return
      void activateContextTab(t(CONTEXT_TAB_LABEL_KEY))
    }
  }
}

/** The surface seq behind the chat node the action was rendered for, when it can be resolved. */
function targetSeq(nodes: readonly ConversationNode[] | undefined): number | null {
  const last = nodes?.at(-1)
  if (last === undefined) return null
  return Number.isFinite(last.seq) ? last.seq : null
}

/** Test seam: the action catalogue, so a spec can assert the registration shape without a harness. */
export function jumpRegistration(t: Translate): { id: string; order: number; label: string } {
  return { id: 'context-jump', order: 20, label: t('jump.title') }
}

/** Re-exported so the entry has one import site for the surface-open helpers. */
export { serviceOf }
