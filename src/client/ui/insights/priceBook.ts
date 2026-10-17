/**
 * The public price book (models.dev), loaded once per page and shared by every cost surface.
 *
 * Why a book at all: the official CNY table covers DeepSeek's own models, but a session can also reach
 * third-party models through a proxy route, and those need a rate. The registry is that source; the
 * official table and the user's own declared rates take precedence over it, so the book being absent
 * degrades (official and configured models still price) rather than blanking the page.
 *
 * The payload is untrusted wire data: every field is re-validated, and an entry that fails the check is
 * dropped on its own instead of invalidating the book.
 */

import { useEffect, useState } from 'react'
import { Models } from '@opencode-ai/models'
import type { RateQuad } from '../../../wire/model'
import { buildRateIndex, type PriceBook, type RegistryPrices } from '../../data/cost'

/** A non-negative finite rate, or `null`. */
function rateOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Extract per-model USD rates from a registry payload, building the model-side index on top.
 * A non-record payload is a failed read (`null`); a malformed entry is skipped. */
export function pricesBookOf(value: unknown): PriceBook | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const prices: RegistryPrices = {}
  const npmOf: Record<string, string | null> = {}
  for (const providerId of Object.keys(data)) {
    const provider = data[providerId]
    if (provider === null || typeof provider !== 'object' || Array.isArray(provider)) continue
    const models = (provider as { models?: unknown }).models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
    const npm = (provider as { npm?: unknown }).npm
    npmOf[providerId] = typeof npm === 'string' ? npm : null
    const branch: Record<string, RateQuad> = {}
    for (const id of Object.keys(models as Record<string, unknown>)) {
      const model = (models as Record<string, unknown>)[id]
      if (model === null || typeof model !== 'object' || Array.isArray(model)) continue
      const cost = (model as { cost?: unknown }).cost
      if (cost === null || typeof cost !== 'object' || Array.isArray(cost)) continue
      const miss = rateOf((cost as { input?: unknown }).input)
      const out = rateOf((cost as { output?: unknown }).output)
      if (miss === null || out === null) continue
      branch[id] = {
        hit: rateOf((cost as { cache_read?: unknown }).cache_read) ?? miss,
        miss,
        write: rateOf((cost as { cache_write?: unknown }).cache_write) ?? miss,
        out,
      }
    }
    if (Object.keys(branch).length > 0) prices[providerId] = branch
  }
  return { prices, index: buildRateIndex(prices, npmOf) }
}

/** The book plus whether the most recent read failed (which drives a visible retry hint). */
export interface BookSnapshot {
  book: PriceBook | null
  failed: boolean
}

type Loader = () => Promise<unknown>

const defaultLoader: Loader = () => Models.make().providers()

/** Backoff base: retries double up to 8x, so a long outage settles at roughly one attempt per four
 * minutes rather than growing without bound. */
const RETRY_BASE_MS = 30_000

let loader: Loader = defaultLoader
let snapshot: BookSnapshot = { book: null, failed: false }
let inFlight = false
let failures = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function fail(): void {
  // `fail` runs once per fetch cycle (only `fire` calls it, and both of its entry points are blocked
  // while a timer is armed), so re-arming here cannot leak.
  snapshot = { ...snapshot, failed: true }
  failures++
  timer = setTimeout(() => {
    timer = null
    // Nobody is reading the book any more (its panel unmounted): end this cycle instead of polling an
    // unreachable registry for the rest of the page's life.
    if (listeners.size === 0) return
    void fire()
  }, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 3))
}

async function fire(): Promise<void> {
  inFlight = true
  try {
    const book = pricesBookOf(await loader())
    if (book !== null) {
      snapshot = { book, failed: false }
      failures = 0
    } else {
      fail()
    }
  } catch {
    fail()
  }
  inFlight = false
  for (const listener of listeners) listener()
}

function kick(): void {
  if (snapshot.book !== null || inFlight || timer !== null) return
  void fire()
}

/** The React seat. It doubles as the fetch trigger: the first subscriber starts the load, so a
 * deployment that never opens a cost surface never asks the registry for anything. */
export function subscribePriceBook(listener: () => void): () => void {
  listeners.add(listener)
  kick()
  return () => {
    listeners.delete(listener)
  }
}

/** Reference-stable snapshot for `useSyncExternalStore`: replaced only when the book or the failure flag
 * actually changes. */
export function priceBookSnapshot(): BookSnapshot {
  return snapshot
}

/** The price book for a cost surface. `book === null` means "not loaded yet or unavailable", which
 * prices only official-table and user-configured models. */
export function usePriceBook(): PriceBook | null {
  const [state, setState] = useState<BookSnapshot>(snapshot)
  useEffect(() => {
    const update = (): void => { setState(snapshot) }
    const unsubscribe = subscribePriceBook(update)
    update()
    return unsubscribe
  }, [])
  return state.book
}

/** The failure flag, for the card that wants to show a retry hint. */
export function usePriceBookState(): BookSnapshot {
  const [state, setState] = useState<BookSnapshot>(snapshot)
  useEffect(() => {
    const update = (): void => { setState(snapshot) }
    const unsubscribe = subscribePriceBook(update)
    update()
    return unsubscribe
  }, [])
  return state
}

/** Drop the book, the backoff and the subscribers — for tests, and for "after a settings change no
 * figure may be priced against another account's book". Clearing the subscribers means the next
 * subscription starts a fresh fetch instead of reviving this cycle. */
export function resetPriceBook(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  snapshot = { book: null, failed: false }
  inFlight = false
  failures = 0
  listeners.clear()
}

/** Test seam for the registry read; `null` restores the SDK loader. */
export function setPriceBookLoader(next: Loader | null): void {
  loader = next ?? defaultLoader
}
