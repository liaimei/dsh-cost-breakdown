/**
 * Token estimation heuristics.
 *
 * Numbers here are not cosmetic: the composition card, the request table and the cost ledger all
 * read them, so a rewrite that "improves" a constant silently changes what every historical row
 * means. These mirror the harness token meter's fixed density.
 *
 * Rule of thumb: 4 characters ≈ 1 token, plus a per-message role frame, plus a per-block
 * overhead. Images are the exception — they go through the provider's documented vision
 * calculator (see `imageTokens`).
 */

import { estimateImageTokens } from './imageTokens'

const CHARS_PER_TOKEN = 4
/** Per content block. */
const BLOCK_OVERHEAD = 4
/** Per message, once, however many blocks it has. */
const ROLE_OVERHEAD = 4
/** Previews are single-line and bounded, so a pathological message cannot blow up the wire. */
const PREVIEW_MAX = 80

/** One content block as the durable log writes it. Every field is untrusted. */
export interface ContentBlock {
  type: string
  text?: string
  name?: string
  arguments?: string
  content?: ContentBlock[]
  callId?: string
  /** A persisted image attachment reference; the log is not trusted, so shape is re-validated. */
  attachment?: { width?: unknown; height?: unknown } | null
}

/** The durable `source` of an injected message. Best-effort on every field. */
export interface MessageSource {
  kind?: string
  form?: string
  name?: string
  plugin?: string
  summary?: string
  sections?: ({ name?: string } | null)[]
  changes?: ({ path?: string } | null)[]
}

/** Estimated tokens of a plain system string (empty/non-string prices as 0). */
export function estimateSystemText(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/** Estimated tokens of a `system/message` block list. Empty/non-array prices as 0. */
export function estimateSystemBlocks(blocks: unknown): number {
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
      // A circular or hostile block contributes 0 rather than throwing the fold off the log.
    }
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/** Length of a value's JSON form, or 0 when it cannot be serialised (a circular or hostile block). */
function jsonLengthOf(value: unknown): number {
  try {
    const json: unknown = JSON.stringify(value)
    return typeof json === 'string' ? json.length : 0
  } catch {
    return 0
  }
}

/** The meter prices a tool list as one array: a single block overhead, nothing for an empty list. */
export function estimateTools(tools: unknown[]): number {
  if (tools.length === 0) return 0
  return Math.ceil(jsonLengthOf(tools) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/** One tool schema's price (the header card breaks totals down per tool). */
export function estimateToolSchema(tool: unknown): number {
  return Math.ceil(jsonLengthOf(tool) / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

function estimateBlocks(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0
  let tokens = 0
  for (const item of blocks) {
    // A null or primitive element still costs its bare overhead; it must not throw.
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
        const sized = ref !== null && typeof ref === 'object'
          && typeof ref.width === 'number' && typeof ref.height === 'number'
        const priced = sized ? estimateImageTokens(ref.width as number, ref.height as number) : null
        tokens += (priced ?? Math.ceil(jsonLengthOf(block) / CHARS_PER_TOKEN)) + BLOCK_OVERHEAD
        break
      }
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(jsonLengthOf(block) / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

/**
 * Estimated tokens of one surface message.
 *
 * `emptyIsZero` is for assistant/developer events: an empty one projects no model message at
 * all, so it must price 0 rather than just the role frame.
 */
export function estimateMessage(message: { content?: ContentBlock[] } | undefined | null, emptyIsZero = false): number {
  if (emptyIsZero) {
    const empty = message === null || message === undefined
      || !Array.isArray(message.content) || message.content.length === 0
    if (empty) return 0
  }
  return estimateBlocks(message?.content) + ROLE_OVERHEAD
}

/** Number of image blocks on a message, counted recursively (nested tool content included). */
export function countImages(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0
  let count = 0
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'image') count++
    else if (Array.isArray(block.content)) count += countImages(block.content)
  }
  return count
}

/** First non-blank text block, whitespace-collapsed and cut to {@link PREVIEW_MAX}. */
export function firstText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return block.text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX)
    }
  }
  return ''
}

/** First non-empty text block verbatim — skill names are matched inside the raw wrapper, so this
 * one must not truncate or normalise. */
export function firstRawText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
  }
  return ''
}

/** Every `tool-call` block name, in block order. Unnamed calls are skipped, not recorded blank. */
export function toolCallNames(blocks: unknown): string[] {
  const names: string[] = []
  if (!Array.isArray(blocks)) return names
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'tool-call' && typeof block.name === 'string') names.push(block.name)
  }
  return names
}

/** The producer label of an injected context block, matching the harness transcript's wording:
 * workspace instructions name the files they coordinated, plugin producers report their id, and
 * anything else reports its durable kind. */
export function injectionLabel(source: MessageSource | null | undefined): string {
  if (source?.kind === 'agent-instructions' && Array.isArray(source.changes)) {
    const paths: string[] = []
    for (const change of source.changes) {
      const path = change?.path
      if (typeof path === 'string' && path !== '' && !paths.includes(path)) paths.push(path)
    }
    if (paths.length > 0) return paths.join(', ')
  }
  if (typeof source?.plugin === 'string' && source.plugin !== '') return source.plugin
  return typeof source?.kind === 'string' ? source.kind : ''
}

/** Whether a `user/message` source marks injected context rather than a human input.
 *
 * Matches the transcript's rule: any durable kind other than `'user'` (the RPC wrapper still
 * reports `'user'`) is an injection, and a `form` catches sources whose kind is unreadable.
 */
export function isInjection(source: MessageSource | null | undefined): boolean {
  if (source === null || source === undefined) return false
  const kind = source.kind
  if (typeof kind === 'string' && kind !== '' && kind !== 'user') return true
  return typeof source.form === 'string'
}

/** The skill name inside a loaded skill's rendered result text. */
const SKILL_NAME_RE = /<skill_content\s+name="([^"]+)"/

/** The skill name of a `skill` tool result, or `''` when the wrapper is absent. */
export function skillNameOf(text: string): string {
  const match = SKILL_NAME_RE.exec(text)
  return match === null ? '' : match[1]
}
