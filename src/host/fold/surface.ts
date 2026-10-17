/**
 * Surface bookkeeping: how one model-visible message becomes a billing node, and how a replacement
 * morphs the live node list.
 *
 * Three invariants live here and nowhere else:
 *
 * 1. **`sums` is derived, not maintained.** Every mutation of `surface` adjusts `sums` in the same
 *    breath, so the per-stage totals a request record reads can never drift from the nodes the UI
 *    lists. This is why nothing outside this module writes `surface` directly.
 * 2. **Removed nodes are archived as copies.** A removed node may be shared with the persisted
 *    previous state, so stamping `gone` onto it would mutate history. Copies it is.
 * 3. **A shadow claim is consumed exactly once.** A compaction event arms the seqs its replacement
 *    will shadow; the *next* surface event consumes the claim and it expires there. Anything later
 *    would remove nodes for a replacement that already went through.
 */

import {
  countImages, estimateMessage, firstText, isInjection, toolCallNames,
} from '../../core/tokens'
import type { MessageSource } from '../../core/tokens'
import type { LedgerEvent, Stage, SurfaceEntry, SystemNode } from '../../wire/model'
import { injectionLabel } from '../../core/tokens'
import { replacedRangeOf } from './streams'
import type { SurfaceMessage } from './records'
import type { FoldDraft, TimelineEvent } from './state'
import { SYSTEM_NODES_MAX } from './state'

/**
 * The billing stage one message event belongs to.
 *
 * Order matters: the two skill source kinds are durable `user/message` injections and would be
 * absorbed by the ordinary injection test, yet they are billed and displayed as their own bucket.
 */
export function stageOf(type: string, source: MessageSource | undefined): Stage {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (type === 'developer/message') return 'inject'
  if (source?.kind === 'skill-invocation' || source?.kind === 'skill-catalog') return 'skill'
  if (isInjection(source)) return 'inject'
  return 'user'
}

/** What the caller already learned about the message while pairing its tool lifecycle. */
export interface NodeFacts {
  /** The tool name a settled result answers, when the call lifecycle was traced. */
  tool?: string
}

/**
 * Price one message event into a surface node.
 *
 * The node is pure data at this point; {@link placeNode} decides where it lands. `emptyIsZero`
 * covers assistant and developer events: an empty one projects no model message at all, so it must
 * price 0 instead of just the role frame.
 */
export function buildSurfaceNode(
  event: TimelineEvent,
  type: string,
  message: SurfaceMessage | null,
  facts: NodeFacts = {},
): SurfaceEntry {
  const source = message?.source
  const emptyIsZero = type === 'assistant/message' || type === 'developer/message'
  const node: SurfaceEntry = {
    seq: event.seq,
    time: event.time,
    cat: stageOf(type, source),
    tokens: estimateMessage(message, emptyIsZero),
  }
  // Image blocks ride the node so the composition card can count live images; zero stays absent.
  const images = countImages(message?.content)
  if (images > 0) node.imgs = images
  if (typeof source?.form === 'string') node.form = source.form

  if (type === 'assistant/message') {
    describeAssistant(node, message)
  } else if (type === 'tool/result') {
    describeToolResult(node, message, facts)
  } else if (source?.kind === 'skill-invocation') {
    node.skill = typeof source.name === 'string' ? source.name : '?'
  } else if (source?.kind === 'plugin') {
    describePluginNode(node, message, source)
  } else {
    const text = firstText(message?.content)
    if (text !== '') node.text = text
  }
  return node
}

/** A reply previews its text, or — when it only dispatched tools — the call names it requested. */
function describeAssistant(node: SurfaceEntry, message: SurfaceMessage | null): void {
  const text = firstText(message?.content)
  if (text !== '') {
    node.text = text
    return
  }
  const names = toolCallNames(message?.content)
  if (names.length > 0) node.calls = names.slice(0, 3)
}

/** A settled result carries the tool identity it paired with and its failure mark. */
function describeToolResult(node: SurfaceEntry, message: SurfaceMessage | null, facts: NodeFacts): void {
  if (facts.tool !== undefined) node.tool = facts.tool
  if (message?.isError === true) node.err = true
}

/**
 * A plugin-produced injection previews whatever the producer gave the transcript: a notice's
 * one-line summary, a snapshot's section names, or its first text block.
 */
function describePluginNode(node: SurfaceEntry, message: SurfaceMessage | null, source: MessageSource): void {
  if (source.form === 'notice' && typeof source.summary === 'string') {
    node.text = source.summary
    return
  }
  if (source.form === 'snapshot' && Array.isArray(source.sections)) {
    const names = source.sections
      .map(section => section?.name)
      .filter((name): name is string => typeof name === 'string' && name !== '')
    node.text = names.join(', ').slice(0, 80)
    return
  }
  const text = firstText(message?.content)
  if (text !== '') node.text = text
}

/** The producer identity stamped on both the node and its event row. */
export function producerLabelOf(source: MessageSource | undefined): string {
  return injectionLabel(source)
}

/**
 * Drop any armed shadow claim, returning what it named.
 *
 * Called by every surface-bearing event: the claim belongs to the replacement that was expected to
 * follow its metering event synchronously, and expiring it here is what stops a stale claim from
 * silently deleting nodes a later, unrelated replacement never asked to shadow.
 */
function takeShadowClaim(draft: FoldDraft): { seqs: readonly number[]; eventSeq: number | undefined } {
  const seqs = draft.previous.pendingShadowedSeqs
  const eventSeq = draft.previous.pendingShadowEventSeq
  // Delete rather than assign `undefined`: an own undefined property breaks the cache write.
  delete draft.next.pendingShadowedSeqs
  delete draft.next.pendingShadowEventSeq
  return { seqs: seqs ?? [], eventSeq }
}

/** Archive copies of removed nodes, stamped with the seq of the replacement that removed them. */
function archiveNodes(draft: FoldDraft, removed: readonly SurfaceEntry[], goneSeq: number): void {
  for (const node of removed) draft.next.archived.push({ ...node, gone: goneSeq })
}

/** Remove the nodes with the given seqs, keeping `surface`/`sums` consistent. */
function removeClaimed(draft: FoldDraft, claimed: ReadonlySet<number>, goneSeq: number): SurfaceEntry[] {
  if (claimed.size === 0) return []
  const kept: SurfaceEntry[] = []
  const removed: SurfaceEntry[] = []
  for (const node of draft.next.surface) {
    if (claimed.has(node.seq)) {
      draft.next.sums[node.cat] -= node.tokens
      removed.push(node)
    } else {
      kept.push(node)
    }
  }
  archiveNodes(draft, removed, goneSeq)
  draft.next.surface = kept
  return removed
}

/**
 * Put a node on the surface: append, splice in place over a declared range, or remove the seqs an
 * armed shadow claim named.
 *
 * The claim path removes by **seq list**, not by the declared range: a truncated replacement keeps
 * its own seq past the range end, so removing by range would leave it behind and double-count it.
 * When the claim's arming event is still in the retained rows, its gross price is rewritten to the
 * net amount actually freed so the metering row agrees with the drop the trend chart draws.
 */
export function placeNode(draft: FoldDraft, event: TimelineEvent, node: SurfaceEntry): void {
  const claim = takeShadowClaim(draft)
  const range = replacedRangeOf(event.surfaceOp)
  if (range !== null) {
    if (claim.seqs.length > 0) {
      const claimed = new Set(claim.seqs)
      const removed = removeClaimed(draft, claimed, event.seq)
      draft.next.sums[node.cat] += node.tokens
      draft.next.surface.push(node)
      if (claim.eventSeq !== undefined) {
        rewriteShadowPrice(draft, claim.eventSeq, removed, node.tokens)
      }
      return
    }
    // In-place splice: the harness gives the replacement the span's position. Both endpoints must
    // point at live nodes; a malformed range degrades to an append and preserves the originals.
    let startIndex = -1
    let endIndex = -1
    for (let index = 0; index < draft.next.surface.length; index++) {
      if (startIndex < 0 && draft.next.surface[index].seq === range.start) startIndex = index
      if (draft.next.surface[index].seq === range.end) {
        endIndex = index
        break
      }
    }
    if (startIndex >= 0 && endIndex >= startIndex) {
      const removed = draft.next.surface.splice(startIndex, endIndex - startIndex + 1, node)
      archiveNodes(draft, removed, event.seq)
      for (const stale of removed) draft.next.sums[stale.cat] -= stale.tokens
      draft.next.sums[node.cat] += node.tokens
      return
    }
  }
  draft.next.surface.push(node)
  draft.next.sums[node.cat] += node.tokens
}

/**
 * Rewrite the arming metering row's price from the producer's gross claim to the net amount the
 * replacement actually freed. The row is copied — `events` elements are shared with the persisted
 * state until this draft's `touch('events')` cloned the array, and the element itself is never
 * aliased into the served view only because the wire copies per element.
 */
function rewriteShadowPrice(
  draft: FoldDraft,
  eventSeq: number,
  removed: readonly SurfaceEntry[],
  readded: number,
): void {
  let removedSum = 0
  for (const node of removed) removedSum += node.tokens
  const index = draft.next.events.findIndex(row => row.seq === eventSeq)
  if (index < 0) return
  draft.next.events[index] = { ...draft.next.events[index], tokens: Math.max(0, removedSum - readded) }
}

/** Remove ordinary surface nodes claimed by a system-message replacement (a hostile-log defence). */
export function removeSurfaceInRange(draft: FoldDraft, event: TimelineEvent): number {
  const range = replacedRangeOf(event.surfaceOp)
  if (range === null) return 0
  const claimed = new Set<number>()
  for (const node of draft.next.surface) {
    if (node.seq >= range.start && node.seq <= range.end) claimed.add(node.seq)
  }
  return removeClaimed(draft, claimed, event.seq).length
}

/**
 * Append a system-prompt node and reprice the effective prompt.
 *
 * System prompts never enter `surface`/`sums` — that would double-count them against
 * `systemTokens`, which is the envelope figure the request total reads. The effective price is the
 * last node with a positive count, so a dormant empty node keeps its position without erasing the
 * prompt that is actually in force.
 */
export function pushSystemNode(draft: FoldDraft, node: SystemNode): void {
  const systems = [...(draft.next.systems ?? []), node]
  draft.next.systems = systems.length > SYSTEM_NODES_MAX ? systems.slice(-SYSTEM_NODES_MAX) : systems
  draft.next.systemTokens = effectiveSystemTokens(draft.next.systems)
}

/** The last live system node's price, or 0 when every node is dormant. */
export function effectiveSystemTokens(systems: readonly SystemNode[]): number {
  for (let index = systems.length - 1; index >= 0; index--) {
    if (systems[index].tokens > 0) return systems[index].tokens
  }
  return 0
}

/** Drop the system nodes a replacement claims, keeping the rest in order. */
export function removeSystemInRange(draft: FoldDraft, event: TimelineEvent): void {
  const range = replacedRangeOf(event.surfaceOp)
  if (range === null) return
  const systems = draft.next.systems ?? []
  draft.next.systems = systems.filter(node => node.seq < range.start || node.seq > range.end)
}

/** Append one event row (the caller must own the `events` clone). */
export function appendEvent(draft: FoldDraft, row: LedgerEvent): void {
  draft.next.events.push(row)
}
