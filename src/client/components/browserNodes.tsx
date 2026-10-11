/** 上下文浏览器的逐节点渲染：一个 surface 节点的各行，以及它由 fold 打上的身份。 */

import type { ReactElement, ReactNode } from 'react'
import type { Category, SurfaceNode } from '../../shared/types'
import type { Assembled } from '../assemble'
import type { ConversationNodeLike } from '../services'
import type { ImageKit } from './images'
import type { RichKit } from './richText'
import { TextSection, BlocksBody, toolErrOf, ToolCallCard } from './browserToolCard'
import type { DetailLabels } from './browserToolCard'

/**
 * 渲染一个 surface 节点的正文。`conv` 是历史 face 解析出来的实时对话节点；
 * 没有它时，节点只能显示自己折叠后的文本加上 `hint`。
 * 压缩块没有摘要时渲染空片段，免得调用方的布局
 * 被一行空壳打扰。
 */
export function NodeContent(props: {
  node: SurfaceNode
  conv: ConversationNodeLike | undefined
  hint: ReactNode
  rich: RichKit
  img: ImageKit
  labels: DetailLabels
}): ReactElement {
  const { node, conv, rich, img, labels } = props
  if (conv === undefined) {
    if (node.text === undefined || node.text === '') {
      return <div className="lc-br-note">{props.hint}</div>
    }
    return (
      <>
        <TextSection label={labels.content} text={node.text} rich={rich} lines={labels.lines} />
        <div className="lc-br-note">{props.hint}</div>
      </>
    )
  }
  if (conv.kind === 'assistant' && Array.isArray(conv.blocks)) {
    return <BlocksBody blocks={conv.blocks} textLabel={labels.answer} rich={rich} img={img} labels={labels} />
  }
  if (conv.kind === 'tool-result') {
    const { err, exit } = toolErrOf(node, conv)
    return (
      <>
        {conv.call != null
          ? <ToolCallCard
            arrow="←"
            name={conv.call.name}
            argsRaw={conv.call.argsRaw}
            status={labels.callState(err, exit)}
          />
          : null}
        {Array.isArray(conv.content)
          ? <BlocksBody blocks={conv.content} textLabel={labels.result} rich={rich} img={img} labels={labels} />
          : null}
      </>
    )
  }
  if (conv.kind === 'compaction') {
    return typeof conv.summary === 'string' && conv.summary !== ''
      ? <TextSection label={labels.summary} text={conv.summary} rich={rich} lines={labels.lines} />
      : <></>
  }
  if (Array.isArray(conv.content)) {
    return <BlocksBody blocks={conv.content} textLabel={labels.content} rich={rich} img={img} labels={labels} />
  }
  return <div className="lc-br-note">{props.hint}</div>
}

/** 把组装好的节点按类别分桶，桶内保持到达顺序。 */
export function byCatOf(asm: Assembled): Partial<Record<Category, SurfaceNode[]>> {
  const m: Partial<Record<Category, SurfaceNode[]>> = {}
  for (const n of asm.nodes) (m[n.cat] ??= []).push(n)
  return m
}

/** 节点的显示名；fold 没有给名字的节点返回 `''`，调用方据此读作「无名」，
 *  而不是渲染出字符串 'undefined'。 */
export function nodeNameOf(n: SurfaceNode): string {
  return typeof n.name === 'string' ? n.name : ''
}

/**
 * 行上各种类徽标要读的三个存在标记。两种块词汇都要扫
 * （快照块用 `kind`，原始块用 `type`），再把节点自身折叠后的事实按或并入，
 * 因为一个块被裁掉的节点仍然知道自己曾经带过文本或调用。
 */
export function msgKindsOf(n: SurfaceNode, conv: ConversationNodeLike | undefined): { think: boolean; tool: boolean; answer: boolean } {
  let think = false
  let tool = false
  let answer = false
  for (const blocks of [conv?.blocks, conv?.content]) {
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      const blk = b !== null && typeof b === 'object' ? b as { type?: unknown; kind?: unknown } : null
      const k = blk !== null
        ? typeof blk.kind === 'string' ? blk.kind : typeof blk.type === 'string' ? blk.type : ''
        : ''
      if (k === 'reasoning') think = true
      else if (k === 'tool-call') tool = true
      else if (k === 'text') answer = true
    }
  }
  return {
    think,
    tool: tool || (Array.isArray(n.calls) && n.calls.length > 0),
    answer: answer || (typeof n.text === 'string' && n.text !== ''),
  }
}

/** thinking 块唯一的扫描面——fold 不会在节点上盖 reasoning。 */
export function reasoningTextOf(conv: ConversationNodeLike | undefined): string {
  if (conv === undefined) return ''
  let out = ''
  for (const blocks of [conv.blocks, conv.content]) {
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      const blk = b !== null && typeof b === 'object' ? b as { type?: unknown; kind?: unknown; text?: unknown } : null
      const k = blk !== null
        ? typeof blk.kind === 'string' ? blk.kind : typeof blk.type === 'string' ? blk.type : ''
        : ''
      if (k === 'reasoning' && typeof blk?.text === 'string') out += blk.text + '\n'
    }
  }
  return out
}

/** 助手类别的种类徽标用来过滤的行种类，按显示顺序排列。 */
export const ROW_KINDS = ['think', 'tool', 'answer'] as const
/** 取值须是 {@link ROW_KINDS} 之一。 */
export type RowKind = (typeof ROW_KINDS)[number]
