/**
 * The `/context` modal: the same projection as the Context tab, slimmed to the composition and the
 * shared browser.
 *
 * The overlay is mounted per session by `conversation.input.overlay` and returns `null` while closed —
 * **after** every hook has run, so hook order stays stable across open/close.
 *
 * Two pieces of behaviour matter beyond rendering:
 *   - the backdrop is measured to the conversation frame (the shell's grid), so it covers the chat
 *     column rather than the whole window, and it is re-measured on every open plus a MutationObserver
 *     on the frame's inline style (drag, collapse and narrow viewports all rewrite that template);
 *   - Escape is handled in the **capture** phase with `preventDefault` + `stopPropagation`, because the
 *     harness's own router listens in the bubble phase and would otherwise close something behind this
 *     dialog; focus is restored on cleanup.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { ClientContext, ContextSeatProps } from '../../shell/contracts'
import type { Translate } from '../../i18n/dict'
import { useTimelineSource } from '../../data/timeline'
import { headlineOf } from './derive'
import { BrowserCard } from './Browser'
import { takePendingConsume } from './modalStore'
import { formatCount } from '../../i18n/format'
import { stageLabel } from './derive'

/** The modal's props: the seat plus the closure the entry supplies. */
export interface ModalProps extends ContextSeatProps {
  t: Translate
  ctx: ClientContext
  /** The per-session open flag, supplied by the slot's `inject` hook. */
  open?: boolean
  onClose?: () => void
}

/** The modal. */
export function ContextModal(props: ModalProps): ReactElement | null {
  const { t, open = false } = props
  const timeline = useTimelineSource({ sessionId: props.sessionId, useProjection: props.useProjection })
  const backdrop = useRef<HTMLDivElement | null>(null)
  const card = useRef<HTMLDivElement | null>(null)
  const [frame, setFrame] = useState<{ left: number; right: number } | null>(null)
  const restore = useRef<HTMLElement | null>(null)

  const close = (): void => {
    const sessionId = props.sessionId ?? ''
    if (sessionId === '') return
    // Flip the store first, then drain the guard and drop the token — a failed close must not eat the
    // slash token.
    props.onClose?.()
    const guard = takePendingConsume(sessionId)
    if (guard !== undefined) {
      try {
        const scope = props.ctx.get('sessions') as { scope?(id: string): { bail(subject: unknown, event: string, payload: unknown): unknown } | undefined } | undefined
        scope?.scope?.(sessionId)?.bail({}, 'slash/input-consume-token', { guard })
      } catch {
        // No session shell to consume through; the token simply stays.
      }
    }
  }

  // Escape in the capture phase, with focus restore. Only armed while open.
  useEffect(() => {
    if (!open) return
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      restore.current?.focus?.()
    }
  }, [open])

  // Measure the conversation frame: the first ancestor whose grid template is set inline.
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const found = frameOf(backdrop.current?.parentElement ?? null)
      if (found === null) {
        setFrame({ left: 0, right: 0 })
        return
      }
      const centre = found.centreFloor
      const right = Math.min(found.bound, Math.max(0, window.innerWidth - found.left - centre))
      setFrame({ left: found.left, right: Math.max(0, window.innerWidth - right) })
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof MutationObserver === 'function'
      ? new MutationObserver(measure)
      : null
    const frameElement = backdrop.current?.parentElement
    if (frameElement !== null && frameElement !== undefined) observer?.observe(frameElement, { attributes: true, attributeFilter: ['style'] })
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [open])

  // Closed: every hook has already run above, so returning null here keeps hook order stable.
  if (!open) return null
  const head = timeline.data
  return h('div', {
    ref: backdrop,
    className: 'cb-modal-backdrop',
    style: frame === null ? { left: 0, right: 0 } : { left: frame.left, right: frame.right },
    onClick: close,
  },
    h('div', { ref: card, className: 'cb-modal-card', role: 'dialog', 'aria-label': t('tab'), onClick: (event: MouseEvent) => { event.stopPropagation() } },
      h('div', { className: 'cb-modal-head' },
        h('span', { className: 'cb-modal-title' }, t('tab')),
        h('button', { type: 'button', className: 'cb-modal-close', 'aria-label': t('cmd.close'), onClick: close }, '×')),
      head === null
        ? h('div', { className: 'cb-empty' }, timeline.detailState === 'failed' ? t('detail.loadFailed') : t('loading'))
        : h('div', { className: 'cb-modal-body' },
          h('div', { className: 'cb-modal-composition' },
            h('div', { className: 'cb-card-title' },
              h('span', { className: 'cb-card-title-text' }, t('overview.title')),
              h('span', { className: 'cb-card-sub' }, formatCount(head.current.total))),
            h('div', { className: 'cb-comp-flow' },
              headlineOf(head).parts.map(part => h('span', {
                key: part.key,
                className: `cb-comp-seg cb-comp-${part.key}`,
                style: { flexGrow: String(Math.max(part.value, 0.0001)), background: part.color },
                title: `${stageLabel(t, part.key)}: ${formatCount(part.value)}`,
              }, part.value / Math.max(1, head.current.total) >= 0.1 ? stageLabel(t, part.key) : '')))),
          h(BrowserCard, { t, data: head, headers: null, selectedSeq: null }))))
}

/** The nearest ancestor with an inline grid template: its left offset, trailing bound and centre floor. */
function frameOf(start: Element | null): { left: number; bound: number; centreFloor: number } | null {
  for (let element = start; element !== null && element !== document.body; element = element.parentElement) {
    if (!(element instanceof HTMLElement)) continue
    const template = element.style.gridTemplateColumns
    if (template === '') continue
    const leftMatch = /^(\d+(?:\.\d+)?)px/.exec(template)
    const boundMatch = /(\d+(?:\.\d+)?)px\)?$/.exec(template)
    const centreMatch = /^\s*minmax\(\s*([\d.]+)(?:px)?\s*,/.exec(template)
    if (leftMatch === null || boundMatch === null) continue
    return {
      left: Number(leftMatch[1]),
      bound: Number(boundMatch[1]),
      centreFloor: centreMatch !== null ? Number(centreMatch[1]) : 0,
    }
  }
  return null
}
