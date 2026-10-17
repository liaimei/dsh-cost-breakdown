/**
 * Browser interaction: mount the dock readout in jsdom, open the card, and check the dialog lands in the
 * document body and closes again.
 *
 * Static markup proves a surface can render; this proves the piece a reader actually uses — the trigger is
 * a real button, the card is portalled out of the composer (which clips), and the outside-click path
 * closes it.
 */

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DockReadout } from '../../src/client/ui/dock/DockReadout'
import type { Snapshot } from '../../src/wire/model'

const t = (key: string): string => key

/** A snapshot with one billed request on the official route. */
function snapshot(): Snapshot {
  return {
    ok: true,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 5, tool: 0, total: 15 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    cost: { 'deepseek-official': { 'deepseek-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    calls: { 'deepseek-official': { 'deepseek-flash': 1 } },
  }
}

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
  vi.unstubAllGlobals()
})

/** Mount a component into a fresh container and flush effects. */
function mount(element: ReturnType<typeof h>): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root?.render(element) })
}

describe('dock card', () => {
  it('opens from the trigger, portals the card, and closes on an outside click', () => {
    // The wallet and price-book reads go through fetch; keep them silent and unresolved.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"value":null}', { status: 200 })))
    const value = snapshot()
    mount(h(DockReadout, {
      sessionId: 's1',
      useProjection: (key: string) => (key === 'contextTimeline' ? value : undefined),
      t,
      locale: () => 'zh',
    }))
    const trigger = document.querySelector('.cb-dock')
    expect(trigger).not.toBeNull()
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')

    // Open: the dialog is a sibling of the app root, in `document.body`, not inside the dock.
    act(() => { (trigger as HTMLElement).click() })
    const card = document.querySelector('.cb-dock-card')
    expect(card).not.toBeNull()
    expect(card?.getAttribute('role')).toBe('dialog')
    expect(trigger?.contains(card as Node)).toBe(false)
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')

    // Outside click closes it again.
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.querySelector('.cb-dock-card')).toBeNull()
  })
})
