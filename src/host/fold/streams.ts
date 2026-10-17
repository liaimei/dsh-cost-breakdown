/**
 * Shape-driven readers for the durable event dialect — the one place this plugin touches the
 * session log's wire spellings.
 *
 * Supported scope (harness 0.1.7-rc.2+, session format V4) is exactly one dialect: `system/message`
 * surface nodes, packed assistant stream records, and `SurfaceOp { startSeq, endSeq }`. The fold
 * reads **shapes**, never a probed version; an old log the harness cannot migrate is refused before
 * it reaches here.
 *
 * Every reader is total on hostile input. The projection registry drives `apply` with no error
 * boundary, so a throw here would stall that unit's feed and leave the browser on "loading"
 * forever. Unreadable shapes therefore degrade to "no reading", never to an exception.
 */

/** One raw chunk record of an embedded assistant stream. */
export interface StreamRecord {
  type?: unknown
  time?: unknown
  chunk?: unknown
  [key: string]: unknown
}

/** Whether a raw stream chunk carries a token delta; mirrors the harness's own test. */
export function isTokenChunk(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  const candidate = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown }
  switch (candidate.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof candidate.text === 'string' && candidate.text !== ''
    case 'tool-call-delta':
      return (typeof candidate.argumentsDelta === 'string' && candidate.argumentsDelta !== '')
        || candidate.name !== undefined
    default:
      return false
  }
}

/** The decode buckets the generation split distinguishes. */
export type StreamDecodeKind = 'reasoning' | 'text' | 'toolarg'

/** Map a wire `block-start.blockType` onto a decode bucket; a `tool-call` block decodes tool args. */
export function decodeKindOfBlock(blockType: unknown): StreamDecodeKind | undefined {
  if (blockType === 'reasoning') return 'reasoning'
  if (blockType === 'text') return 'text'
  if (blockType === 'tool-call') return 'toolarg'
  return undefined
}

/** The `block-start` markers of a stream, in stream order: their instant and decode bucket. */
interface BlockMarker {
  time: number
  kind: StreamDecodeKind | undefined
}

/**
 * Read the block markers of a compacted stream.
 *
 * Only markers with a finite instant participate: a marker with a hostile time must not shift the
 * boundary of the block before it, so it is dropped entirely (its count and its tiling both go).
 */
function blockMarkersOf(stream: unknown): BlockMarker[] {
  const markers: BlockMarker[] = []
  if (!Array.isArray(stream)) return markers
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const row = record as StreamRecord
    if (row.type !== 'chunk' || row.chunk === null || typeof row.chunk !== 'object') continue
    const chunk = row.chunk as { type?: unknown; blockType?: unknown }
    if (chunk.type !== 'block-start') continue
    const time = row.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    markers.push({ time, kind: decodeKindOfBlock(chunk.blockType) })
  }
  return markers
}

/** Duration and block count attributable to one decode bucket within a generation window. */
export interface DecodeTally {
  spans: Record<StreamDecodeKind, number>
  blocks: Record<StreamDecodeKind, number>
}

/**
 * Tile `[first marker, endTime]` by block: each marker owns the span up to the next marker, the
 * last one to `endTime`. This is what makes the three buckets partition the generation window
 * exactly — a marker that opens before the first token is charged once, never to two rows.
 */
export function decodeTallyOfStream(stream: unknown, endTime: number): DecodeTally {
  const tally: DecodeTally = {
    spans: { reasoning: 0, text: 0, toolarg: 0 },
    blocks: { reasoning: 0, text: 0, toolarg: 0 },
  }
  if (!Number.isFinite(endTime)) return tally
  let kind: StreamDecodeKind | undefined
  let since = 0
  for (const marker of blockMarkersOf(stream)) {
    if (kind !== undefined) tally.spans[kind] += Math.max(0, marker.time - since)
    kind = marker.kind
    if (kind !== undefined) tally.blocks[kind] += 1
    since = marker.time
  }
  if (kind !== undefined) tally.spans[kind] += Math.max(0, endTime - since)
  return tally
}

/** One ordered decode slice, painted by the time strip in stream order. */
export interface DecodeSlice {
  kind: StreamDecodeKind
  start: number
  end: number
}

/**
 * The ordered decode slices of a stream.
 *
 * Order is preserved because the strip draws them in stream order, and an unknown marker opens
 * nothing (the caller's residue fill covers that window) while still closing the block before it.
 */
export function decodeSlicesOfStream(stream: unknown, endTime: number): DecodeSlice[] {
  const slices: DecodeSlice[] = []
  if (!Number.isFinite(endTime)) return slices
  let kind: StreamDecodeKind | undefined
  let since = 0
  const close = (to: number): void => {
    if (kind !== undefined && to > since) slices.push({ kind, start: since, end: to })
  }
  for (const marker of blockMarkersOf(stream)) {
    close(marker.time)
    kind = marker.kind
    since = marker.time
  }
  close(endTime)
  return slices
}

/**
 * The first-token instant of one packed delta run (`text-chunks` / `reasoning-chunks` /
 * `tool-call-chunks`): the run's base time plus the inter-fragment gaps accumulated up to the first
 * eligible fragment.
 *
 * Mirrors the harness's own `runFirstTokenTime`, which is the anchor TTFT is measured against. A
 * `tool-call-chunks` run that already carries its name stamps at the base time — the name arrives
 * with the opening fragment. An unusable gap makes the run unreadable rather than guessing.
 */
function packedRunFirstToken(row: Record<string, unknown>): number | undefined {
  const base = row.time0
  if (typeof base !== 'number' || !Number.isFinite(base)) return undefined
  const toolCall = row.type === 'tool-call-chunks'
  if (toolCall && row.name !== undefined) return base
  const fragments = toolCall ? row.args : row.texts
  if (!Array.isArray(fragments)) return undefined
  const gaps: readonly unknown[] = Array.isArray(row.dt) ? row.dt as unknown[] : []
  let time = base
  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) {
      const gap = gaps[index - 1]
      if (typeof gap !== 'number' || !Number.isFinite(gap)) return undefined
      time += gap
    }
    if (typeof fragment === 'string' && fragment !== '') return time
  }
  return undefined
}

/**
 * The first-token instant of an embedded assistant stream
 * (`assistant/message.data.stream` / `assistant/attempt.data.stream`).
 *
 * `undefined` means "this stream never emitted a token", which is the signal that a call's wait and
 * generation windows cannot be attributed at all (an aborted step).
 */
export function firstTokenTimeOfStream(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const row = record as Record<string, unknown>
    if (row.type === 'chunk') {
      const time = row.time
      if (typeof time === 'number' && Number.isFinite(time) && isTokenChunk(row.chunk)) return time
      continue
    }
    const stamped = packedRunFirstToken(row)
    if (stamped !== undefined) return stamped
  }
  return undefined
}

/**
 * The closed surface range a replacement op claims, or `null` for an append or any shape the fold
 * does not recognise (a malformed range degrades to an append, preserving the existing nodes).
 */
export function replacedRangeOf(surfaceOp: unknown): { start: number; end: number } | null {
  if (surfaceOp === null || typeof surfaceOp !== 'object') return null
  const op = surfaceOp as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (op.op !== 'replace') return null
  const start = op.startSeq
  const end = op.endSeq
  if (typeof start !== 'number' || !Number.isFinite(start)) return null
  if (typeof end !== 'number' || !Number.isFinite(end)) return null
  return { start, end }
}
