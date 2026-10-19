/**
 * The context-event list.
 *
 * The three rules that keep it honest: a read that has not landed is not an empty list; an injection's token
 * delta is positive and a free-up (compaction/prune) is negative; and a boundary event names the gap it
 * occupies rather than a single point.
 */

import { renderToStaticMarkup } from 'react-dom/server'
import { createElement as h } from 'react'
import { describe, expect, it } from 'vitest'
import { EventsCard } from '../../src/client/ui/context/Events'
import type { Snapshot } from '../../src/wire/model'

const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}(${Object.values(params).join(',')})`

/** A snapshot carrying the given events. */
function snapshot(events: Snapshot['events']): Snapshot {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [], events, nodes: [], droppedNodes: 0, archive: [],
    counts: { turns: 1, steps: 1, injects: 1, compactions: 1, prunes: 0 },
  }
}

describe('EventsCard', () => {
  it('signs the delta by kind: an injection adds, a compaction frees', () => {
    const markup = renderToStaticMarkup(h(EventsCard, {
      t,
      snapshot: snapshot([
        { seq: 1, time: 1000, kind: 'inject', name: 'skill', sub: 'skill', tokens: 40 },
        { seq: 2, time: 2000, kind: 'compaction', count: 12, tokens: 900 },
      ]),
    }))
    expect(markup).toContain('+40')
    expect(markup).toContain('−900')
  })

  it('names the gap for a boundary event and the point for a single one', () => {
    const markup = renderToStaticMarkup(h(EventsCard, {
      t,
      snapshot: snapshot([
        { seq: 1, time: 1000, kind: 'compaction', count: 3, turn: 2, step: 4, fromTurn: 2, fromStep: 3 },
        { seq: 2, time: 2000, kind: 'model', from: 'a', to: 'b', turn: 2, step: 5 },
      ]),
    }))
    // The compaction sits between step 3 and 4; the model switch is a single point.
    expect(markup).toContain('events.range(2,3,4)')
    expect(markup).toContain('events.at(2,5)')
  })

  it('lists newest first and keys by the durable seq', () => {
    const markup = renderToStaticMarkup(h(EventsCard, {
      t,
      snapshot: snapshot([
        { seq: 1, time: 1000, kind: 'prune', tokens: 10 },
        { seq: 2, time: 2000, kind: 'prune', tokens: 20 },
      ]),
    }))
    // The newest event renders before the older one.
    expect(markup.indexOf('−20')).toBeLessThan(markup.indexOf('−10'))
  })

  it('says "loading" rather than "no events" while the detail read is pending', () => {
    const loading = renderToStaticMarkup(h(EventsCard, { t, snapshot: snapshot([]), state: 'loading' }))
    expect(loading).toContain('loading')
    expect(loading).not.toContain('events.empty')
    // Only a landed and genuinely empty list may claim there are no events.
    const ready = renderToStaticMarkup(h(EventsCard, { t, snapshot: snapshot([]), state: 'ready' }))
    expect(ready).toContain('events.empty')
  })

  it('offers a retry when the read failed', () => {
    const markup = renderToStaticMarkup(h(EventsCard, {
      t,
      snapshot: snapshot([]),
      state: 'failed',
      onRetry: () => {},
    }))
    expect(markup).toContain('detail.loadFailed')
    expect(markup).toContain('cb-error-retry')
  })

  it('badges the kind filter with the headline counts', () => {
    const markup = renderToStaticMarkup(h(EventsCard, { t, snapshot: snapshot([]), state: 'ready' }))
    expect(markup).toContain('cb-kinds')
    expect(markup).toContain('cb-kind-n')
    // No counts for model/mode: the head does not report them.
    expect(markup).toContain('kind.model')
  })
})
