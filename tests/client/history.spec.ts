/**
 * The context browser's on-demand history reads.
 *
 * The interesting cases are the ones a naive implementation gets wrong: the read must anchor on
 * `throughSeq` with an exclusive `beforeSeq` of `seq + 1`; a landed node is cached but an absent one is not
 * (the live stream can append an event later); and the three degraded states stay distinguishable.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  headerContentOf, historyFace, makeContentFetcher, makeHeaderFetcher, pageNodesOf,
  setHistoryFaceForTest, subscribeHistoryFace,
} from '../../src/client/data/history'

afterEach(() => { setHistoryFaceForTest(undefined) })

/** A page payload in the gateway's envelope shape. */
function page(records: unknown[]): { ok: true; value: { records: unknown[] } } {
  return { ok: true, value: { records } }
}

/** One durable event row as the gateway serializes it. */
function row(type: string, seq: number, data: Record<string, unknown>): { type: 'event'; event: unknown } {
  return { type: 'event', event: { type, seq, data } }
}

describe('pageNodesOf', () => {
  it('maps the message kinds into renderable nodes', () => {
    const nodes = pageNodesOf([
      row('user/message', 5, { content: [{ type: 'text', text: 'hi' }] }),
      row('assistant/message', 6, { message: { content: [{ type: 'text', text: 'hello' }] } }),
      row('tool/call', 7, { callId: 'c1', name: 'read', arguments: '{}' }),
      row('tool/result', 8, { message: { toolCallId: 'c1', content: [], isError: true } }),
    ])
    expect(nodes.get(5)).toMatchObject({ kind: 'user' })
    expect(nodes.get(6)).toMatchObject({ kind: 'assistant' })
    // The tool result is joined to the call recorded earlier on the page.
    expect(nodes.get(8)).toMatchObject({ kind: 'tool-result', call: { name: 'read' }, isError: true })
  })

  it('renders a compaction checkpoint as its summary', () => {
    const nodes = pageNodesOf([
      row('compaction/summary', 2, { compactionId: 'k1', summary: [{ type: 'text', text: 'summarised' }] }),
      row('user/message', 3, { source: { kind: 'plugin', compactionId: 'k1' }, content: [] }),
    ])
    expect(nodes.get(3)).toMatchObject({ kind: 'compaction', summary: 'summarised' })
  })

  it('skips packed chunk rows and malformed entries', () => {
    const nodes = pageNodesOf([
      { type: 'chunks', records: [] },
      null,
      { type: 'event', event: { type: 'user/message', seq: 1, data: { content: [] } } },
    ])
    expect([...nodes.keys()]).toEqual([1])
  })
})

describe('headerContentOf', () => {
  it('maps a header epoch with each tool schema verbatim', () => {
    const content = headerContentOf({
      type: 'request/header',
      data: { header: { tools: [{ name: 'read', description: 'Read a file', parameters: {} }] } },
    })
    expect(content?.tools[0]).toMatchObject({ name: 'read', description: 'Read a file' })
    expect(content?.tools[0].schema).toEqual({ name: 'read', description: 'Read a file', parameters: {} })
  })

  it('maps a system message to its text and no tools', () => {
    const content = headerContentOf({ type: 'system/message', data: { message: { content: [{ type: 'text', text: 'you are…' }] } } })
    expect(content).toEqual({ system: 'you are…', tools: [] })
  })

  it('returns null for an empty prompt or a header-less event', () => {
    expect(headerContentOf({ type: 'system/message', data: { message: { content: [] } } })).toBeNull()
    expect(headerContentOf({ type: 'request/header', data: {} })).toBeNull()
  })
})

describe('the history face', () => {
  it('is undefined before the inject lands and notifies subscribers when it arrives', () => {
    let notified = 0
    const off = subscribeHistoryFace(() => { notified++ })
    expect(historyFace()).toBeUndefined()
    setHistoryFaceForTest(async () => page([]))
    expect(historyFace()).toBeDefined()
    expect(notified).toBe(1)
    off()
    setHistoryFaceForTest(undefined)
    // Unsubscribed: no further notification.
    expect(notified).toBe(1)
  })
})

describe('makeContentFetcher', () => {
  it('is undefined without a face, so the caller keeps its static fallback', () => {
    expect(makeContentFetcher('s1')).toBeUndefined()
  })

  it('anchors the read inclusively at the seq', async () => {
    const requests: unknown[] = []
    setHistoryFaceForTest(async (request: unknown) => {
      requests.push(request)
      return page([row('user/message', 9, { content: [{ type: 'text', text: 'nine' }] })])
    })
    const fetch = makeContentFetcher('s1')
    const node = await fetch?.(9)
    expect(node).toMatchObject({ kind: 'user' })
    expect(requests[0]).toMatchObject({
      address: { kind: 'session', sessionId: 's1' },
      throughSeq: 9,
      beforeSeq: 10,
    })
  })

  it('caches a landed node but retries an absent one', async () => {
    let calls = 0
    setHistoryFaceForTest(async () => {
      calls++
      // The first read finds nothing; the second (after the live stream appended it) finds the row.
      return calls === 1 ? page([]) : page([row('user/message', 4, { content: [] })])
    })
    const fetch = makeContentFetcher('s1')
    expect(await fetch?.(4)).toBeNull()
    expect(await fetch?.(4)).toMatchObject({ kind: 'user' })
    // The landed value is now cached.
    await fetch?.(4)
    expect(calls).toBe(2)
  })

  it('rejects a malformed response so the caller can offer a retry', async () => {
    setHistoryFaceForTest(async () => ({ ok: false }))
    const fetch = makeContentFetcher('s1')
    await expect(fetch?.(1)).rejects.toThrow()
  })
})

describe('makeHeaderFetcher', () => {
  it('caches every content event on the page and returns the selected one', async () => {
    setHistoryFaceForTest(async () => page([
      row('request/header', 3, { header: { tools: [{ name: 'a' }] } }),
      row('request/header', 7, { header: { tools: [{ name: 'b' }] } }),
    ]))
    const fetch = makeHeaderFetcher('s1')
    const content = await fetch?.(7)
    expect(content?.tools[0].name).toBe('b')
    // The older generation on the same page was cached too, so reading it again costs nothing.
    expect((await fetch?.(3))?.tools[0].name).toBe('a')
  })
})
