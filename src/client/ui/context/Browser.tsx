/**
 * The context browser: what the model actually saw at one dispatch, category by category.
 *
 * It is a pure reading of the wire — the live surface plus its archive of evicted entries, rebuilt for
 * the selected request — so it never re-derives content the fold already settled. Two honesty flags from
 * that rebuild (`missingLive`, `approximate`) surface as notes rather than being papered over: a step
 * whose older nodes were dropped from the served window cannot be presented as complete.
 */

import { useState } from 'react'
import { createElement as h, useMemo } from 'react'
import type { ReactElement } from 'react'
import type { HeaderTimeline, Snapshot, SurfaceEntry } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { formatCount } from '../../i18n/format'
import { assemble, byCatOf, countOf } from './assemble'
import { STAGES, stageLabel } from './derive'

/** The browser's inputs. `selectedSeq` is the `null`-for-live cut. */
export interface BrowserProps {
  t: Translate
  data: Snapshot
  headers: HeaderTimeline | null
  selectedSeq: number | null
}

const CATEGORIES = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'] as const

/** The browser card. */
export function BrowserCard(props: BrowserProps): ReactElement {
  const { t, data, headers, selectedSeq } = props
  const assembled = useMemo(() => assemble(data, headers, selectedSeq), [data, headers, selectedSeq])
  const byCat = useMemo(() => byCatOf(assembled), [assembled])
  const [open, setOpen] = useState<string | null>('user')
  const headerTools = assembled.header?.tools ?? []
  return h('div', { className: 'cb-card cb-browser-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('browser.title')),
      h('span', { className: 'cb-card-sub' }, assembled.live ? t('browser.live') : t('browser.stepAt', { t: '—', s: String(selectedSeq ?? '') }))),
    assembled.missingLive > 0
      ? h('div', { className: 'cb-browser-note' }, t('browser.missingLive', { n: formatCount(assembled.missingLive) }))
      : null,
    assembled.approximate
      ? h('div', { className: 'cb-browser-note' }, t('browser.approx'))
      : null,
    h('ul', { className: 'cb-browser-cats' },
      CATEGORIES.map((category) => {
        const count = countOf(assembled, byCat, category)
        const expanded = open === category
        return h('li', { key: category, className: 'cb-browser-cat' },
          h('button', {
            type: 'button',
            className: 'cb-browser-cat-row',
            'aria-expanded': expanded,
            onClick: () => { setOpen(expanded ? null : category) },
          },
            h('span', { className: 'cb-browser-cat-name' }, t(`cat.${category}`)),
            h('span', { className: 'cb-browser-cat-count' }, formatCount(count))),
          expanded
            ? h('div', { className: 'cb-browser-items' }, rowsOf(category, {
              assembled, byCat, t, headerTools, systemTokens: assembled.system?.tokens ?? 0,
            }))
            : null)
      })))
}

/** The rows inside one expanded category. `system` and `tools` are header singletons rather than node
 * buckets, so they are rendered from the header epoch. */
function rowsOf(
  category: string,
  ctx: {
    assembled: ReturnType<typeof assemble>
    byCat: Partial<Record<SurfaceEntry['cat'], SurfaceEntry[]>>
    t: Translate
    headerTools: NonNullable<ReturnType<typeof assemble>['header']>['tools']
    systemTokens: number
  },
): ReactElement[] {
  const { assembled, byCat, t, headerTools, systemTokens } = ctx
  if (category === 'system') {
    return [h('div', { key: 'system', className: 'cb-browser-item' },
      h('span', { className: 'cb-browser-item-name' }, t('cat.system')),
      h('span', { className: 'cb-browser-item-tokens' }, formatCount(systemTokens)))]
  }
  if (category === 'tools') {
    return headerTools.map(tool => h('div', { key: tool.name, className: 'cb-browser-item' },
      h('span', { className: 'cb-browser-item-name' }, tool.name),
      tool.plugin !== undefined ? h('span', { className: 'cb-browser-item-plugin' }, tool.plugin) : null,
      h('span', { className: 'cb-browser-item-tokens' }, formatCount(tool.tokens))))
  }
  const stage = category as SurfaceEntry['cat']
  return (byCat[stage] ?? []).map(node => h('div', { key: node.seq, className: 'cb-browser-item' },
    h('span', { className: 'cb-browser-item-name' }, node.tool ?? node.skill ?? node.name ?? t(`cat.${stage}`)),
    node.text !== undefined && node.text !== '' ? h('span', { className: 'cb-browser-item-text' }, node.text) : null,
    node.err === true ? h('span', { className: 'cb-browser-item-err' }, '!') : null,
    h('span', { className: 'cb-browser-item-tokens' }, formatCount(node.tokens))))
}

/** The stage list, exported so the modal and this card cannot disagree about categories. */
export { STAGES }
