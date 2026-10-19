/**
 * The context browser: what the model actually saw at one dispatch, category by category, item by item.
 *
 * Two data sources, and knowing which is which is the whole design:
 *   - the **wire** carries the surface nodes (with their archive of evicted entries) and the header epochs'
 *     token prices, so the composition is always available and cheap;
 *   - the **durable log** carries the *content* — a message's text, a tool's description and schema — which
 *     the detail window deliberately does not ship. It is read on demand, anchored at one seq.
 *
 * So a row renders its price immediately and fetches its content when expanded. The three degraded states are
 * kept distinct, because they mean different things to the reader: no content channel at all, content still
 * loading, and content that the log no longer holds (compacted or pruned).
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { HeaderTimeline, Snapshot, SurfaceEntry } from '../../../wire/model'
import type { ConversationNode } from '../../shell/contracts'
import type { Translate } from '../../i18n/dict'
import { formatBytes, formatCount } from '../../i18n/format'
import { assemble, byCatOf, countOf } from './assemble'
import { STAGES, STAGE_COLOR, stageLabel } from './derive'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace, type HeaderContent } from '../../data/history'
import { GlyphChevronDown } from '../glyphs'

/** The browser's inputs. `selectedSeq` is the `null`-for-live cut. */
export interface BrowserProps {
  t: Translate
  data: Snapshot
  headers: HeaderTimeline | null
  selectedSeq: number | null
  /** The session the content reads are anchored on. */
  sessionId?: string
  /** A category another card asked to open (the overview's skill/answer figures, the file card's locate). */
  openCategory?: string
}

/** The categories in draw order: the cached prompt prefix first, then the messages as read. */
const CATEGORIES = STAGES

/** How many content blocks one expanded row renders before it summarises the rest. */
const MAX_BLOCKS = 40

/** The browser card. */
export function BrowserCard(props: BrowserProps): ReactElement {
  const { t, data, headers, selectedSeq, sessionId } = props
  const assembled = useMemo(() => assemble(data, headers, selectedSeq), [data, headers, selectedSeq])
  const byCat = useMemo(() => byCatOf(assembled), [assembled])
  const [open, setOpen] = useState<string | null>(props.openCategory ?? 'user')
  // A request from another card wins while it is the newest one; the reader's own toggle then takes over.
  const asked = props.openCategory
  useEffect(() => {
    if (asked !== undefined) setOpen(asked)
  }, [asked])

  // The history face arrives through a declarative inject, so the first render can beat it. Rebuilding the
  // fetchers when it lands (or is revoked) is what makes the reads work without a reload.
  const face = useHistoryFace()
  const fetchers = useMemo(() => {
    if (sessionId === undefined || sessionId === '' || face === undefined) return { content: undefined, header: undefined }
    return { content: makeContentFetcher(sessionId), header: makeHeaderFetcher(sessionId) }
  }, [sessionId, face])

  // The subtitle names the step being read: a recorded step keeps its turn and step numbers. Printing the raw
  // seq here (`T6972 S—`) was wrong — a seq is not a turn — so a cut that has no request row falls back to the
  // step-less label instead of inventing one.
  const selectedRow = selectedSeq === null ? undefined : data.requests.find(row => row.seq === selectedSeq)
  const stem = assembled.live
    ? t('browser.live')
    : selectedRow !== undefined
      ? t('browser.stepAt', { t: selectedRow.turn ?? 0, s: selectedRow.step ?? 0 })
      : t('browser.liveNow')

  return h('div', { className: 'cb-card cb-browser-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('browser.title')),
      h('span', { className: 'cb-card-sub' }, stem)),
    assembled.missingLive > 0
      ? h('div', { className: 'cb-browser-note' }, t('browser.missingLive', { n: formatCount(assembled.missingLive) }))
      : null,
    assembled.approximate ? h('div', { className: 'cb-browser-note' }, t('browser.approx')) : null,
    // The DNA-style summary: one bar per category, in read order, so the browser's top row explains the
    // composition before any list does.
    h('div', { className: 'cb-browser-strip' }, CATEGORIES.map((category) => {
      const count = countOf(assembled, byCat, category)
      const tokens = category === 'system'
        ? assembled.system?.tokens ?? 0
        : category === 'tools'
          ? (assembled.header?.tools ?? []).reduce((sum, tool) => sum + tool.tokens, 0)
          : (byCat[category as SurfaceEntry['cat']] ?? []).reduce((sum, node) => sum + node.tokens, 0)
      return count > 0 || tokens > 0
        ? h('span', {
          key: category,
          className: `cb-browser-strip-seg${open === category ? ' cb-browser-strip-on' : ''}`,
          style: { flexGrow: String(Math.max(tokens, 1)), background: STAGE_COLOR[category] },
          title: `${stageLabel(t, category)} · ${formatCount(tokens)}`,
          onClick: () => { setOpen(open === category ? null : category) },
        })
        : null
    })),
    h('ul', { className: 'cb-browser-cats' }, CATEGORIES.map((category) => {
      const count = countOf(assembled, byCat, category)
      const expanded = open === category
      return h('li', { key: category, className: 'cb-browser-cat' },
        h('button', {
          type: 'button',
          className: 'cb-browser-cat-row',
          'aria-expanded': expanded,
          onClick: () => { setOpen(expanded ? null : category) },
        },
          h('span', { className: 'cb-browser-cat-dot', style: { background: STAGE_COLOR[category] } }),
          h('span', { className: 'cb-browser-cat-name' }, t(`cat.${category}`)),
          h('span', { className: 'cb-browser-cat-count' }, formatCount(count)),
          h(GlyphChevronDown, { size: 12 })),
        expanded
          ? h('div', { className: 'cb-browser-items' }, category === 'system' || category === 'tools'
            ? headerRows(category, {
              t,
              assembled,
              fetchHeader: fetchers.header,
            })
            : nodeRows({
              t,
              nodes: byCat[category as SurfaceEntry['cat']] ?? [],
              category,
              fetchContent: fetchers.content,
            }))
          : null)
    })))
}

/** The System and Tools rows: header singletons whose *content* needs one anchored read. */
function headerRows(
  category: 'system' | 'tools',
  ctx: {
    t: Translate
    assembled: ReturnType<typeof assemble>
    fetchHeader: ((seq: number) => Promise<HeaderContent | null>) | undefined
  },
): ReactElement[] {
  const { t, assembled, fetchHeader } = ctx
  const seq = assembled.header?.seq
  if (seq === undefined) {
    // No generation for this cut: the browser can only say so.
    return [h('div', { key: 'none', className: 'cb-browser-empty' }, t('browser.noEpoch'))]
  }
  if (category === 'system') {
    const tokens = assembled.system?.tokens ?? 0
    return [h(ContentRow, {
      key: 'system',
      t,
      name: t('cat.system'),
      tokens,
      seq,
      fetch: fetchHeader,
      pick: (content: unknown) => {
        const header = content as HeaderContent | null
        return header?.system !== undefined && header.system !== ''
          ? header.system
          : null
      },
      emptyText: t('browser.noSystem'),
    })]
  }
  const tools = assembled.header?.tools ?? []
  if (tools.length === 0) return [h('div', { key: 'none', className: 'cb-browser-empty' }, t('tool.noMatch'))]
  return tools.map(tool => h(ContentRow, {
    key: tool.name,
    t,
    name: tool.name,
    tokens: tool.tokens,
    seq,
    fetch: fetchHeader,
    plugin: tool.plugin,
    pick: (content: unknown) => {
      const header = content as HeaderContent | null
      const found = header?.tools.find(entry => entry.name === tool.name)
      return found === undefined ? null : { description: found.description, schema: found.schema }
    },
  }))
}

/** The message nodes of one category. */
function nodeRows(ctx: {
  t: Translate
  nodes: readonly SurfaceEntry[]
  category: string
  fetchContent: ((seq: number) => Promise<ConversationNode | null>) | undefined
}): ReactElement[] {
  const { t, nodes, category, fetchContent } = ctx
  if (nodes.length === 0) return [h('div', { key: 'none', className: 'cb-browser-empty' }, t('browser.rowNoMatch'))]
  return nodes.map(node => h(ContentRow, {
    key: node.seq,
    t,
    name: node.tool ?? node.skill ?? node.name ?? t(`cat.${category}`),
    tokens: node.tokens,
    seq: node.seq,
    fetch: fetchContent,
    // The live surface already carries a bounded preview of each message; show it until the full content
    // lands, so an unexpanded row is still informative.
    preview: node.text,
    err: node.err === true,
    pick: (content: unknown) => {
      const conversation = content as ConversationNode | null
      if (conversation === null) return null
      if (conversation.kind === 'assistant' && Array.isArray(conversation.blocks)) {
        return conversation.blocks
      }
      if (Array.isArray(conversation.content)) return conversation.content
      return conversation.summary ?? null
    },
  }))
}

/**
 * One browser row: its name and price are always shown; expanding it fetches the content once.
 *
 * The three failure states are distinct on purpose — no channel (`browser.notInLog` is wrong there, so the
 * "unsupported" note is used), loading, and a read that landed without the item.
 */
function ContentRow(props: {
  t: Translate
  name: string
  tokens: number
  seq: number
  fetch: ((seq: number) => Promise<unknown>) | undefined
  pick: (content: unknown) => unknown
  preview?: string
  plugin?: string
  err?: boolean
  emptyText?: string
}): ReactElement {
  const { t, name, tokens, seq, fetch, pick, preview, plugin, err, emptyText } = props
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'failed'>('idle')
  const [content, setContent] = useState<unknown>(null)
  const generation = useRef(0)

  // Fetch on first expand; the generation guard drops a read that resolves after the row unmounts or the cut
  // changes, so a stale response cannot overwrite the current one.
  useEffect(() => {
    if (!open || state !== 'idle') return
    if (fetch === undefined) {
      setState('missing')
      return
    }
    const mine = ++generation.current
    setState('loading')
    void fetch(seq)
      .then((value) => {
        if (mine !== generation.current) return
        const picked = pick(value)
        if (picked === null || picked === undefined) {
          setState('missing')
          return
        }
        setContent(picked)
        setState('ready')
      })
      .catch(() => {
        if (mine === generation.current) setState('failed')
      })
  }, [open, state, fetch, seq, pick])

  const retry = (): void => {
    setState('idle')
    setContent(null)
  }

  return h('div', { className: 'cb-browser-item-wrap' },
    h('button', {
      type: 'button',
      className: `cb-browser-item${open ? ' cb-browser-item-open' : ''}`,
      'aria-expanded': open,
      onClick: () => { setOpen(!open) },
    },
      h('span', { className: 'cb-browser-item-name' }, name),
      plugin !== undefined ? h('span', { className: 'cb-browser-item-plugin' }, plugin) : null,
      err === true ? h('span', { className: 'cb-browser-item-err' }, '!') : null,
      tokens > 0 ? h('span', { className: 'cb-browser-item-tokens' }, formatCount(tokens)) : null),
    open
      ? h('div', { className: 'cb-browser-item-body' },
        preview !== undefined && preview !== '' && state !== 'ready'
          ? h('div', { className: 'cb-browser-item-preview' }, preview)
          : null,
        state === 'idle' || state === 'loading'
          ? h('div', { className: 'cb-browser-item-note' }, t('browser.loading'))
          : null,
        state === 'missing'
          ? h('div', { className: 'cb-browser-item-note' }, fetch === undefined ? t('browser.headerMetaOnly') : emptyText ?? t('browser.noContent'))
          : null,
        state === 'failed'
          ? h('button', { type: 'button', className: 'cb-browser-item-retry', onClick: retry }, t('browser.loadFailed'))
          : null,
        state === 'ready' ? contentOf(content, t) : null)
      : null,
  )
}

/** Render a landed content value: a string as text, a block list as rows, an object as a key/value table. */
function contentOf(content: unknown, t: Translate): ReactElement {
  if (typeof content === 'string') {
    return h('pre', { className: 'cb-browser-item-text-block' }, content)
  }
  if (Array.isArray(content)) {
    const shown = content.slice(0, MAX_BLOCKS)
    return h('div', { className: 'cb-browser-item-blocks' },
      shown.map((block, index) => h(Block, { key: index, block, t })),
      content.length > shown.length
        ? h('div', { className: 'cb-browser-item-note' }, t('browser.items', { n: formatCount(content.length - shown.length) }))
        : null)
  }
  if (content !== null && typeof content === 'object') {
    const record = content as { description?: unknown; schema?: unknown }
    return h('div', { className: 'cb-browser-schema' },
      typeof record.description === 'string' && record.description !== ''
        ? h('div', { className: 'cb-browser-schema-desc' }, record.description)
        : null,
      record.schema !== undefined ? h('pre', { className: 'cb-browser-item-text-block' }, prettyJson(record.schema)) : null)
  }
  return h('div', { className: 'cb-browser-item-note' }, t('browser.noContent'))
}

/** One content block: text verbatim, anything else as its JSON so nothing is silently dropped. */
function Block({ block, t }: { block: unknown; t: Translate }): ReactElement {
  if (block === null || typeof block !== 'object') {
    return h('div', { className: 'cb-browser-block cb-browser-block-raw' }, String(block))
  }
  const record = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown; content?: unknown }
  if (record.type === 'text' && typeof record.text === 'string') {
    return h('div', { className: 'cb-browser-block cb-browser-block-text' }, record.text)
  }
  if (record.type === 'tool-call') {
    return h('div', { className: 'cb-browser-block cb-browser-block-call' },
      h('span', { className: 'cb-browser-block-label' }, t('browser.kind.tool')),
      h('code', null, String(record.name ?? '?')),
      typeof record.arguments === 'string' ? h('pre', { className: 'cb-browser-item-text-block' }, record.arguments) : null)
  }
  return h('pre', { className: 'cb-browser-item-text-block' }, prettyJson(block))
}

/** Pretty-print a JSON value; a circular or hostile one falls back to a placeholder rather than throwing. */
function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[unserialisable]'
  }
}

/** The stage list, exported so the modal and this card cannot disagree about categories. */
export { STAGES, formatBytes }
