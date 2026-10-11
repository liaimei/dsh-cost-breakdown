/** Context 浏览器各明细分区所用的 raw/markdown 正文：`md` 走 MarkdownText（harness 共享的 GFM
 * 渲染器），raw 则走带行号的 `<pre>`。 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type RefObject } from 'react'
import { MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCheck, IconChevronDown, IconChevronUp, IconClose, IconCopy, IconSearch } from '../primitives'
import type { ViewKit } from '../viewkit'

/** 正文的两副面孔：字面源码，或 harness 的 GFM 渲染器。 */
export type RichMode = 'raw' | 'md'

/** MarkdownText 要求的 `labels` prop，在本地重新声明类型，好让插件不依赖 primitives。 */
interface MarkdownChrome {
  code: { copyLabel: string; copiedLabel: string }
  footnotes: string
}

// 在本地重新声明类型：实际只会传 `text`/`labels`，这个断言让本模块不必
// 依赖 primitives 包完整的 prop 类型。
const Markdown = MarkdownText as (props: { text: string; labels?: MarkdownChrome }) => ReactElement

/**
 * 浏览器的明细分区拿到的那套渲染器，闭合在一个 `kit` 上。把这些碎片
 * 当作一袋东西交出去（而不是逐分区 import），能让每处正文都读到
 * 同一个语言与同一份模式状态。
 */
export interface RichKit {
  RichText: (props: { text: string; mode: RichMode }) => ReactElement
  RichSwitch: (props: { mode: RichMode; onPick: (mode: RichMode) => void }) => ReactElement
  RichCopy: (props: { text: string }) => ReactElement
  useRichMode: () => [RichMode, (mode: RichMode) => void]
  useRichFind: (text: string, mode: RichMode) => RichFind
}

/** 查找栏的零件，以及它必须覆盖在其上的正文外壳。正文由
 *  `{@link RichKit.useRichFind}` 控制：它返回的 ref 与 key 正是让注入的标记
 *  不被 React 走 diff 的关键。 */
export interface RichFind {
  button: ReactElement
  bar: ReactElement | null
  /** 正文外壳的 key：文本一变就重新挂载正文，这样 React 永远不会对注入的标记做 diff。 */
  bodyKey: string
  bodyRef: RefObject<HTMLDivElement>
}

/** 查询的稳定窗口：连续快速输入或删除只会重扫正文一次，而不是每敲一键一次。 */
const FIND_DEBOUNCE_MS = 150
/** 渲染标记的上限：一个字符的查询不能灌爆 DOM（计数器用 '+' 报告已触顶）。 */
const FIND_MAX_MARKS = 500

interface FindMarks {
  count: number
  capped: boolean
  restore: () => void
}

/** 把 `root` 下每一处不分大小写的 `query` 出现包进 `<mark>`。restore 会把原始文本节点
 * 连同它们的值放回去（splitText 让第一个节点留在原位，所以 React 的节点引用得以存活）。 */
function markMatches(root: HTMLElement, query: string, active: number): FindMarks {
  const needle = query.toLowerCase()
  const texts: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) texts.push(node as Text)
  const touched: { node: Text; full: string; created: Node[] }[] = []
  const marks: HTMLElement[] = []
  let capped = false
  for (const textNode of texts) {
    // CharacterData.data（不是 nodeValue）不可为 null，所以空的海量文本永远不会匹配。
    const full = textNode.data
    const created: Node[] = []
    let rest = textNode
    let at = full.toLowerCase().indexOf(needle)
    while (at !== -1) {
      if (marks.length >= FIND_MAX_MARKS) { capped = true; break }
      const matchNode = rest.splitText(at)
      const after = matchNode.splitText(needle.length)
      const mark = document.createElement('mark')
      mark.className = 'lc-find-mark'
      matchNode.before(mark)
      mark.appendChild(matchNode)
      marks.push(mark)
      created.push(mark, after)
      rest = after
      at = after.data.toLowerCase().indexOf(needle)
    }
    if (created.length > 0) touched.push({ node: textNode, full, created })
    if (capped) break
  }
  const on = Math.min(active, marks.length - 1)
  if (on >= 0) {
    marks[on].classList.add('lc-find-mark-on')
    marks[on].scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  return {
    count: marks.length,
    capped,
    restore: () => {
      for (const { node, full, created } of touched) {
        node.data = full
        for (const c of created) c.parentNode?.removeChild(c)
      }
    },
  }
}

/**
 * 针对同一个 `kit` 构造 raw/markdown 工具包。它返回的一切都是每次调用新建的，
 * 所以宿主必须只建一次并向下传：每次渲染换一个新的 `RichText` 身份会让
 * 它渲染的每处正文都重新挂载。
 */
export function makeRichText(kit: ViewKit): RichKit {
  const { t } = kit

  function useRichMode(): [RichMode, (mode: RichMode) => void] {
    const [mode, setMode] = useState<RichMode>('md')
    return [mode, setMode]
  }

  function RichSwitch(props: { mode: RichMode; onPick: (mode: RichMode) => void }): ReactElement {
    const seg = (m: RichMode, label: string, tip: string) => (
      <button
        type="button"
        className={'lc-gran-btn' + (props.mode === m ? ' lc-gran-on' : '')}
        title={tip}
        onClick={() => { props.onPick(m) }}
      >{label}</button>
    )
    return (
      <span className="lc-gran">
        {seg('raw', t('rich.raw'), t('rich.toRaw'))}
        {seg('md', t('rich.md'), t('rich.toMd'))}
      </span>
    )
  }

  // 每个源码行一个块：行号是由计数器驱动的 ::before，靠软换行粘在它那一行上，而伪元素
  // 内容永远不会进入剪贴板。
  function RawText(props: { text: string }): ReactElement {
    const lines = useMemo(() => {
      const parts = props.text.split('\n')
      return parts.length > 1 && parts[parts.length - 1] === '' ? parts.slice(0, -1) : parts
    }, [props.text])
    return (
      <pre className="lc-ts-desc-body lc-ts-lines">
        {lines.map((line, index) => (
          <span key={index} className="lc-ts-line">{line}</span>
        ))}
      </pre>
    )
  }

  // 始终是原始源码，绝不是渲染后的 markdown；写入及它的确认沿用 harness 自己的代码块控件。
  function RichCopy(props: { text: string }): ReactElement {
    const [copied, setCopied] = useState(false)
    const onCopy = useCallback(() => {
      if (copied) return
      void writeClipboard(props.text).then((ok) => {
        if (!ok) return
        setCopied(true)
        window.setTimeout(() => { setCopied(false) }, 1200)
      })
    }, [copied, props.text])
    const label = copied ? t('rich.copied') : t('rich.copy')
    return (
      <button
        type="button"
        className={'lc-rich-copy' + (copied ? ' lc-rich-copy-on' : '')}
        title={label}
        aria-label={label}
        onClick={onCopy}
      >
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
    )
  }

  function RichText(props: { text: string; mode: RichMode }): ReactElement {
    // 按语言保持引用稳定：`labels` 是 MarkdownText 的依赖项，一个新建的对象会让它每次渲染都重新解析 Markdown。
    const mdLabels = useMemo<MarkdownChrome>(() => ({
      code: { copyLabel: t('rich.md.copy'), copiedLabel: t('rich.md.copied') },
      footnotes: t('rich.md.footnotes'),
    }), [t])
    if (props.mode === 'md') {
      return <div className="lc-ts-desc-md"><Markdown text={props.text} labels={mdLabels} /></div>
    }
    return <RawText text={props.text} />
  }

  // 文本内查找（ctrl+f 风格），限定在一个分区的正文内；标记 effect 以文本与模式共同为 key，好让这枚透镜跟随正文替换。
  function useRichFind(text: string, mode: RichMode): RichFind {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [needle, setNeedle] = useState('')
    const [active, setActive] = useState(0)
    const [count, setCount] = useState(0)
    const [capped, setCapped] = useState(false)
    const bodyRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
      if (!open || query === '') { setNeedle(''); return }
      const id = window.setTimeout(() => { setNeedle(query); setActive(0) }, FIND_DEBOUNCE_MS)
      return () => { window.clearTimeout(id) }
    }, [open, query])

    useEffect(() => {
      if (open) inputRef.current?.focus()
    }, [open])

    useLayoutEffect(() => {
      const root = bodyRef.current
      if (!open || needle === '' || root === null) {
        setCount(0)
        setCapped(false)
        return
      }
      const found = markMatches(root, needle, active)
      setCount(found.count)
      setCapped(found.capped)
      if (active >= found.count) setActive(found.count > 0 ? found.count - 1 : 0)
      return () => { found.restore() }
    }, [open, needle, active, text, mode])

    const step = useCallback((delta: number) => {
      setActive(a => (count > 0 ? (a + delta + count) % count : 0))
    }, [count])
    const onKey = useCallback((ev: ReactKeyboardEvent<HTMLInputElement>) => {
      if (ev.key === 'Enter') { ev.preventDefault(); step(ev.shiftKey ? -1 : 1) }
      else if (ev.key === 'Escape') { ev.preventDefault(); setOpen(false) }
    }, [step])

    const findLabel = t('rich.find')
    const iconBtn = (label: string, glyph: ReactElement, onClick: () => void, disabled = false) => (
      <button
        type="button"
        className="lc-find-btn"
        title={label}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >{glyph}</button>
    )
    const button = (
      <button
        type="button"
        className={'lc-find-btn' + (open ? ' lc-find-btn-on' : '')}
        title={findLabel}
        aria-label={findLabel}
        onClick={() => { setOpen(o => !o) }}
      ><IconSearch size={13} /></button>
    )
    const bar = !open ? null : (
      <div className="lc-find">
        <input
          ref={inputRef}
          className="lc-find-input focus:border-(--dsw-alias-label-dimmed)"
          value={query}
          placeholder={t('rich.findPlaceholder')}
          onChange={(ev: ChangeEvent<HTMLInputElement>) => { setQuery(ev.target.value) }}
          onKeyDown={onKey}
        />
        {needle !== '' ? (
          <span className="lc-find-count">{String(count > 0 ? active + 1 : 0) + '/' + String(count) + (capped ? '+' : '')}</span>
        ) : null}
        {iconBtn(t('rich.findPrev'), <IconChevronUp size={13} />, () => { step(-1) }, count === 0)}
        {iconBtn(t('rich.findNext'), <IconChevronDown size={13} />, () => { step(1) }, count === 0)}
        {iconBtn(t('rich.findClose'), <IconClose size={13} />, () => { setOpen(false) })}
      </div>
    )
    return { button, bar, bodyKey: text, bodyRef }
  }

  return { RichText, RichSwitch, RichCopy, useRichMode, useRichFind }
}
