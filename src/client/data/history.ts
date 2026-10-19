/**
 * The context browser's on-demand history reads.
 *
 * The detail channel serves the *bounded* window: the newest requests, the retained events, the node slice.
 * The browser needs more than that — clicking a step from two hundred steps ago should show what the message
 * actually said, and the header's tool schemas are not on the wire at all. Both come from one anchored read
 * of the durable log.
 *
 * Why anchored rather than paged: the gateway's history verb accepts `throughSeq`, an **inclusive** cut that
 * must name an event in the log, so one read lands exactly on the page carrying that event. Paging from the
 * head would be both slower and less precise.
 *
 * The face arrives through a **declarative** inject (`remote` and `remote.session` in the same fiber): the
 * tracked proxy resolves `.session` through the context, and an undeclared read throws. The first render can
 * therefore beat the face, so consumers subscribe rather than capture it once.
 */

import { useSyncExternalStore } from 'react'
import type { ConversationNode, SessionPageFace } from '../shell/contracts'

/** One content block's mapping into the browser's vocabulary; an unmappable block passes through. */
function assistantBlock(block: unknown): Record<string, unknown> {
  if (block === null || typeof block !== 'object') return { type: 'text', text: '' }
  const record = block as Record<string, unknown>
  // A reasoning block is folded into the assistant's text: the browser shows what the model said and thought,
  // in one cell, because the log does not preserve the split for a historical read.
  if (record.type === 'reasoning' && typeof record.text === 'string') return { type: 'text', text: record.text }
  return record
}

/** A message's text blocks, concatenated. A whitespace-only prompt is still a prompt and is preserved. */
function textOf(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null
  let out = ''
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string') out += text
  }
  return out.trim() === '' ? null : out
}

/** One history row's event envelope; a packed chunk row projects to nothing and is skipped. */
function eventOf(entry: unknown): { type: string; seq: number; data: Record<string, unknown> } | null {
  if (entry === null || typeof entry !== 'object') return null
  const outer = entry as { event?: unknown }
  const inner = outer.event ?? entry
  if (inner === null || typeof inner !== 'object') return null
  const record = inner as { type?: unknown; seq?: unknown; data?: unknown }
  if (typeof record.type !== 'string' || typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return null
  return {
    type: record.type,
    seq: record.seq,
    data: record.data !== null && typeof record.data === 'object' ? record.data as Record<string, unknown> : {},
  }
}

/**
 * Map one page of raw events into renderable nodes, keyed by seq.
 *
 * Compaction checkpoints are recognised by their `compactionId` source and rendered as the summary rather
 * than as the injected envelope the model saw — the browser's job is to explain the context, and the summary
 * is the explanation.
 */
export function pageNodesOf(rows: readonly unknown[]): Map<number, ConversationNode> {
  const nodes = new Map<number, ConversationNode>()
  const summaries = new Map<string, string>()
  const calls = new Map<string, { name: string; argsRaw: string }>()
  // A first pass so a checkpoint can find its summary even when the summary row precedes it on the page.
  for (const entry of rows) {
    const event = eventOf(entry)
    if (event === null) continue
    if (event.type === 'tool/call') {
      const callId = event.data.callId
      const name = event.data.name
      if (typeof callId === 'string' && typeof name === 'string') {
        calls.set(callId, { name, argsRaw: typeof event.data.arguments === 'string' ? event.data.arguments : '' })
      }
      continue
    }
    if (event.type !== 'compaction/summary') continue
    const compactionId = event.data.compactionId
    if (typeof compactionId !== 'string') continue
    const summary = textOf(event.data.summary)
    if (summary !== null) summaries.set(compactionId, summary)
  }
  for (const entry of rows) {
    const event = eventOf(entry)
    if (event === null) continue
    const { type, seq, data } = event
    if (type === 'user/message') {
      const source = data.source !== null && typeof data.source === 'object'
        ? data.source as Record<string, unknown>
        : null
      // A compaction checkpoint: render its summary, or nothing when the summary is off this page.
      if (source !== null && source.kind === 'plugin' && typeof source.compactionId === 'string') {
        nodes.set(seq, { kind: 'compaction', seq, summary: summaries.get(source.compactionId) ?? null })
        continue
      }
      nodes.set(seq, {
        kind: 'user',
        seq,
        content: Array.isArray(data.content) ? data.content as readonly unknown[] : [],
      })
      continue
    }
    if (type === 'assistant/message') {
      const message = data.message !== null && typeof data.message === 'object'
        ? data.message as Record<string, unknown>
        : null
      const content = message !== null && Array.isArray(message.content) ? message.content : []
      nodes.set(seq, { kind: 'assistant', seq, blocks: (content as unknown[]).map(assistantBlock) })
      continue
    }
    if (type === 'tool/result') {
      const message = data.message !== null && typeof data.message === 'object'
        ? data.message as Record<string, unknown>
        : null
      const source = message?.source !== null && typeof message?.source === 'object'
        ? message.source as Record<string, unknown>
        : null
      const callId = typeof message?.toolCallId === 'string'
        ? message.toolCallId
        : typeof source?.callId === 'string' ? source.callId : null
      nodes.set(seq, {
        kind: 'tool-result',
        seq,
        call: callId !== null ? calls.get(callId) ?? null : null,
        content: Array.isArray(message?.content) ? message.content as readonly unknown[] : [],
        isError: message?.isError === true,
      })
      continue
    }
  }
  return nodes
}

/** The header epoch content the browser renders: the prompt text, and each tool's description and raw schema. */
export interface HeaderContent {
  system?: string
  tools: Array<{ name: string; description?: string; schema?: unknown }>
}

/** Map one `request/header` or `system/message` into the browser's header content. */
export function headerContentOf(event: { type: string; data: Record<string, unknown> }): HeaderContent | null {
  if (event.type === 'system/message') {
    const message = event.data.message !== null && typeof event.data.message === 'object'
      ? event.data.message as Record<string, unknown>
      : null
    const system = textOf(message?.content)
    return system === null ? null : { system, tools: [] }
  }
  const header = event.data.header !== null && typeof event.data.header === 'object'
    ? event.data.header as Record<string, unknown>
    : null
  if (header === null) return null
  const raw = Array.isArray(header.tools) ? header.tools : []
  const tools: HeaderContent['tools'] = []
  for (const item of raw) {
    const tool = item !== null && typeof item === 'object' ? item as Record<string, unknown> : null
    tools.push({
      name: tool !== null && typeof tool.name === 'string' ? tool.name : '?',
      ...(tool !== null && typeof tool.description === 'string' && tool.description !== ''
        ? { description: tool.description }
        : {}),
      schema: item,
    })
  }
  return { tools }
}

/** The bound page verb, published by the declarative inject. */
let declaredPage: SessionPageFace['page'] | undefined
const listeners = new Set<() => void>()

function setPage(page: SessionPageFace['page'] | undefined): void {
  declaredPage = page
  for (const listener of listeners) listener()
}

/** The current page verb, or `undefined` before the inject lands (or after it is revoked). */
export function historyFace(): SessionPageFace['page'] | undefined {
  return declaredPage
}

/** Subscribe to the face arriving or being revoked, so a fetcher built before it landed can be rebuilt. */
export function subscribeHistoryFace(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function faceSnapshot(): SessionPageFace['page'] | undefined {
  return declaredPage
}

/** The React seat over the face; the browser rebuilds its fetchers when this changes. */
export function useHistoryFace(): SessionPageFace['page'] | undefined {
  return useSyncExternalStore(subscribeHistoryFace, faceSnapshot, faceSnapshot)
}

/** Read the bound verb off the injected face without letting a hostile accessor throw into the fiber. */
function pageOf(face: unknown): SessionPageFace['page'] | undefined {
  if (face === null || typeof face !== 'object') return undefined
  try {
    const page = (face as Record<string, unknown>).page
    return typeof page === 'function' ? (page as SessionPageFace['page']).bind(face) : undefined
  } catch {
    return undefined
  }
}

/** Register the history faces through a declarative inject.
 *
 * `remote` and `remote.session` must both be in the same fiber's requirement list: the tracked proxy resolves
 * `.session` through the context, and an undeclared read throws.
 */
export function watchHistoryFaces(ctx: { inject(names: readonly string[], callback: (ctx: unknown) => unknown): unknown }): void {
  ctx.inject(['remote', 'remote.session'], (inner) => {
    try {
      const remote = (inner as { remote?: { session?: unknown } }).remote
      setPage(remote?.session !== undefined ? pageOf(remote.session) : undefined)
    } catch {
      setPage(undefined)
    }
    return () => { setPage(undefined) }
  })
}

/** The rows of one history response. A `{ok, value}` envelope or a bare `{records}` payload both pass; anything
 * else **throws**, so the caller can offer a retry instead of claiming the event is absent. */
function rowsOf(response: unknown): readonly unknown[] {
  let payload: unknown = response
  if (payload !== null && typeof payload === 'object' && 'ok' in payload) {
    const envelope = payload as { ok?: unknown; value?: unknown }
    if (envelope.ok !== true || envelope.value === null || typeof envelope.value !== 'object') {
      throw new Error('history rpc failed')
    }
    payload = envelope.value
  }
  if (payload === null || typeof payload !== 'object') throw new Error('history rpc failed')
  const records = (payload as { records?: unknown }).records
  if (!Array.isArray(records)) throw new Error('history rpc failed')
  return records
}

/** A reader anchored at one seq, or `undefined` when the face has not landed. */
function readerOf(sessionId: string): ((seq: number) => Promise<unknown>) | undefined {
  const page = declaredPage
  if (page === undefined) return undefined
  return seq => page({
    address: { kind: 'session', sessionId },
    // `throughSeq` is the inclusive cut naming the event; `beforeSeq` is the exclusive upper bound.
    throughSeq: seq,
    beforeSeq: seq + 1,
  }, new AbortController().signal)
}

/** A per-session content fetcher. Returns `undefined` without a face, and the caller keeps its static
 * fallback (a preview with a note). */
export function makeContentFetcher(sessionId: string): ((seq: number) => Promise<ConversationNode | null>) | undefined {
  const read = readerOf(sessionId)
  if (read === undefined) return undefined
  const cache = new Map<number, ConversationNode>()
  return async (seq) => {
    // Only landed nodes are cached: history is immutable, so a hit is final — but a miss is not, because a page
    // cut at `throughSeq` can see an event the live stream appends later. Retrying an absent event is correct.
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    const node = pageNodesOf(rowsOf(await read(seq))).get(seq) ?? null
    if (node !== null) cache.set(seq, node)
    return node
  }
}

/** A per-session header fetcher for the browser's System and Tools rows. */
export function makeHeaderFetcher(sessionId: string): ((seq: number) => Promise<HeaderContent | null>) | undefined {
  const read = readerOf(sessionId)
  if (read === undefined) return undefined
  const cache = new Map<number, HeaderContent>()
  return async (seq) => {
    const hit = cache.get(seq)
    if (hit !== undefined) return hit
    const rows = rowsOf(await read(seq))
    let picked: HeaderContent | null = null
    for (const entry of rows) {
      const event = eventOf(entry)
      if (event === null) continue
      if (event.type !== 'request/header' && event.type !== 'system/message') continue
      const content = headerContentOf(event)
      if (content === null) continue
      // The page's exclusive bound is `seq + 1`, so every content event on it is the selected one or older, and
      // all of them are final.
      cache.set(event.seq, content)
      if (event.seq === seq) picked = content
    }
    return picked
  }
}

/** Test seam: publish a page verb without a harness (passing `undefined` clears it). */
export function setHistoryFaceForTest(page: SessionPageFace['page'] | undefined): void {
  setPage(page)
}
