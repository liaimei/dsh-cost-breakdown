/** host fold 与 client 边界共用的 token 估算启发式，两侧都对齐 harness token-meter 的固定密度
 * （4 字符 ≈ 1 token，另加 4 的角色框架开销）。 */

const CHARS_PER_TOKEN = 4
/** harness 在文本密度之外额外加上的每消息角色框架开销。 */
const ROLE_OVERHEAD = 4

/** harness `estimateSystemMessage` 对单个纯字符串的算法。只要不是非空字符串就按 0 计价，
 * 畸形事件因此无法虚增 fold。 */
export function estimateSystemTokens(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/** 按 harness `estimateSystemMessage` 的口径给 `system/message` payload 计价：对每个内容块计文本
 * 密度，再加角色框架开销，不叠加每块开销。 */
export function estimateSystemContent(blocks: unknown): number {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0
  let characters = 0
  for (const block of blocks) {
    const text = block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? (block as { text?: unknown }).text
      : undefined
    if (typeof text === 'string') {
      characters += text.length
      continue
    }
    try {
      const json: unknown = JSON.stringify(block)
      if (typeof json === 'string') characters += json.length
    } catch {
      // 循环引用或恶意的内容块计 0，而不是把整个 fold 抛崩。
    }
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}
