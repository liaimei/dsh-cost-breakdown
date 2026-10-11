/** 工具调用参数摘要，供 Context 浏览器的行预览与步骤摘要共用。 */

import type { ConversationNodeLike } from './services'
import { parseCallArgs } from '../shared/fileOps'

export { parseCallArgs }

/** 这里的顺序即优先级：调用中由模型撰写的 `description` 胜过它触碰的原始路径，
 *  两种路径拼写覆盖 SDK 工具参数的 snake_case 与 camelCase 形态。 */
export function summaryInArgs(args: Record<string, unknown> | null): string | null {
  if (args === null) return null
  for (const k of ['description', 'file_path', 'path', 'filePath']) {
    const v = args[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/** join 节点（其 `call` 面仍可用）的行预览；参数里没有可识别的目标时返回 null
 *  （该行便只回退到工具名）。 */
export function callSummaryOf(conv: ConversationNodeLike | undefined): string | null {
  return summaryInArgs(parseCallArgs(conv?.call?.argsRaw))
}

/** 编译后 assistant 节点的同类预览：调用块位于 `blocks` 中，
 *  且没有 `call` 面。第一个能给出摘要的块胜出，
 *  与浏览器每次回复只留一条面包屑的做法一致。 */
export function blockSummaryOf(conv: ConversationNodeLike | undefined): string | null {
  if (conv === undefined || !Array.isArray(conv.blocks)) return null
  for (const b of conv.blocks) {
    const blk = b !== null && typeof b === 'object' ? b as { kind?: string; argsRaw?: unknown } : null
    if (blk === null || blk.kind !== 'tool-call') continue
    const s = summaryInArgs(parseCallArgs(blk.argsRaw))
    if (s !== null) return s
  }
  return null
}

/** assistant 节点中的全部工具调用名：折叠只为无文本的回复保留
 * `calls`，因此同时带文本与调用的回复要靠 conversation join 找回它的调用面包屑。 */
export function callNamesOf(conv: ConversationNodeLike | undefined): string[] {
  if (conv === undefined || !Array.isArray(conv.blocks)) return []
  const names: string[] = []
  for (const b of conv.blocks) {
    const blk = b !== null && typeof b === 'object' ? b as { kind?: string; name?: unknown } : null
    if (blk !== null && blk.kind === 'tool-call' && typeof blk.name === 'string') names.push(blk.name)
  }
  return names
}
