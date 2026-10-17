/**
 * jsdom setup for the browser-side specs.
 *
 * Only two globals need help: `localStorage` (jsdom provides it, but Node's own may shadow it depending
 * on how the runner is invoked) and a no-op `ResizeObserver` (jsdom has no layout engine, so the dock's
 * measurement code must see a well-formed observer even though nothing ever resizes).
 */

import { afterEach, beforeEach, vi } from 'vitest'

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (typeof globalThis.ResizeObserver !== 'function') {
  globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver
}

// `fetch` is stubbed per spec; the default exists so a stray call fails fast instead of hitting the network.
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"value":null}', { status: 200 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})
