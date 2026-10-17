/**
 * The HTTP channels: envelopes, the detail route's live/cold resolution, the cold-read gate, credits
 * parsing and the balance reader's ordering.
 *
 * These are the plugin's only inbound surface. What matters here is what a client can depend on: every
 * reply is a JSON envelope with a stable shape, every route is a POST behind the `/api` fence, and a
 * refusal is a typed `null` rather than a throw.
 */

import { describe, expect, it, vi } from 'vitest'
import { readJsonBody, replyFailure, replyValue, registerPostRoute, routePath, ROUTE_PREFIX, BAD_REQUEST_CODE } from '../../../src/host/http/router'
import { makeColdReadGate } from '../../../src/host/http/cold'
import { creditsOfPayload } from '../../../src/host/http/credits'

/** A minimal effect scope: registration disposes with the fiber. */
const scope = { effect: (fn: () => () => void) => { fn(); return () => {} } }

/** A minimal connection face that records registrations. */
function connection(routes: Array<{ path: string; methods: readonly string[] }>): Record<string, unknown> {
  return {
    fetch: {
      register(route: { path: string; methods: readonly string[] }) {
        routes.push(route)
        return () => {}
      },
    },
  }
}

describe('router', () => {
  it('builds every path under the frozen prefix', () => {
    expect(ROUTE_PREFIX).toBe('/api/dsh-cost-breakdown')
    expect(routePath('detail')).toBe('/api/dsh-cost-breakdown/detail')
  })

  it('registers a POST route with a buffered body and a no-store reply', async () => {
    const routes: Array<{ path: string; methods: readonly string[] }> = []
    const registered = registerPostRoute(scope, connection(routes), routePath('skills'), async () => replyValue({ skills: [] }), 'test')
    expect(registered).toBe(true)
    expect(routes).toEqual([{ path: '/api/dsh-cost-breakdown/skills', methods: ['POST'], requestBody: 'buffered', fetch: expect.any(Function) }])
    const reply = replyValue({ skills: [] })
    expect(reply.headers.get('cache-control')).toBe('no-store')
    expect(await reply.json()).toEqual({ ok: true, value: { skills: [] } })
  })

  it('serialises a failure with a namespaced code', async () => {
    const reply = replyFailure(BAD_REQUEST_CODE, 'missing sessionId')
    expect(reply.status).toBe(200)
    expect(await reply.json()).toEqual({ ok: false, error: { code: 'dsh-cost-breakdown/bad-request', message: 'missing sessionId' } })
  })

  it('refuses to register when the connection face is missing or hostile', () => {
    expect(registerPostRoute(scope, undefined, '/x', () => replyValue(null), 'test')).toBe(false)
    const hostile = { fetch: { register() { throw new Error('no') } } }
    expect(registerPostRoute(scope, hostile, '/x', () => replyValue(null), 'test')).toBe(false)
  })

  it('reads a JSON body or reports a client error', async () => {
    expect(await readJsonBody(new Request('http://x', { method: 'POST', body: '{"a":1}' }))).toEqual({ ok: true, value: { a: 1 } })
    expect(await readJsonBody(new Request('http://x', { method: 'POST', body: 'not json' }))).toEqual({ ok: false })
  })
})

describe('cold-read gate', () => {
  it('admits one read at a time and allows when the heap probe fails', async () => {
    // A throwing probe must fail open: the gate may never be the thing that blocks data.
    const gate = makeColdReadGate(() => { throw new Error('probe failed') })
    let running = 0
    let peak = 0
    const task = async (): Promise<number> => {
      running++
      peak = Math.max(peak, running)
      await new Promise(resolve => setTimeout(resolve, 5))
      running--
      return 1
    }
    const results = await Promise.all([gate.admit(task), gate.admit(task), gate.admit(task)])
    expect(results).toEqual([1, 1, 1])
    // Single concurrency: the gate serialises admitted reads.
    expect(peak).toBe(1)
  })

  it('refuses (undefined) under heap pressure', async () => {
    const gate = makeColdReadGate(() => ({ used: 90, limit: 100 }))
    const task = vi.fn(async () => 1)
    expect(await gate.admit(task)).toBeUndefined()
    expect(task).not.toHaveBeenCalled()
  })

  it('admits below two thirds of the heap', async () => {
    const gate = makeColdReadGate(() => ({ used: 50, limit: 100 }))
    expect(await gate.admit(async () => 7)).toBe(7)
  })
})

/** A platform status payload in the shape the platform's own route returns. */
function signedIn(credits: Record<string, unknown>): Record<string, unknown> {
  return { status: 'signed-in', credits }
}

describe('credits payload', () => {
  it('accepts a finite non-negative total and the unlimited flag', () => {
    expect(creditsOfPayload(signedIn({ total: 12.5, unlimited: false }))).toMatchObject({ total: 12.5, unlimited: false })
    // `unlimited` is true only for the literal true.
    expect(creditsOfPayload(signedIn({ total: 0, unlimited: 'yes' }))?.unlimited).toBe(false)
  })

  it('keeps an optional reset instant only when it is a non-empty string', () => {
    expect(creditsOfPayload(signedIn({ total: 1, cycleResetTime: '2026-11-01' }))?.cycleResetTime).toBe('2026-11-01')
    expect(creditsOfPayload(signedIn({ total: 1, cycleResetTime: '' }))?.cycleResetTime).toBeUndefined()
    expect(creditsOfPayload(signedIn({ total: 1, cycleResetTime: 5 }))?.cycleResetTime).toBeUndefined()
  })

  it('refuses anything that is not a signed-in payload', () => {
    expect(creditsOfPayload(null)).toBeNull()
    expect(creditsOfPayload({})).toBeNull()
    // A signed-out or unavailable platform is "no data", never a zero balance.
    expect(creditsOfPayload({ status: 'signed-out', credits: { total: 1 } })).toBeNull()
    expect(creditsOfPayload({ status: 'signed-in' })).toBeNull()
    expect(creditsOfPayload(signedIn({}))).toBeNull()
    expect(creditsOfPayload(signedIn({ total: -1 }))).toBeNull()
    expect(creditsOfPayload(signedIn({ total: Number.NaN }))).toBeNull()
  })
})
