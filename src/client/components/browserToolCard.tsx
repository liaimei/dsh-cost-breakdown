/** 上下文浏览器的工具块：schema 表格、调用卡片，以及参数/结果的文本。 */

import { useMemo, useState, type ChangeEvent, type ReactElement, type ReactNode } from 'react'
import type { SurfaceNode } from '../../shared/types'
import type { ConversationNodeLike } from '../services'
import { parseCallArgs } from '../callSummary'
import { imageRefOf } from './images'
import type { ImageKit } from './images'
import type { RichKit } from './richText'
import type { ImageRefLike } from '../services'
import { typeOf, paramsOf } from './browserSchema'
import type { ParamSchema } from './browserSchema'

function ParamRow(props: {
  name: string
  schema: ParamSchema
  required: boolean
}): ReactElement {
  const typeLabel = typeOf(props.schema)
  const desc = props.schema.description
  return (
    <div className="lc-ts-param-row">
      <span className="lc-ts-param-name">{props.name}</span>
      <span className="lc-ts-param-type">{typeLabel}</span>
      <span className={props.required ? 'lc-ts-param-req' : 'lc-ts-param-req-off'}>
        {props.required ? '✓' : '·'}
      </span>
      {typeof desc === 'string' && desc !== ''
        ? <span className="lc-ts-param-desc">{desc}</span>
        : null}
    </div>
  )
}

function Section(props: {
  label: string
  labelClass?: string
  /** 宽度吃紧时把头部右侧那一组折到第二行（富文本类的头部；调用名头部必须保持单行）。 */
  foldHead?: boolean
  count?: number
  actions?: ReactNode
  meta?: ReactNode
  children: ReactNode
}): ReactElement {
  const right = props.actions !== undefined || props.meta !== undefined
  return (
    <div className="lc-ts-card">
      <div className={'lc-ts-card-head' + (props.foldHead === true ? ' lc-ts-card-head-wrap' : '')}>
        <b className={props.labelClass} title={props.label}>{props.label}</b>
        {right ? <span className="lc-ts-card-right">{props.meta}{props.actions}</span> : null}
        {props.count !== undefined ? <span className="lc-ts-card-count">{props.count}</span> : null}
      </div>
      {props.children}
    </div>
  )
}

function lineCountOf(text: string): number {
  return text.split(/\r\n|\r|\n/).length
}

/** 一具文本正文，连同它的模式切换、复制控件、查找栏与行数。查找栏的
 *  `bodyKey`/`bodyRef` 必须包住文本本身，这样标记会注入到一个随文本变化
 *  而重新挂载的容器里，而不是让 React 对其做 diff。 */
export function TextSection(props: {
  label: string
  text: string
  rich: RichKit
  lines: (n: number) => string
}): ReactElement {
  const { rich } = props
  const [mode, setMode] = rich.useRichMode()
  const find = rich.useRichFind(props.text, mode)
  const lineCount = useMemo(() => lineCountOf(props.text), [props.text])
  return (
    <Section
      label={props.label}
      foldHead
      actions={<>
        <rich.RichSwitch mode={mode} onPick={setMode} />
        <rich.RichCopy text={props.text} />
        {find.button}
      </>}
      meta={<span className="lc-ts-card-meta">{props.lines(lineCount)}</span>}
    >
      {find.bar}
      {/* 以文本本身为 key：内容一变就整体重新挂载正文，这样 React 永远不会对查找栏注入的 DOM 标记做 diff。 */}
      <div key={find.bodyKey} ref={find.bodyRef}>
        <rich.RichText text={props.text} mode={mode} />
      </div>
    </Section>
  )
}

/** 原始 schema 属于不可信的日志数据：循环引用或一取就抛的值降级为不可匹配的文本。 */
export function schemaTextOf(schema: unknown): string {
  try {
    return JSON.stringify(schema ?? '')
  } catch {
    return ''
  }
}

/** 共享的行过滤工具栏；匹配为空时它保持挂载，好让过滤条件随时都能清掉。 */
export function RowToolbar(props: {
  value: string
  placeholder: string
  tip?: string
  onChange: (v: string) => void
  children?: ReactNode
}): ReactElement {
  return (
    <div className="lc-br-toolctl">
      <input
        className="lc-br-tool-search focus:border-(--dsw-alias-label-dimmed)"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(ev: ChangeEvent<HTMLInputElement>) => { props.onChange(ev.target.value) }}
      />
      {props.children !== undefined
        ? <span className="lc-gran" role="group" title={props.tip}>{props.children}</span>
        : null}
    </div>
  )
}



/** 一个工具展开后的 schema：描述正文、由 `{@link paramsOf}` 推导出的参数表，
 *  以及一个默认收起的格式化 JSON 视图。只有在展开时才做字符串化，
 *  所以冗长的 schema 在读的人要它之前不产生任何开销。 */
export function ToolSchema(props: {
  description: string | undefined
  schema: unknown
  rich: RichKit
  lines: (n: number) => string
  labels: {
    desc: string
    title: string
    empty: string
    show: string
    hide: string
  }
}): ReactElement {
  const { rich } = props
  const [jsonOpen, setJsonOpen] = useState(false)
  const params = useMemo(() => paramsOf(props.schema), [props.schema])
  const rows = useMemo<{ name: string; schema: ParamSchema; required: boolean }[]>(() => {
    if (params === null) return []
    const props = (params as { properties?: unknown }).properties
    if (props === null || typeof props !== 'object') return []
    const req = Array.isArray((params as { required?: unknown }).required)
      ? new Set(((params as { required: unknown[] }).required)
        .filter((x): x is string => typeof x === 'string'))
      : new Set<string>()
    const out: { name: string; schema: ParamSchema; required: boolean }[] = []
    for (const k of Object.keys(props)) {
      const v = (props as Record<string, unknown>)[k]
      if (v === null || typeof v !== 'object') continue
      out.push({ name: k, schema: v, required: req.has(k) })
    }
    return out
  }, [params])
  // 只在展开时格式化：给每一行收起状态都提前字符串化，会拖垮整个分区的渲染开销。
  const schemaJson = useMemo(
    () => jsonOpen ? JSON.stringify(props.schema, null, 2) : '',
    [props.schema, jsonOpen],
  )
  return (
    <>
      {props.description !== undefined ? (
        <TextSection label={props.labels.desc} text={props.description} rich={rich} lines={props.lines} />
      ) : null}
      {params !== null && rows.length > 0 ? (
        <Section label={props.labels.title} count={rows.length}>
          {rows.map(r => <ParamRow key={r.name} name={r.name} schema={r.schema} required={r.required} />)}
        </Section>
      ) : params !== null ? (
        <div className="lc-ts-params-empty">{props.labels.empty}</div>
      ) : null}
      <div className="lc-ts-json">
        <button
          type="button"
          className="lc-ts-json-toggle hover:text-(--dsw-alias-label-primary) hover:underline"
          onClick={() => { setJsonOpen(o => !o) }}
        >{(jsonOpen ? '▾ ' : '▸ ') + (jsonOpen ? props.labels.hide : props.labels.show)}</button>
        {jsonOpen ? <pre className="lc-ts-desc-body lc-br-dim">{schemaJson}</pre> : null}
      </div>
    </>
  )
}

/** 块渲染器要传进每个分区的本地化文案与格式化器，
 *  这样词汇由调用方掌握，而正文保持与语言无关。 */
export interface DetailLabels {
  thinking: string
  answer: string
  content: string
  result: string
  summary: string
  images: string
  other: string
  lines: (n: number) => string
  callState: (err: boolean, exit: number | null) => ReactNode
}

/** 两种块词汇都在这里归一——原始持久块（`type`）与快照里的助手块（`kind`）。
 * 连续的图片并成一张网格；嵌套的 tool-result 块摊平进同一条流。 */
export function BlocksBody(props: {
  blocks: readonly unknown[]
  textLabel: string
  rich: RichKit
  img: ImageKit
  labels: DetailLabels
}): ReactElement {
  const { rich, img, labels } = props
  const out: ReactNode[] = []
  let images: ImageRefLike[] = []
  const flushImages = (): void => {
    if (images.length === 0) return
    const group = images
    images = []
    out.push(
      <Section key={'img' + String(out.length)} label={labels.images} count={group.length}>
        <div className="lc-att-grid">
          {group.map((a, i) => <img.Card key={`${a.attachmentId}:${i}`} attachment={a} load={img.load} />)}
        </div>
      </Section>,
    )
  }
  for (const b of props.blocks) {
    const image = imageRefOf(b)
    if (image !== null) { images.push(image); continue }
    flushImages()
    const blk = b !== null && typeof b === 'object'
      ? b as { type?: unknown; kind?: unknown; text?: unknown; name?: unknown; argsRaw?: unknown; arguments?: unknown; content?: unknown }
      : null
    const blockKind = blk !== null
      ? typeof blk.type === 'string' ? blk.type : typeof blk.kind === 'string' ? blk.kind : ''
      : ''
    if ((blockKind === 'text' || blockKind === 'reasoning') && typeof blk?.text === 'string') {
      const label = blockKind === 'reasoning' ? labels.thinking : props.textLabel
      out.push(<TextSection
        key={out.length}
        label={label}
        text={blk.text}
        rich={rich}
        lines={labels.lines}
      />)
      continue
    }
    if (blockKind === 'tool-call') {
      out.push(<ToolCallCard
        key={out.length}
        name={typeof blk?.name === 'string' ? blk.name : '?'}
        argsRaw={blk?.argsRaw ?? blk?.arguments}
      />)
      continue
    }
    if (blockKind === 'tool-result' && Array.isArray(blk?.content)) {
      out.push(<BlocksBody
        key={out.length}
        blocks={blk.content as unknown[]}
        textLabel={labels.result}
        rich={rich}
        img={img}
        labels={labels}
      />)
      continue
    }
    out.push(<Section key={out.length} label={labels.other}><pre className="lc-ts-desc-body lc-br-dim">{JSON.stringify(b, null, 2)}</pre></Section>)
  }
  flushImages()
  return <>{out}</>
}

/** dsh 的 shell 工具会在 `isError` 仍为 false 时追加尾部状态标记：`[exit code: N]`（只在非零时）、
 * `[killed by signal: X]`、`[shell killed by signal: X]`、`[shell exited: code N]`（排在最后，位于命令自己的
 * `[exit code: N]` 之后），以及 job_output 的 `[status: killed|failed]`。解析像 dsh 自己的
 * parseExitStatus 一样从末尾锚定，所以被引在输出里的标记文本不算失败；干净退出只是一条提示。 */
function tailStatusOf(conv: ConversationNodeLike | undefined): { fail: boolean; exit: number | null } {
  if (conv === undefined || !Array.isArray(conv.content)) return { fail: false, exit: null }
  for (const b of conv.content) {
    const text = (b as { text?: unknown } | null)?.text
    if (typeof text !== 'string') continue
    const tail = text.trimEnd()
    const shell = /\[(shell killed by signal: [^\]\n]+|shell exited(?:: code \d+)?)\]$/.exec(tail)
    if (shell !== null) {
      const cmdExit = /\[exit code:\s*(\d+)\]\s*$/.exec(tail.slice(0, shell.index))
      if (cmdExit !== null) return { fail: true, exit: Number(cmdExit[1]) }
      const code = /: code (\d+)$/.exec(shell[1])
      if (code !== null) return { fail: code[1] !== '0', exit: code[1] === '0' ? null : Number(code[1]) }
      return { fail: shell[1].startsWith('shell killed'), exit: null }
    }
    const exit = /\[exit code:\s*(\d+)\]$/.exec(tail)
    if (exit !== null) return { fail: true, exit: Number(exit[1]) }
    if (/\[killed by signal: [^\]\n]+\]$/.test(tail)) return { fail: true, exit: null }
    if (/\[status: (?:killed|failed)(?:, [^\]\n]*)?\]$/.test(tail)) return { fail: true, exit: null }
  }
  return { fail: false, exit: null }
}

/** fold 盖上的 `err`/`isError`（基础设施故障），或尾部状态标记；dsh 会把一条失败的
 * COMMAND 判定为已完成的调用，所以标记是唯一的失败信号——超时仍只是提示，与聊天里一致。 */
export function toolErrOf(node: SurfaceNode, conv: ConversationNodeLike | undefined): { err: boolean; exit: number | null } {
  const tail = tailStatusOf(conv)
  const err = node.err === true || conv?.isError === true || tail.fail
  return { err, exit: tail.exit }
}

/** 一次工具调用的卡片：带箭头前缀的名字、解析成行的参数，以及
 *  可选的状态节点。解析不了的参数退回它们的原始文本，
 *  所以一次格式非法的调用仍然能显示模型实际发来的内容。 */
export function ToolCallCard(props: {
  name: string
  argsRaw: unknown
  arrow?: string
  status?: ReactNode
}): ReactElement {
  const args = useMemo(() => parseCallArgs(props.argsRaw), [props.argsRaw])
  return (
    <Section
      label={(props.arrow ?? '→') + ' ' + props.name}
      labelClass="lc-ts-call-name"
      meta={props.status}
    >
      {args !== null
        ? Object.keys(args).map(k => <CallArgRow key={k} name={k} value={args[k]} />)
        : typeof props.argsRaw === 'string' && props.argsRaw !== ''
          ? <pre className="lc-ts-desc-body lc-br-dim">{props.argsRaw}</pre>
          : null}
    </Section>
  )
}

function CallArgRow(props: { name: string; value: unknown }): ReactElement {
  const v = props.value
  /* 唯一的调用方把 `JSON.parse` 得到的对象的 Object.keys 映射成行，
     * 那里永远不会出现 undefined 值；纯属防御。 */
  const text = typeof v === 'string' ? v
    : v === undefined ? ''
      : JSON.stringify(v)
  return (
    <div className="lc-ts-arg-row">
      <span className="lc-ts-param-name">{props.name}</span>
      <span className="lc-ts-arg-val">{text}</span>
    </div>
  )
}

