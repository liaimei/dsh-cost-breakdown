/**
 * Step-context reconstruction — the pure rebuild behind the Context Browser.
 *
 * A request row is a snapshot of what the model saw at dispatch: the header generation in force, plus
 * the surface nodes visible **before** the response landed. This module replays that snapshot from
 * the two things the wire keeps: the live surface (`nodes`) with its archive of evicted entries, and
 * the header timeline.
 *
 * Two honesty flags come out of it, and the UI turns them into notes rather than silently passing
 * them off as exact: `missingLive` (older nodes dropped from the served window) and `approximate`
 * (the cut predates what the archive still retains).
 */

import type { HeaderEpoch, HeaderTimeline, RequestRow, Snapshot, SurfaceEntry } from '../../../wire/model'

/** One live system-prompt node, derived from the snapshot's own array so the two cannot drift. */
export type SystemNode = NonNullable<Snapshot['systems']>[number]

/** A rebuild of the context at one dispatch. `live` marks the current surface (no cut at all). */
export interface Assembled {
  live: boolean
  header: HeaderEpoch | null
  /** The effective system prompt node: the last live one carrying tokens. */
  system: SystemNode | null
  nodes: SurfaceEntry[]
  missingLive: number
  approximate: boolean
}

/**
 * The latest header generation **strictly before** `seq` — i.e. the one in force when that request
 * was dispatched. `seq === null` asks for the current step, which uses the newest generation. Before
 * the first generation there is none, so the earliest requests legitimately resolve to `null`.
 */
export function headerAt(headers: HeaderTimeline | null, seq: number | null): HeaderEpoch | null {
  if (headers === null || headers.headers.length === 0) return null
  if (seq === null) return headers.headers[headers.headers.length - 1]
  for (let i = headers.headers.length - 1; i >= 0; i--) {
    if (headers.headers[i].seq < seq) return headers.headers[i]
  }
  return null
}

/**
 * The last live system node with tokens at or before `seq` — exactly the fold's own rule ("the last
 * non-empty system prompt still on the surface"), which is why a step's system figure matches the
 * fold's record. Rows folded before `systems` existed fall back to the header generation's envelope
 * number.
 */
export function systemAt(data: Snapshot, header: HeaderEpoch | null, seq: number | null): SystemNode | null {
  const systems = data.systems
  if (systems !== undefined && systems.length > 0) {
    for (let i = systems.length - 1; i >= 0; i--) {
      const node = systems[i]
      if (node.tokens <= 0) continue
      if (seq === null || node.seq < seq) return node
    }
    return null
  }
  const tokens = header?.systemTokens
  return tokens !== undefined && header !== null ? { seq: header.seq, time: header.time, tokens } : null
}

/**
 * Rebuild the context as the host snapshotted it for one dispatch. A `seq` of `null` is the **live**
 * step; otherwise the cut is exclusive (`node.seq < seq`), matching the request row's own seq.
 */
export function assemble(data: Snapshot, headers: HeaderTimeline | null, seq: number | null): Assembled {
  const live = seq === null
  let nodes: SurfaceEntry[]
  if (live) {
    nodes = data.nodes.slice()
  } else {
    const picked: SurfaceEntry[] = []
    for (const node of data.nodes) if (node.seq < seq) picked.push(node)
    // An archived node only counts if it was still in the context at the cut: `gone` is the seq of the
    // event that evicted it, so a node removed *before* `seq` must not reappear.
    for (const node of data.archive) {
      if (node.seq < seq && node.gone !== undefined && node.gone > seq) picked.push(node)
    }
    nodes = picked
  }
  nodes.sort((left, right) => left.seq - right.seq)

  let missingLive = 0
  if (data.droppedNodes > 0) {
    // Live: every dropped node belongs to the current context. Past steps: the dropped range sits at
    // or below `surfaceFloor`, so only later steps are flagged — an older step is a *subset*.
    if (live || (data.surfaceFloor !== undefined && seq > data.surfaceFloor)) missingLive = data.droppedNodes
  }
  const approximate = !live && data.archiveFloor !== undefined && seq < data.archiveFloor
  const header = headerAt(headers, seq)
  return { live, header, system: systemAt(data, header, seq), nodes, missingLive, approximate }
}

/** Bucket the assembled nodes by stage, keeping arrival order inside each bucket. */
export function byCatOf(asm: Assembled): Partial<Record<SurfaceEntry['cat'], SurfaceEntry[]>> {
  const buckets: Partial<Record<SurfaceEntry['cat'], SurfaceEntry[]>> = {}
  for (const node of asm.nodes) {
    const bucket = buckets[node.cat] ?? (buckets[node.cat] = [])
    bucket.push(node)
  }
  return buckets
}

/** How many items one category row holds. `system`/`tools` are header singletons, not node buckets. */
export function countOf(asm: Assembled, byCat: Partial<Record<SurfaceEntry['cat'], SurfaceEntry[]>>, category: string): number {
  if (category === 'system') return asm.system !== null ? 1 : 0
  if (category === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCat[category as SurfaceEntry['cat']]?.length ?? 0
}

/** One step's semantic identity: the turn opener, what entered since the previous step, and the
 * response. */
export interface StepBrief {
  opener?: SurfaceEntry
  inputs: SurfaceEntry[]
  response?: SurfaceEntry
}

/** Live + archived nodes as one seq-ordered list: the bounded searches below need a single monotonic
 * sequence, and an archived entry keeps its original seq. */
export function briefNodes(data: Snapshot): SurfaceEntry[] {
  return [...data.nodes, ...data.archive].sort((left, right) => left.seq - right.seq)
}

/** First index whose seq is >= `seq` (the list length when none is). Binary search, because the brief
 * is derived for whichever bar is under the pointer, once per hover. */
function lowerBound(nodes: readonly SurfaceEntry[], seq: number): number {
  let lo = 0
  let hi = nodes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (nodes[mid].seq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Derive the brief for `requests[idx]` (a step record, or a turn aggregate of one). */
export function briefOf(nodes: readonly SurfaceEntry[], requests: readonly RequestRow[], idx: number): StepBrief | null {
  if (idx < 0 || idx >= requests.length) return null
  const request = requests[idx]
  const at = lowerBound(nodes, request.seq)
  const hit = at < nodes.length && nodes[at].seq === request.seq ? nodes[at] : undefined
  const response = hit !== undefined && hit.cat === 'assistant' ? hit : undefined

  const turnStart = idx === 0 || (requests[idx - 1].turn ?? 0) !== (request.turn ?? 0)

  // The opener is the newest user message before this turn's **first** bar. Walking back over same-turn
  // siblings finds that first bar, so a mid-turn bar still attributes to the turn's own opener.
  let firstIdx = idx
  while (firstIdx > 0 && (requests[firstIdx - 1].turn ?? 0) === (request.turn ?? 0)) firstIdx--
  const upper = requests[firstIdx].seq
  const lower = firstIdx > 0 ? requests[firstIdx - 1].seq : -1
  let opener: SurfaceEntry | undefined
  for (let i = lowerBound(nodes, upper) - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node.seq <= lower) break
    if (node.cat === 'user') {
      opener = node
      break
    }
  }

  const inputs: SurfaceEntry[] = []
  if (!turnStart) {
    // The first bar is always a turn start, so `idx > 0` here.
    const prevSeq = requests[idx - 1].seq
    for (let i = lowerBound(nodes, prevSeq + 1); i < nodes.length && nodes[i].seq < request.seq; i++) inputs.push(nodes[i])
  }
  return { opener, inputs, response }
}

/** Every boundary event (compaction/prune) attaches to the first request recorded after it. Shared by
 * the chart's scissors markers and the detail panel, so both name the same event. */
export function attachMarkers(requests: readonly RequestRow[], events: Snapshot['events']): Array<Snapshot['events'][number] | undefined> {
  const markers: Array<Snapshot['events'][number] | undefined> = Array.from({ length: requests.length })
  for (const event of events) {
    if (event.kind !== 'compaction' && event.kind !== 'prune') continue
    for (let r = 0; r < requests.length; r++) {
      if (requests[r].seq >= event.seq) {
        if (markers[r] === undefined) markers[r] = event
        break
      }
    }
  }
  return markers
}
