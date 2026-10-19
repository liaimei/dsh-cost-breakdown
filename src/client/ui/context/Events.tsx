/**
 * The persistent context-event list.
 *
 * One row per event, newest first, because the list reads bottom-up alongside the conversation it annotates.
 * Each row carries four facts and the shipped column discipline: the icon and the kind chip are fixed, the
 * label is the only flexible cell (so rows align however long a label is), and the trailing facts — where the
 * event sits in the timeline, the token delta it moved, and its clock time — never shrink.
 *
 * Two distinctions the card must not lose:
 *   - **a read that has not landed is not an empty list**; loading and failed get their own notes, and only a
 *     landed-but-empty list is allowed to say "no events yet";
 *   - **the delta is signed by kind**: an injection adds tokens (`+`), a compaction or prune frees them (`−`),
 *     which is the whole reason the column is coloured.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { Snapshot } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { formatClock, formatCount } from '../../i18n/format'
import { GlyphBranch, GlyphPlus } from '../glyphs'

/** The five persistent kinds, in draw order. */
const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const

/** Kinds the shared icon set has no shape for keep a text glyph. */
const EVENT_GLYPHS: Readonly<Record<string, string>> = { compaction: '✂', prune: '✂', mode: '⇄' }

/** The list's inputs. */
export interface EventsCardProps {
  t: Translate
  snapshot: Snapshot
  /** The detail read's state: a list that has not landed must not claim the session has no events. */
  state?: 'idle' | 'loading' | 'ready' | 'failed' | 'legacy'
  onRetry?: () => void
}

/** The label and timeline position of one event.
 *
 * The kind union narrows to `inject` in the last branch, so a future kind becomes a compile error here rather
 * than a silently mislabelled row.
 */
function eventLabel(event: Snapshot['events'][number], t: Translate): string {
  if (event.kind === 'compaction') return t('ev.compaction', { n: event.count ?? 0 })
  if (event.kind === 'prune') return t('ev.prune')
  if (event.kind === 'model') return t('ev.model', { a: event.from ?? '?', b: event.to ?? '?' })
  if (event.kind === 'mode') return t(`ev.mode.${event.name ?? '?'}`)
  // `inject`: distinguish a skill load from any other injection, then append the name and detail.
  if (event.sub === 'skill') return t('ev.skill', { name: event.name ?? '?' })
  const base = t(`form.${event.form ?? 'context'}`)
  let label = event.name !== undefined ? `${base} · ${event.name}` : base
  if (event.detail !== undefined) label += ` · ${event.detail}`
  return label
}

/** Where an event sits on the timeline.
 *
 * A boundary event (compaction/prune) names the **gap** it occupies: `Turn 2 · Step 3→4` within one turn, or
 * `Turn 50 · Step 8 → Turn 51 · Step 1` across turns. Every other kind is a single point. An event with no
 * turn/step yet (still in flight) has no position.
 */
function eventAt(event: Snapshot['events'][number], t: Translate): string | null {
  if (event.kind === 'compaction' || event.kind === 'prune') {
    if (typeof event.turn === 'number' && typeof event.step === 'number') {
      if (typeof event.fromTurn === 'number' && typeof event.fromStep === 'number') {
        if (event.fromTurn === event.turn) {
          return t('events.range', { t: event.turn, a: event.fromStep, b: event.step })
        }
        return t('events.rangeTo', { a: event.fromTurn, as: event.fromStep, b: event.turn, bs: event.step })
      }
      return t('events.at', { t: event.turn, s: event.step })
    }
    return null
  }
  if (typeof event.turn === 'number' && typeof event.step === 'number') {
    return t('events.at', { t: event.turn, s: event.step })
  }
  return null
}

/** Give any label that overflows its container a native `title`: the styled tips only cover the cards, and a
 * plain ellipsis still needs the fallback.
 *
 * The read (`scrollWidth`/`clientWidth`) and the write (`title`) are split from anything that affects layout,
 * and the caller decides when this runs — running it on every render would force a synchronous layout per row.
 */
function syncTitles(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLElement>('.cb-event-detail')) {
    element.title = element.scrollWidth > element.clientWidth ? element.textContent ?? '' : ''
  }
}

/** The card. */
export function EventsCard(props: EventsCardProps): ReactElement {
  const { t, snapshot, state, onRetry } = props
  const [picked, setPicked] = useState<readonly string[]>(EVENT_KINDS)
  const toggle = (kind: string): void => {
    setPicked((current) => {
      // Clicking one kind while everything is shown narrows to just it; clicking the last remaining kind
      // restores the full set, so the filter can never end up showing nothing.
      if (current.length === EVENT_KINDS.length) return [kind]
      if (!current.includes(kind)) return [...current, kind]
      return current.length === 1 ? [...EVENT_KINDS] : current.filter(entry => entry !== kind)
    })
  }
  const all = snapshot.events
  const events = picked.length === EVENT_KINDS.length ? all : all.filter(event => picked.includes(event.kind))
  const counts: Record<string, number | undefined> = {
    inject: snapshot.counts?.injects,
    compaction: snapshot.counts?.compactions,
    prune: snapshot.counts?.prunes,
  }
  const root = useRef<HTMLDivElement | null>(null)

  // Truncated labels depend on a resize-only listener plus event-driven resync; this effect must never run on
  // every render, or a hover elsewhere in the view would force a layout pass over every row.
  useLayoutEffect(() => {
    const element = root.current
    if (element !== null) syncTitles(element)
  }, [events])
  useEffect(() => {
    const onResize = (): void => {
      if (root.current !== null) syncTitles(root.current)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  if (all.length === 0) {
    // Order matters: a pending or failed read has its own note; only a landed and genuinely empty list may say
    // there are no events.
    return h('div', { className: 'cb-card' },
      h('div', { className: 'cb-card-title' },
        h('span', { className: 'cb-card-title-text' }, t('events.title')),
        h(KindGroup, { t, counts, picked, onToggle: toggle })),
      state === 'loading'
        ? h('div', { className: 'cb-empty' }, t('loading'))
        : state === 'failed' && onRetry !== undefined
          ? h('div', { className: 'cb-error' },
            h('div', { className: 'cb-error-msg' }, t('detail.loadFailed')),
            h('button', { type: 'button', className: 'cb-error-retry', onClick: onRetry }, t('error.retry')))
          : h('div', { className: 'cb-empty' }, t('events.empty')))
  }

  return h('div', { className: 'cb-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('events.title')),
      h(KindGroup, { t, counts, picked, onToggle: toggle })),
    h('div', { className: 'cb-events', ref: root },
      // `slice().reverse()` copies first: the caller's array is often the provider's own, and reversing in place
      // would mutate a published value.
      events.slice().reverse().map(event => {
        const label = eventLabel(event, t)
        const at = eventAt(event, t)
        const glyph = event.kind === 'inject'
          ? h(GlyphPlus, { size: 12 })
          : event.kind === 'model' ? h(GlyphBranch, { size: 12 }) : EVENT_GLYPHS[event.kind] ?? '•'
        // Keyed by the durable seq only: the list is newest-first, so a new event lands at index 0, and an
        // index-based key would shift every row's key and remount the whole list on each push.
        return h('div', { key: event.seq, className: 'cb-event-row' },
          h('span', { className: `cb-event-icon cb-event-${event.kind}` }, glyph),
          h('span', { className: `cb-event-kind cb-kind-${event.kind}` }, t(`kind.${event.kind}`)),
          h('span', { className: 'cb-event-detail' }, label),
          at !== null ? h('span', { className: 'cb-event-at' }, at) : null,
          // A signed delta: an injection adds tokens, a compaction or prune frees them.
          event.tokens !== undefined && event.tokens !== 0
            ? h('span', { className: `cb-event-tokens${event.kind === 'inject' ? ' cb-up' : ' cb-down'}` },
              `${event.kind === 'inject' ? '+' : '−'}${formatCount(event.tokens)}`)
            : null,
          h('span', { className: 'cb-event-time' }, formatClock(event.time)))
      })))
}

/** The kind filter group, with the shipped count badges. */
function KindGroup(props: {
  t: Translate
  counts: Record<string, number | undefined>
  picked: readonly string[]
  onToggle: (kind: string) => void
}): ReactElement {
  return h('div', { className: 'cb-kinds', role: 'group' },
    EVENT_KINDS.map((kind) => {
      const count = props.counts[kind]
      return h('button', {
        key: kind,
        type: 'button',
        'data-kind': kind,
        className: `cb-gran-btn${props.picked.includes(kind) ? ` cb-gran-on cb-kind-${kind}` : ''}`,
        onClick: () => { props.onToggle(kind) },
      },
        props.t(kind === 'model' ? 'kind.model' : `kind.${kind}`),
        count !== undefined ? h('span', { className: 'cb-kind-n' }, formatCount(count)) : null)
    }))
}
