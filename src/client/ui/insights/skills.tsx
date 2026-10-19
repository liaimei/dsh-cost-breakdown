/**
 * The skills card on the statistics page.
 *
 * The activity ledger knows how often a skill loaded and when; the host's catalogue knows what the skill
 * *is*. This card joins the two. It appears **below the heatmap** and shares the page's scope: a skill row
 * lists every name loaded inside the selected window (or on the pinned day), so the same window that
 * narrows the session list narrows this card.
 *
 * Three interactions, all of them the reader's:
 *   - a row click **pins** the session list to the sessions that loaded that skill (click again releases);
 *   - hovering a row opens a richer card than the page's plain tooltip can hold — name, source badge,
 *     description, path, and the counts;
 *   - a path is click-to-copy, with a short "copied" confirmation on that row.
 *
 * The catalogue is optional throughout: without it the card renders its counts and nothing pretends a
 * skill has no description.
 */

import { useEffect, useRef, useState } from 'react'
import { createElement as h, Fragment } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement } from 'react'
import type { SkillEntry } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { formatCount } from '../../i18n/format'
import type { SkillLoadStat, SkillSort } from '../../data/aggregate'
import { copySkillPath } from '../../data/skills'
import { GlyphCheck, GlyphCopy } from '../glyphs'

/** Rows rendered at most: a hostile corpus can mint a name per injection, and the overflow line keeps the
 * count honest without drawing a thousand-row card. */
const MAX_ROWS = 20
/** How much of a catalogue description is shown (they can run to paragraphs). */
const MAX_DESC = 160
/** How long the "copied" confirmation stays on a path row. */
const COPIED_MS = 1_500
/** Gap between the anchor row and the hover card, and the viewport margin it is clamped inside. */
const TIP_GAP = 6
const TIP_MARGIN = 8

/** Per-skill dot/bar colours: the composition palette, picked by name hash so a skill keeps its colour
 * across scopes. */
const SKILL_COLORS = [
  'var(--cb-ctx-indigo)',
  'var(--cb-ctx-green)',
  'var(--cb-ctx-amber)',
  'var(--cb-ctx-purple)',
  'var(--cb-ctx-teal)',
  'var(--cb-ctx-orange)',
  'var(--cb-ctx-blue)',
] as const

/** A stable colour for a name. */
function colorOf(name: string): string {
  let hash = 0
  for (let index = 0; index < name.length; index++) hash = (hash * 31 + name.charCodeAt(index)) | 0
  return SKILL_COLORS[Math.abs(hash) % SKILL_COLORS.length]
}

/** The card's props. */
export interface SkillsCardProps {
  t: Translate
  stats: readonly SkillLoadStat[]
  /** The catalogue, or `null` when the route could not be read. */
  catalog: ReadonlyMap<string, SkillEntry> | null
  /** The pinned skill, if any. */
  selected: string | null
  /** Pin or release a skill. */
  onSelect: (name: string | null) => void
  /** The card's sort; the segmented control writes it back. */
  sort: SkillSort
  onSort: (sort: SkillSort) => void
  /** Render instant, injected so relative times are deterministic under test. */
  now: number
}

/** One source bucket's label. Unknown buckets print their raw id rather than a guess. */
function sourceLabel(t: Translate, source: string | undefined): string | null {
  if (source === undefined) return null
  if (source === 'project') return t('ov.skills.src.project')
  if (source === 'user') return t('ov.skills.src.user')
  if (source === 'bundled') return t('ov.skills.src.bundled')
  return source
}

/** A relative "last loaded" phrase through the plugin's dictionaries. */
function lastLabel(t: Translate, last: number, now: number): string {
  const delta = Math.max(0, now - last)
  if (delta < 60_000) return t('ov.time.now')
  if (delta < 3_600_000) return t('ov.time.m', { n: Math.floor(delta / 60_000) })
  if (delta < 86_400_000) return t('ov.time.h', { n: Math.floor(delta / 3_600_000) })
  return t('ov.time.d', { n: Math.floor(delta / 86_400_000) })
}

/** The card. */
export function SkillsCard(props: SkillsCardProps): ReactElement {
  const { t, stats, catalog, selected, onSelect, sort, onSort, now } = props
  const [query, setQuery] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [hover, setHover] = useState<{ name: string; anchor: HTMLElement } | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])

  const needle = query.trim().toLowerCase()
  const matched = needle === '' ? stats : stats.filter(stat => stat.name.toLowerCase().includes(needle))
  const shown = matched.slice(0, MAX_ROWS)
  const overflow = matched.length - shown.length
  // The bar is scaled to the heaviest row, so the shape of the distribution is readable at a glance.
  let heaviest = 0
  for (const stat of stats) if (stat.loads > heaviest) heaviest = stat.loads

  /** Copy a skill's path and confirm on that row for a moment. */
  const copy = (name: string, path: string): void => {
    void copySkillPath(path).then((ok) => {
      if (!ok) return
      setCopied(name)
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => { setCopied(null) }, COPIED_MS)
    })
  }

  return h('div', { className: 'cb-card cb-ov-skills' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('ov.skills.summary', {
        skills: formatCount(stats.length),
        loads: formatCount(stats.reduce((sum, stat) => sum + stat.loads, 0)),
      })),
      h('div', { className: 'cb-gran', role: 'group', 'aria-label': t('ov.skills.sortLabel') },
        (['loads', 'recent', 'last', 'name'] as const).map(key => h('button', {
          key,
          type: 'button',
          className: `cb-gran-btn${sort === key ? ' cb-gran-on' : ''}`,
          'aria-pressed': sort === key,
          onClick: () => { onSort(key) },
        }, t(key === 'name' ? 'ov.skills.k.path' : `ov.skills.sort.${key}`))))),
    stats.length === 0
      ? h('div', { className: 'cb-empty' }, t('ov.skills.empty'))
      : h(Fragment, null,
        h('input', {
          className: 'cb-ov-skill-search',
          type: 'search',
          placeholder: t('ov.skills.search'),
          'aria-label': t('ov.skills.search'),
          value: query,
          onInput: (event: Event) => { setQuery((event.target as HTMLInputElement).value) },
        }),
        matched.length === 0
          ? h('div', { className: 'cb-empty' }, t('ov.skills.noMatch'))
          : h('ul', { className: 'cb-ov-skill-list' }, shown.map(stat => skillRow({
            t,
            stat,
            heaviest,
            entry: catalog?.get(stat.name),
            pinned: stat.name === selected,
            copied: stat.name === copied,
            now,
            onSelect,
            onCopy: copy,
            onHover: setHover,
          }))),
        overflow > 0 ? h('div', { className: 'cb-ov-skill-more' }, t('ov.skills.more', { n: formatCount(overflow) })) : null),
    // The pinned skill's detail, or the pinned row that fell out of the scope (still releasable).
    selected !== null && !shown.some(stat => stat.name === selected)
      ? pinnedOutOfScope(t, selected, onSelect)
      : null,
    hover !== null
      ? h(SkillTip, {
        t,
        name: hover.name,
        entry: catalog?.get(hover.name),
        stat: stats.find(stat => stat.name === hover.name),
        anchor: hover.anchor,
        now,
        onClose: () => { setHover(null) },
      })
      : null,
  )
}

/** One skill row: colour dot, name, a hairline bar, and the counts. */
function skillRow(input: {
  t: Translate
  stat: SkillLoadStat
  heaviest: number
  entry: SkillEntry | undefined
  pinned: boolean
  copied: boolean
  now: number
  onSelect: (name: string | null) => void
  onCopy: (name: string, path: string) => void
  onHover: (value: { name: string; anchor: HTMLElement } | null) => void
}): ReactElement {
  const { t, stat, heaviest, entry, pinned, copied, now, onSelect, onCopy, onHover } = input
  const share = heaviest > 0 ? stat.loads / heaviest : 0
  const activate = (): void => { onSelect(pinned ? null : stat.name) }
  return h('li', {
    className: `cb-ov-skill${pinned ? ' cb-ov-skill-on' : ''}`,
    role: 'button',
    tabIndex: 0,
    'aria-pressed': pinned,
    title: pinned ? t('ov.skills.clickRelease') : t('ov.skills.clickFilter'),
    onClick: activate,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      activate()
    },
    onMouseEnter: (event: MouseEvent) => { onHover({ name: stat.name, anchor: event.currentTarget as HTMLElement }) },
    onMouseLeave: () => { onHover(null) },
  },
    h('span', { className: 'cb-ov-skill-dot', style: { background: colorOf(stat.name) } }),
    h('span', { className: 'cb-ov-skill-name' }, stat.name),
    entry?.source !== undefined ? h('span', { className: 'cb-ov-skill-source' }, sourceLabel(t, entry.source)) : null,
    h('span', { className: 'cb-ov-skill-bar' }, h('span', { className: 'cb-ov-skill-bar-fill', style: { width: `${Math.round(share * 100)}%`, background: colorOf(stat.name) } })),
    h('span', { className: 'cb-ov-skill-loads' }, t('ov.skills.loads', { n: formatCount(stat.loads) })),
    h('span', { className: 'cb-ov-skill-sessions' }, t('ov.skills.sessions', { n: formatCount(stat.sessions) })),
    h('span', { className: 'cb-ov-skill-last' }, lastLabel(t, stat.last, now)),
    entry?.path !== undefined
      ? h('button', {
        type: 'button',
        className: 'cb-ov-skill-copy',
        title: copied ? t('ov.skills.copied') : t('ov.skills.copyPath'),
        'aria-label': copied ? t('ov.skills.copied') : t('ov.skills.copyPath'),
        onClick: (event: MouseEvent) => {
          // Copying must not also pin the row.
          event.stopPropagation()
          onCopy(stat.name, entry.path as string)
        },
      }, copied ? h(GlyphCheck, { size: 12 }) : h(GlyphCopy, { size: 12 }))
      : null,
  )
}

/** The pinned skill that no longer matches the current filter: shown as one release-able row, so the pin
 * never becomes invisible while still narrowing the list. */
function pinnedOutOfScope(t: Translate, name: string, onSelect: (name: string | null) => void): ReactElement {
  return h('div', { className: 'cb-ov-skill-pinned' },
    h('button', {
      type: 'button',
      className: 'cb-ov-chip',
      title: t('ov.skills.clickRelease'),
      onClick: () => { onSelect(null) },
    }, `${name} ×`))
}

/** The hover card: a portalled, positioned panel with the catalogue facts and the counts. */
function SkillTip(input: {
  t: Translate
  name: string
  entry: SkillEntry | undefined
  stat: SkillLoadStat | undefined
  anchor: HTMLElement
  now: number
  onClose: () => void
}): ReactElement {
  const { t, name, entry, stat, anchor, now } = input
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Position against the anchor once it is mounted: the card is portalled to `body`, so it cannot rely on
  // the row's own box and must clamp itself inside the viewport.
  useEffect(() => {
    const rect = anchor.getBoundingClientRect()
    const top = rect.bottom + TIP_GAP
    setPosition({
      left: Math.max(TIP_MARGIN, Math.min(rect.left, window.innerWidth - 320 - TIP_MARGIN)),
      top: Math.min(top, window.innerHeight - TIP_MARGIN - 160),
    })
  }, [anchor])

  return createPortal(
    h('div', {
      className: 'cb-ov-skill-tip',
      role: 'tooltip',
      style: position === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: position.left, top: position.top },
    },
      h('div', { className: 'cb-ov-skill-tip-head' },
        h('span', { className: 'cb-ov-skill-dot', style: { background: colorOf(name) } }),
        h('span', { className: 'cb-ov-skill-tip-name' }, name),
        entry?.source !== undefined ? h('span', { className: 'cb-ov-skill-source' }, sourceLabel(t, entry.source)) : null),
      entry?.description !== undefined && entry.description !== ''
        ? h('div', { className: 'cb-ov-skill-tip-desc' }, entry.description.slice(0, MAX_DESC))
        : null,
      entry?.path !== undefined ? h('div', { className: 'cb-ov-skill-tip-path' }, entry.path) : null,
      h('div', { className: 'cb-ov-skill-tip-facts' },
        stat !== undefined ? h('span', null, t('ov.skills.loads', { n: formatCount(stat.loads) })) : null,
        stat !== undefined ? h('span', null, t('ov.skills.sessions', { n: formatCount(stat.sessions) })) : null,
        stat !== undefined ? h('span', null, lastLabel(t, stat.last, now)) : null)),
    document.body,
  )
}
