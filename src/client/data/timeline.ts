/**
 * The timeline source: one reconciled view over the two wire generations of `contextTimeline`.
 *
 * Two generations exist and both must keep working:
 *   - **inline** — collections ride along with the value (old hosts, hosts with no route, the
 *     below-baseline gate). Nothing to fetch, nothing to retry.
 *   - **split** — a slim head small enough for every `session.list` row and push frame, with the
 *     collections read from `/api/dsh-cost-breakdown/detail` whenever the pushed `detailRev` moves
 *     past what has already landed.
 *
 * `detailRev` is the marker and the cursor. Three race conditions are handled explicitly because
 * each one produced a visible bug before:
 *
 *   1. **A re-fold restarts the numbering.** A head rev *lower* than the last one seen is not "stale",
 *      it is a fresh fold — the ledger resets and in-flight reads from the old fold are discarded.
 *   2. **Newest wins, with one exception.** A read whose rev exactly matches the rev it was aimed at
 *      is accepted even when it does not beat `acceptedRev`; that is the re-fold case, where the
 *      target rev is the only trustworthy key.
 *   3. **A parked store must not fetch.** With no listener there is nobody to read an answer, so a
 *      store keeps its payload (instant repaint) but starts no work. Re-mount keeps the backoff when
 *      a payload exists, so a rapid remount cannot hammer a failing route.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { Snapshot, TimelineDetail } from '../../wire/model'
import { collectionsOf, snapshotOf } from '../shell/washers'

/** The host's detail route. Re-declared here because the bundle inlines every import and must never
 * pull in a host module. */
const DETAIL_ROUTE = '/api/dsh-cost-breakdown/detail'

/** Narrow the detail endpoint payload. A missing or invalid `rev` rejects the **whole** payload: the
 * caller then shows a retryable prompt instead of half-merged data. A malformed embedded head is
 * dropped on its own. */
export function detailOf(value: unknown): TimelineDetail | null {
  if (value === null || typeof value !== 'object') return null
  const data = value as Record<string, unknown>
  if (typeof data.rev !== 'number' || !Number.isFinite(data.rev) || data.rev < 0) return null
  const head = snapshotOf(data.head)
  return {
    rev: data.rev,
    ...(head !== null ? { head } : {}),
    ...collectionsOf(data),
  }
}

/** A detail reader for one session over the plugin's own `/api` route. Rejects on both a failed
 * request and a malformed payload, so the store's catch is the single failure path. */
export function makeDetailFetcher(sessionId: string): (() => Promise<TimelineDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return async () => {
    const response = await fetch(DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!response.ok) throw new Error(`dsh-cost-breakdown: detail route HTTP ${response.status}`)
    if (response.status === 0) throw new Error('dsh-cost-breakdown: detail route unreachable')
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') throw new Error('dsh-cost-breakdown: detail envelope malformed')
    const envelope = body as { ok?: unknown; value?: unknown }
    if (envelope.ok !== true) throw new Error('dsh-cost-breakdown: detail read failed')
    // `null` is a typed "this session has no fold" answer, not a failure.
    if (envelope.value === null || envelope.value === undefined) return null
    const detail = detailOf(envelope.value)
    if (detail === null) throw new Error('dsh-cost-breakdown: detail payload malformed')
    return detail
  }
}

/** The store's observable snapshot. Rebuilt on every transition and reference-gated, because
 * `useSyncExternalStore` compares by reference. */
export interface DetailSnapshot {
  /** The accepted detail; kept during a re-fetch so the card never flashes back to loading. */
  detail: TimelineDetail | null
  failed: boolean
  pending: boolean
}

const IDLE: DetailSnapshot = { detail: null, failed: false, pending: false }

/** Trailing-edge debounce before a fetch, so a burst of pushes produces one read. */
const DEBOUNCE_MS = 300

/** One session's detail ledger. Exported for tests; the app reaches it through `detailStoreOf`. */
export class DetailLedger {
  private detail: TimelineDetail | null = null
  /** The rev `detail` reflects; -1 before the first landing. */
  private landedRev = -1
  /** The newest head rev still needing a read. */
  private wantedRev = -1
  /** The rev the in-flight read is aimed at — the key that lets a re-fold result be accepted. */
  private aimedRev = -1
  /** The last head rev seen; a **decrease** means the host re-folded and restarted numbering. */
  private lastHeadRev = -1
  private generation = 0
  private failed = false
  private inFlight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  /** No view holds this store. It keeps its payload so a remount repaints instantly, but starts no
   * reads: the map lives as long as the page, so a live store would otherwise hang off a dead route
   * forever. */
  private parked = false
  private readonly listeners = new Set<() => void>()
  private snapshot: DetailSnapshot = IDLE

  constructor(
    private readonly fetcher: (() => Promise<TimelineDetail | null>) | undefined,
    private readonly baseDelay: number = DEBOUNCE_MS,
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.parked) {
      this.parked = false
      // Resuming with no payload at all: clear the ledger and the old backoff so this mount fetches
      // for itself instead of being stuck on the previous failure prompt. A store that still holds a
      // payload keeps its backoff, so rapid remounts cannot hammer a failing route.
      if (this.detail === null) {
        this.reset()
        this.failures = 0
      }
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.park()
    }
  }

  readonly getSnapshot = (): DetailSnapshot => this.snapshot

  /** A head rev arrived: schedule a trailing read when it is ahead of what has landed. A **decrease**
   * means the host re-folded and the numbering restarted, so the ledger resets. */
  request(rev: number): void {
    if (rev < this.lastHeadRev) this.reset()
    this.lastHeadRev = rev
    if (rev <= this.landedRev || rev <= this.wantedRev) return
    this.wantedRev = rev
    this.schedule()
  }

  /** User-initiated retry: drop the backoff and read now (only when there is nothing to show). */
  readonly retry = (): void => {
    this.failures = 0
    if (this.detail !== null) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.inFlight) void this.fire()
  }

  private reset(): void {
    this.generation++
    this.landedRev = -1
    this.wantedRev = -1
    this.detail = null
    this.failed = false
    // The snapshot itself holds a payload reference; sever it too, or a released detail stays
    // reachable through a second path.
    this.snapshot = IDLE
  }

  get active(): boolean {
    return this.listeners.size > 0
  }

  get hasPayload(): boolean {
    return this.detail !== null
  }

  /** Park the store: drop the cached payload and pending work. Called on an idle store once the
   * page's budget is exceeded. */
  release(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.reset()
    this.failures = 0
  }

  private park(): void {
    this.parked = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emit()
  }

  private schedule(): void {
    // Nobody would read a parked store's answer, so never start a read.
    if (this.parked || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, this.baseDelay * 2 ** Math.min(this.failures, 3))
    this.emit()
  }

  private async fire(): Promise<void> {
    // A trailing timer fired while an earlier read is still in flight; that read re-arms when it
    // lands if the wanted rev is still ahead.
    if (this.inFlight) return
    if (this.fetcher === undefined) {
      this.failed = true
      this.emit()
      return
    }
    this.inFlight = true
    this.aimedRev = this.wantedRev
    const generation = this.generation
    this.emit()
    try {
      const detail = await this.fetcher()
      // A reset happened while the read was in flight (re-fold, release): this result belongs to a
      // superseded generation and must not overwrite the new ledger.
      if (generation !== this.generation) return
      if (detail !== null) {
        // Newest wins, plus one exception: a detail whose rev is **exactly** what this read aimed at
        // is accepted even when it does not beat `landedRev` — that is the re-fold case, where the
        // host restarted numbering and the aimed-at rev is the trustworthy key.
        if (detail.rev >= this.landedRev || detail.rev === this.aimedRev) {
          this.detail = detail
          this.landedRev = detail.rev
        }
        this.failures = 0
        this.failed = false
      } else {
        // Absent (the session left the live set): keep the previous detail, stop the trailing read
        // until the head moves again, and only arm the prompt when there is nothing to show.
        this.wantedRev = this.landedRev
        this.failed = this.detail === null
        this.failures++
      }
    } catch {
      if (generation === this.generation) {
        this.failed = this.detail === null
        this.failures++
      }
    } finally {
      this.inFlight = false
      if (this.wantedRev > this.landedRev) this.schedule()
      this.emit()
    }
  }

  private emit(): void {
    const pending = this.timer !== null || this.inFlight
    const next: DetailSnapshot = { detail: this.detail, failed: this.failed, pending }
    if (next.detail === this.snapshot.detail && next.failed === this.snapshot.failed && next.pending === this.snapshot.pending) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/** How many sessions may keep a fetched payload. One large payload measured ~194 KB of JSON, and
 * this map lives as long as the page, so the oldest idle stores are parked and re-fetch on demand. */
const LEDGERS_MAX = 8

/** Page-lifetime registry, shared by the tab and the modal so an open tab serves the modal with no
 * second fetch. */
const ledgers = new Map<string, DetailLedger>()

function payloadHolders(): number {
  let held = 0
  for (const ledger of ledgers.values()) if (ledger.hasPayload) held++
  return held
}

/** The per-session ledger. Re-inserting a **known** id moves it to the newest end, so the eviction
 * below always hits the least-recently-opened session; every id ever opened keeps its ledger and its
 * cached payload. */
export function detailLedgerOf(sessionId: string): DetailLedger {
  const known = ledgers.get(sessionId)
  const ledger = known ?? new DetailLedger(makeDetailFetcher(sessionId))
  if (known !== undefined) ledgers.delete(sessionId)
  ledgers.set(sessionId, ledger)
  // A ledger with no payload is about to fetch one, so it counts as one extra; an active ledger is on
  // screen and never parked.
  let excess = payloadHolders() - LEDGERS_MAX + (ledger.hasPayload ? 0 : 1)
  for (const candidate of ledgers.values()) {
    if (excess <= 0) break
    if (candidate.active || !candidate.hasPayload) continue
    candidate.release()
    excess--
  }
  return ledger
}

/** Drop every per-session ledger — for tests, and for "a scope change must not keep serving another
 * account's cached detail". */
export function resetDetailLedgers(): void {
  ledgers.clear()
}

/** What a card renders: `legacy` means there is no detail channel at all (nothing to retry),
 * `failed` means a read settled without a usable value (retryable). */
export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'

/** One view's read of the timeline: the merged value, plus what to show while it is not ready. */
export interface TimelineSource {
  data: Snapshot | null
  detailState: DetailState
  retryDetail: () => void
}

/** Merge a slim head with a landed detail. The detail's collections replace the head's (empty) ones,
 * and its floor values land as a pair; `fileOps`/`spans` land only when the detail carries them, so
 * an older host's absence stays visible. */
export function mergeTimeline(base: Snapshot, detail: TimelineDetail): Snapshot {
  return {
    ...base,
    requests: detail.requests,
    events: detail.events,
    nodes: detail.nodes,
    droppedNodes: detail.droppedNodes,
    archive: detail.archive,
    ...(detail.surfaceFloor !== undefined ? { surfaceFloor: detail.surfaceFloor } : {}),
    ...(detail.archiveFloor !== undefined ? { archiveFloor: detail.archiveFloor } : {}),
    ...(detail.fileOps !== undefined ? { fileOps: detail.fileOps } : {}),
    ...(detail.fileOpsFloor !== undefined ? { fileOpsFloor: detail.fileOpsFloor } : {}),
    ...(detail.spans !== undefined ? { spans: detail.spans } : {}),
  }
}

/**
 * One view's read of the timeline, wired to the seat.
 *
 * Hook-order safe: every hook runs unconditionally, and the branches below only shape the returned
 * record. The three cases are genuinely different states, and the caller words them differently:
 *   - `legacy` — an inline value with no detail channel at all; nothing to retry.
 *   - `loading` — a slim head arrived (or a cold read is in flight); the head's own counters render
 *     while the collections are on their way.
 *   - `failed` — a read settled without a usable value; offer a retry rather than a spinner that never
 *     stops.
 */
export function useTimelineSource({ sessionId, useProjection }: { sessionId?: string; useProjection?: (key: string) => unknown }): TimelineSource {
  const head = typeof useProjection === 'function' ? snapshotOf(useProjection('contextTimeline')) : null
  const id = typeof sessionId === 'string' ? sessionId : ''
  // The split marker: a slim head carries the detail revision. `null` means there is no channel
  // (inline value, gate fallback, damaged payload).
  const headRev = head !== null && typeof head.detailRev === 'number' ? head.detailRev : null
  const slim = headRev !== null
  // Kick the cold path whenever no value has been pushed yet: the source opens the channel itself
  // (rev 0) instead of waiting for a push that may never come.
  const cold = head === null
  const ledger = useMemo(
    () => (slim || cold ? detailLedgerOf(id) : null),
    [id, slim, cold],
  )
  const snapshot = useSyncExternalStore(
    ledger !== null ? ledger.subscribe : NO_SUBSCRIBE,
    ledger !== null ? ledger.getSnapshot : IDLE_SNAPSHOT,
    // The server snapshot matches the client's idle read: the plugin has no server-side renderer, but the
    // third argument keeps the hook valid under any renderer that asks for one.
    ledger !== null ? ledger.getSnapshot : IDLE_SNAPSHOT,
  )
  useEffect(() => {
    // A pushed head revision drives the trailing re-read; a cold start asks for rev 0.
    if (ledger !== null) ledger.request(headRev ?? 0)
  }, [ledger, headRev])

  return useMemo<TimelineSource>(() => {
    const detail = snapshot.detail
    const retry = ledger !== null ? ledger.retry : NO_RETRY
    if (head !== null && !slim) return { data: head, detailState: 'legacy', retryDetail: NO_RETRY }
    // The head to render: the pushed value, or the slim head that rode along with the detail read.
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      // Nothing to render yet — the cold read is in flight, or it settled with nothing usable. That is a
      // retryable failure, never a spinner with no end.
      const failed = ledger !== null && (snapshot.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry }
    }
    if (detail === null) {
      // The head's own counters are renderable while the first read is in flight, or after it settled
      // with no data (the failure prompt sits beside them).
      return { data: base, detailState: snapshot.failed ? 'failed' : 'loading', retryDetail: retry }
    }
    return { data: mergeTimeline(base, detail), detailState: 'ready', retryDetail: retry }
  }, [head, slim, ledger, snapshot])
}

const NO_SUBSCRIBE = (): (() => void) => () => {}
const NO_RETRY = (): void => {}
const IDLE_SNAPSHOT = (): DetailSnapshot => IDLE
