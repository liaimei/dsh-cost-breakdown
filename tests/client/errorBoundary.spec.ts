/**
 * The context surface's error boundary.
 *
 * A render throw inside one card must not take the conversation view down: the boundary renders the message
 * and a retry, and retrying re-renders the subtree instead of leaving the error on screen.
 */

import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeErrorBoundary } from '../../src/client/ui/context/ErrorBoundary'

const t = (key: string): string => key

let root: Root | undefined
let host: HTMLDivElement | undefined

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = undefined
  host = undefined
  vi.restoreAllMocks()
})

/** Mount a subtree into a fresh container. */
function mount(element: ReturnType<typeof h>): void {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => { root?.render(element) })
}

/**
 * A child that throws while `fail` is set.
 *
 * The flag is flipped by the test, not by the child: React retries a failed render synchronously once before
 * it hands the error to the boundary, so a "throw only the first time" child would recover on that retry and
 * the fallback would never render.
 */
interface FlakyControl { fail: boolean }

function makeFlaky(control: FlakyControl): () => ReturnType<typeof h> {
  return function Flaky(): ReturnType<typeof h> {
    if (control.fail) throw new Error('boom')
    return h('span', null, 'recovered')
  }
}

describe('context error boundary', () => {
  it('renders the message and a retry instead of unmounting the surface', () => {
    const Boundary = makeErrorBoundary(t)
    const control: FlakyControl = { fail: true }
    const Flaky = makeFlaky(control)
    // React logs the caught error; silence it so the suite output stays readable.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mount(h(Boundary, null, h(Flaky)))
    expect(document.body.textContent).toContain('error')
    expect(document.body.textContent).toContain('boom')
    expect(document.querySelector('.cb-error-retry')).not.toBeNull()

    // The retry clears the error; with the fault gone, the subtree renders again.
    control.fail = false
    act(() => { (document.querySelector('.cb-error-retry') as HTMLElement).click() })
    expect(document.body.textContent).toContain('recovered')
  })

  it('renders its children untouched when nothing throws', () => {
    const Boundary = makeErrorBoundary(t)
    mount(h(Boundary, null, h('span', null, 'fine')))
    expect(document.body.textContent).toBe('fine')
  })
})
