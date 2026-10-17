/// <reference types="node" />
/**
 * The process-wide admission gate for cold reads.
 *
 * A cold read materialises a whole persisted session log: the storage backend must decode
 * every frame before a single event can be sliced, so a 10k-event session lands as hundreds of
 * megabytes of object graph. Two independent paths do exactly that — the detail channel's
 * cold arm and the backfill sweep — and they share this one gate for three reasons:
 *
 * - **One at a time (FIFO).** Two concurrent folds can double the peak footprint, which is
 *   precisely the condition that makes the read dangerous.
 * - **Only below two thirds of the V8 heap limit.** The reserved top third is the room the read
 *   itself, and the harness's own decode buffers, will need while it runs.
 * - **A refused read is not an error.** It resolves `undefined`, and each caller answers with
 *   its own no-data path; pressure is transient, so surfacing it as a failure would teach the
 *   UI to retry into the same wall.
 */

import { getHeapStatistics } from 'node:v8'

/** One instant of the process heap, in bytes. `limit` is V8's ceiling, not the OS's memory. */
export interface HeapReading {
  used: number
  limit: number
}

/** The admission seam both cold-read paths consume. */
export interface ColdReadGate {
  /** Resolves `undefined` when the read is skipped for pressure; the caller answers no-data. */
  admit<T>(read: () => Promise<T>): Promise<T | undefined>
}

/**
 * Start a cold read only while the used heap is below two thirds of the process's own V8
 * limit, reserving the top third for the read itself.
 */
const HIGH_WATER = 2 / 3

/** Production reading: the live V8 heap. */
function v8Reading(): HeapReading {
  const stats = getHeapStatistics()
  return { used: stats.used_heap_size, limit: stats.heap_size_limit }
}

/** Decouple the queue chain from one read's outcome, so a rejection cannot poison later reads. */
const noop = (): void => {}

/**
 * Create the gate. One instance per host process, shared by both cold-read paths.
 *
 * @param reading - heap probe, injectable for tests; a throwing or garbage probe admits the
 * read, because this gate must never be the thing that blocks data.
 */
export function makeColdReadGate(reading: () => HeapReading = v8Reading): ColdReadGate {
  const clear = (): boolean => {
    try {
      const { used, limit } = reading()
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return true
      return used < limit * HIGH_WATER
    } catch {
      return true
    }
  }
  let tail: Promise<unknown> = Promise.resolve()
  return {
    admit<T>(read: () => Promise<T>): Promise<T | undefined> {
      // The pressure check runs at the head of the queue, not at enqueue time: pressure moves
      // while a read waits its turn, so an early verdict would be stale by the time it matters.
      const run = tail.then(() => (clear() ? read() : undefined))
      tail = run.then(noop, noop)
      return run
    },
  }
}
