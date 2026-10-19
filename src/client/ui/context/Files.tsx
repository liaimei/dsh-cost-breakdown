/**
 * The file-activity card.
 *
 * It answers "what did the agent do to files here?" from the op log the fold derived, and it does so once per
 * step: the list is cut at the active step's seq, exactly like the browser's surface cut, so the two cards
 * always describe the same moment.
 *
 * Every row carries three actions, and each one is conditional on being actually possible rather than being
 * shown disabled:
 *   - **locate** — open the browser's file category pinned to that path;
 *   - **preview** — open the harness's own resource tab for the file, when the session and workspace can
 *     address it;
 *   - **open** — hand the absolute path to the desktop, when the deployment can (loopback + a controller that
 *     claims the verb).
 *
 * A path that is really a search **pattern** gets none of them: it is not a file.
 */

import { useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { FileOp } from '../../../wire/model'
import type { Translate } from '../../i18n/dict'
import { formatCount } from '../../i18n/format'
import {
  absPathOf, aggregateOps, displayPathOf, glyphOf,
  type FileActivity, type FileEntry,
} from '../../data/fileActivity'
import { GlyphChevronDown } from '../glyphs'

/** The card's props. */
export interface FilesCardProps {
  t: Translate
  /** The derived operation log; absent means an older host never folded it. */
  fileOps: readonly FileOp[] | undefined
  /** The coverage watermark: the newest dropped operation's seq. */
  floor?: number
  /** The active step's seq; `null` means "everything". */
  before: number | null
  /** The session's workspace root, for `./` display and absolute resolution. */
  workspace?: string
  /** Preview a file in the harness's resource tab. Returns whether the tab was claimed. */
  onPreview?: (path: string) => boolean
  /** Open an absolute path in the desktop. */
  onOpen?: (absolutePath: string) => void
  /** Pin the browser's file category to a path. */
  onLocate?: (path: string) => void
}

/** The card. */
export function FilesCard(props: FilesCardProps): ReactElement {
  const { t, fileOps, floor, before, workspace, onPreview, onOpen, onLocate } = props
  const [sort, setSort] = useState<'count' | 'latest' | 'path'>('count')
  const [openPath, setOpenPath] = useState<string | null>(null)

  // An older host never folded the op log: say so rather than drawing an empty list that reads as "nothing
  // happened".
  if (fileOps === undefined) {
    return h('div', { className: 'cb-card' },
      h('div', { className: 'cb-card-title' }, h('span', { className: 'cb-card-title-text' }, t('files.title'))),
      h('div', { className: 'cb-empty' }, t('files.empty')))
  }

  const activity = aggregateOps(fileOps, before)
  const sorted = sortEntries(activity.entries, sort)

  return h('div', { className: 'cb-card cb-files-card' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('files.title')),
      h('span', { className: 'cb-card-sub' }, summaryOf(activity, t)),
      h('div', { className: 'cb-gran', role: 'group', 'aria-label': t('files.sortTip') },
        (['count', 'latest', 'path'] as const).map(key => h('button', {
          key,
          type: 'button',
          className: `cb-gran-btn${sort === key ? ' cb-gran-on' : ''}`,
          'aria-pressed': sort === key,
          onClick: () => { setSort(key) },
        }, t(`files.sort.${key}`))))),
    floor !== undefined
      ? h('div', { className: 'cb-files-floor' }, t('files.scopeLatest'))
      : null,
    sorted.length === 0
      ? h('div', { className: 'cb-empty' }, t('files.empty'))
      : h('ul', { className: 'cb-files' }, sorted.map(entry => row({
        t,
        entry,
        open: openPath === entry.path,
        workspace,
        onToggle: () => { setOpenPath(openPath === entry.path ? null : entry.path) },
        ...(onPreview !== undefined ? { onPreview } : {}),
        ...(onOpen !== undefined ? { onOpen } : {}),
        ...(onLocate !== undefined ? { onLocate } : {}),
      }))),
  )
}

/** Order the rows. */
function sortEntries(entries: FileEntry[], sort: 'count' | 'latest' | 'path'): FileEntry[] {
  const sorted = [...entries]
  if (sort === 'path') sorted.sort((left, right) => left.path.localeCompare(right.path))
  else if (sort === 'latest') {
    sorted.sort((left, right) => (right.ops[right.ops.length - 1]?.seq ?? 0) - (left.ops[left.ops.length - 1]?.seq ?? 0))
  } else {
    // `count` is the default: the files the agent worked hardest on first.
    sorted.sort((left, right) => right.ops.length - left.ops.length || left.path.localeCompare(right.path))
  }
  return sorted
}

/** The totals strip's text. */
function summaryOf(activity: FileActivity, t: Translate): string {
  const parts: string[] = []
  if (activity.totals.read.files > 0) parts.push(`${t('files.kind.read')} ${formatCount(activity.totals.read.ops)}`)
  if (activity.totals.write.files > 0) parts.push(`${t('files.kind.write')} ${formatCount(activity.totals.write.ops)}`)
  if (activity.totals.search.files > 0) parts.push(`${t('files.kind.search')} ${formatCount(activity.totals.search.ops)}`)
  if (activity.totals.image.files > 0) parts.push(`${t('files.kind.image')} ${formatCount(activity.totals.image.ops)}`)
  if (activity.totals.added > 0 || activity.totals.removed > 0) {
    parts.push(`+${formatCount(activity.totals.added)} −${formatCount(activity.totals.removed)}`)
  }
  return parts.join(' · ')
}

/** One row. */
function row(input: {
  t: Translate
  entry: FileEntry
  open: boolean
  workspace?: string
  onToggle: () => void
  onPreview?: (path: string) => boolean
  onOpen?: (absolutePath: string) => void
  onLocate?: (path: string) => void
}): ReactElement {
  const { t, entry, open, workspace, onToggle, onPreview, onOpen, onLocate } = input
  const glyph = glyphOf(entry.path, entry.form)
  // A pattern is not a path: it is neither relativised nor actionable.
  const isPattern = entry.pattern === true
  const shown = isPattern ? entry.path : displayPathOf(entry.path, workspace)
  const absolute = isPattern ? undefined : absPathOf(entry.path, workspace)
  const previewable = !isPattern && entry.form !== 'dir' && onPreview !== undefined
  const openable = !isPattern && absolute !== undefined && onOpen !== undefined
  return h('li', { key: entry.path, className: `cb-file-row-wrap${open ? ' cb-file-row-open' : ''}` },
    h('div', { className: 'cb-file-row' },
      h('button', {
        type: 'button',
        className: 'cb-file-main',
        'aria-expanded': open,
        onClick: onToggle,
      },
        h('span', { className: 'cb-file-glyph', title: t(glyph.tip) },
          glyph.color !== undefined
            ? h('span', { className: 'cb-file-lang', style: { background: glyph.color, color: glyph.text } }, glyph.glyph)
            : glyph.glyph),
        h('span', { className: 'cb-file-path', title: entry.path }, shown),
        h(GlyphChevronDown, { size: 12 })),
      entry.added > 0 || entry.removed > 0
        ? h('span', { className: 'cb-file-delta', title: t('files.deltaTip') }, `+${formatCount(entry.added)} −${formatCount(entry.removed)}`)
        : null,
      entry.errs > 0 ? h('span', { className: 'cb-file-err', title: t('files.errs', { n: formatCount(entry.errs) }) }, '!') : null,
      onLocate !== undefined && !isPattern
        ? h('button', {
          type: 'button',
          className: 'cb-file-act',
          title: t('files.locate'),
          'aria-label': t('files.locate'),
          onClick: () => { onLocate(entry.path) },
        }, '◎')
        : null,
      previewable || openable
        ? h('button', {
          type: 'button',
          className: 'cb-file-act',
          title: previewable ? t('files.preview') : t('files.open'),
          'aria-label': previewable ? t('files.preview') : t('files.open'),
          onClick: () => {
            if (previewable && onPreview !== undefined && onPreview(entry.path)) return
            if (openable && absolute !== undefined && onOpen !== undefined) onOpen(absolute)
          },
        }, '↗')
        : null),
    open ? h('div', { className: 'cb-file-ops' }, entry.ops.slice().reverse().map((op, index) => h('div', {
      key: `${op.seq}-${index}`,
      className: 'cb-file-op',
    },
      h('span', { className: `cb-file-kind cb-file-${op.kind}` }, t(`files.kind.${op.kind}`)),
      h('span', { className: 'cb-file-op-tool' }, op.tool),
      // A read reports its window: exact from the result's meta, estimated from the call's `limit`.
      op.read !== undefined
        ? h('span', { className: 'cb-file-op-read' },
          'start' in op.read
            ? t('files.readTip', { a: op.read.start, b: op.read.start + op.read.count - 1 })
            : `${t('files.readEst')} (${formatCount(op.read.count)})`)
        : null,
      op.detail !== undefined ? h('span', { className: 'cb-file-op-detail' }, op.detail) : null,
      op.hits !== undefined ? h('span', { className: 'cb-file-op-hits' }, t('files.hits', { n: formatCount(op.hits) })) : null,
      op.program !== undefined ? h('span', { className: 'cb-file-op-program' }, op.program) : null,
      op.added > 0 || op.removed > 0
        ? h('span', { className: 'cb-file-delta' }, `+${formatCount(op.added)} −${formatCount(op.removed)}`)
        : null,
      op.err ? h('span', { className: 'cb-file-err' }, '!') : null)))
      : null,
  )
}
