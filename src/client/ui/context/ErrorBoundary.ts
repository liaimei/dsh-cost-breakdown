/**
 * The Context surface's error boundary.
 *
 * Without it a render throw inside one card takes the whole conversation view down, and the shell's own
 * slot boundary only leaves an empty placeholder. This boundary keeps the failure readable: the message and
 * a retry that clears the error and re-renders the subtree with the current inputs.
 *
 * A class is required — only a class can implement `getDerivedStateFromError`; the factory exists so the
 * translator is captured once at registration rather than threaded through every render.
 */

import { Component } from 'react'
import { createElement as h } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { Translate } from '../../i18n/dict'

/** The boundary's own state: the first error it saw, or `null`. */
interface BoundaryState { error: Error | null }

/** Build the boundary for one translator. */
export function makeErrorBoundary(t: Translate): ComponentType<{ children?: ReactNode }> {
  return class ContextErrorBoundary extends Component<{ children?: ReactNode }, BoundaryState> {
    constructor(props: { children?: ReactNode }) {
      super(props)
      this.state = { error: null }
    }

    /** Keep the thrown value readable whatever it is: a rejected promise may throw a string. */
    static getDerivedStateFromError(error: unknown): BoundaryState {
      return { error: error instanceof Error ? error : new Error(String(error)) }
    }

    render(): ReactNode {
      const error = this.state.error
      if (error === null) return this.props.children
      return h('div', { className: 'cb-root' },
        h('div', { className: 'cb-error cb-empty' },
          h('span', null, t('error')),
          h('code', { className: 'cb-error-msg' }, error.message),
          h('button', {
            type: 'button',
            className: 'cb-error-retry',
            onClick: () => { this.setState({ error: null }) },
          }, t('error.retry'))))
    }
  }
}
