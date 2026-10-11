/**
 * token 计价——沿用 harness token-meter 的固定密度启发式
 * （`dsh-token-meter/estimate.ts`）：4 字符 ≈ 1 token，每个内容块 +4，角色框架 +4。
 *
 * 唯一的分歧：`image` 块按像素尺寸走视觉文档计算器（shared/imageTokens.ts），
 * 拿不到结果时才回落到 meter 的 JSON 价。
 */

import { estimateImageTokens } from '../shared/imageTokens'

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

/** meter 对工具列表按整个数组计价，
 * 外层数组算一次 `BLOCK_OVERHEAD`；空列表不计费。 */
export function estimateToolsTotal(tools: unknown[]): number {
  return tools.length > 0
    ? Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    : 0
}

/** meter 读取的块字段；附件带的是原始尺寸，不是解码后的像素。 */
export interface ContentBlock {
  type: string
  text?: string
  name?: string
  arguments?: string
  content?: ContentBlock[]
  callId?: string
  /** 持久图片附件的引用；日志不可信，因此 fold 会重新核验其形状。 */
  attachment?: { width?: unknown; height?: unknown } | null
}

function estimateBlocks(blocks: unknown): number {
  let tokens = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    // null 或原始值元素只按裸开销计价，而不是把整个 fold 抛崩。
    if (item === null || typeof item !== 'object') {
      tokens += BLOCK_OVERHEAD
      continue
    }
    const block = item as ContentBlock
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil((block.text || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil((block.name || '').length / CHARS_PER_TOKEN)
          + Math.ceil((block.arguments || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'image': {
        const ref = block.attachment
        const priced = ref !== null && typeof ref === 'object'
          && typeof ref.width === 'number' && typeof ref.height === 'number'
          ? estimateImageTokens(ref.width, ref.height)
          : null
        tokens += (priced ?? Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)) + BLOCK_OVERHEAD
        break
      }
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/** 完全按 dsh meter 的口径给一条 surface 消息计价：内容为空的 assistant/developer 事件
 * 投影不出任何消息，因此计价为 0。 */
export function estimateMessage(message: { content?: ContentBlock[] } | undefined | null, emptyIsZero = false): number {
  if (emptyIsZero && (message === null || message === undefined
    || !Array.isArray(message.content) || message.content.length === 0)) {
    return 0
  }
  return estimateBlocks(message?.content) + ROLE_OVERHEAD
}

/** 单个工具的价；总量则用 meter 的整数组计价。 */
export function estimateToolSchema(tool: unknown): number {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** 递归统计图片块数；为每个节点填 `imgs`，统计面板在存活的 surface 上求和
 * （已被压缩的消息不再计入）。 */
export function imageCountOf(blocks: unknown): number {
  let count = 0
  if (!Array.isArray(blocks)) return 0
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'image') count++
    else if (Array.isArray(block.content)) count += imageCountOf(block.content)
  }
  return count
}

/** 第一个非空白文本块，空白折叠后截到 80 字符——时间线的单行预览；
 * 消息没有可渲染文本时返回 ''。 */
export function firstText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as ContentBlock
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }
  return ''
}

/** 每个 `tool-call` 块的名称，按块顺序；无名调用跳过，而不是记成空名。 */
export function toolCallNames(blocks: unknown): string[] {
  const names: string[] = []
  if (!Array.isArray(blocks)) return names
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const b = item as ContentBlock
    if (b.type === 'tool-call' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}

/** 注入消息的持久 `source`，
 * 即不可信生产者的写法；每个字段都是尽力而为。 */
export interface MessageSource {
  kind?: string
  form?: string
  name?: string
  plugin?: string
  summary?: string
  // 条目保持可为 null：任何插件都可能写出 snapshot source，预览读取不能相信元素的形状。
  sections?: ({ name?: string } | null)[]
  changes?: ({ path?: string } | null)[]
}

/** 注入事件的生产者标签，对齐 dsh transcript 的上下文来源口径：
 * 工作区指令报出它协调过的文件，插件来源报其 id，其他生产者报其持久 kind。 */
export function injectionSourceName(source: MessageSource | null | undefined): string {
  if (source?.kind === 'agent-instructions' && Array.isArray(source.changes)) {
    const paths: string[] = []
    for (const change of source.changes) {
      const path = change?.path
      if (typeof path === 'string' && path !== '' && !paths.includes(path)) paths.push(path)
    }
    if (paths.length > 0) return paths.join(', ')
  }
  const plugin = source?.plugin
  if (typeof plugin === 'string' && plugin !== '') return plugin
  const kind = source?.kind
  return typeof kind === 'string' && kind !== '' ? kind : ''
}

/** `user/message` 的 source 是否把它标记为注入上下文而非人类输入。 */
export function isInjection(source: MessageSource | null | undefined): source is MessageSource {
  // 对齐 dsh transcript 的分类（conversation-nodes/message.ts）：只要持久 source 的 kind
  // 不是 'user'（'user-rpc' 的 kind 仍是 'user'），这条 user/message 就是注入上下文；
  // 后半段的 form 判断用于兜住 kind 不可读的外部 source。
  return source !== null && source !== undefined
    && ((typeof source.kind === 'string' && source.kind !== '' && source.kind !== 'user')
      || typeof source.form === 'string')
}
