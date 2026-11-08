/// <reference types="node" />
/**
 * The single seam every plugin HTTP channel goes through.
 *
 * The harness owns one authenticated `/api` fence and exposes a fetch-route registry on the
 * `connection` service; this plugin never authenticates anything itself. Two things are
 * load-bearing and therefore implemented exactly once here instead of in each route module:
 *
 * 1. **Read-time binding.** `connection.fetch.register` must be read off the live service and
 *    bound at the moment of the read. Handing the bare method to a callback would lose `this`
 *    on the real registry object and the route would never match a request.
 * 2. **Silent refusal.** A registry that is missing, hostile, or rejects the registration must
 *    never take the plugin down: the route simply stays absent, which the client reads as
 *    "this capability is not available" rather than as a crash.
 *
 * The response helpers exist for the same reason: every route shares one envelope shape
 * (`{ ok: true, value }` / `{ ok: false, error: { code, message } }`) and one cache policy
 * (`no-store`), and having two spellings of either would be a wire divergence.
 */

/** Path prefix shared by every route this plugin arms. */
export const ROUTE_PREFIX = '/api/dsh-cost-breakdown'

/** The plugin's own failure-code namespace; clients switch on `code`, never on the message. */
export const BAD_REQUEST_CODE = 'dsh-cost-breakdown/bad-request'
/**
 * The one failure code that is NOT namespaced by this plugin: it is the harness-wide code for
 * "the handler threw", part of the frozen envelope contract, so a client that already knows
 * how to render a gateway failure keeps working.
 */
export const INTERNAL_ERROR_CODE = 'gateway/internal'

/** Resolve one of the plugin's route paths. */
export function routePath(name: string): string {
  return `${ROUTE_PREFIX}/${name}`
}

/**
 * The subset of the host `connection` service these routes consume.
 *
 * Every member is optional because an older harness may expose the service without a fetch
 * registry, and because the registry itself is a third-party implementation that may not be
 * shaped as documented.
 */
export interface ConnectionFace {
  fetch?: {
    register?(route: RouteRegistration): (() => void) | void
  }
}

/** One route registration request, exactly as the harness fetch registry consumes it. */
export interface RouteRegistration {
  path: string
  methods: readonly string[]
  requestBody: 'buffered'
  fetch: (request: Request) => Response | Promise<Response>
}

/** The injected fiber's effect scope: registration must be disposed with the fiber. */
export interface EffectScope {
  effect(execute: () => () => void, label?: string): unknown
}

/** Bind the route registrar at read time, so hand-off cannot drop its receiver. */
function routeRegistrar(connection: ConnectionFace | undefined): ((route: RouteRegistration) => (() => void) | void) | undefined {
  const fetch = connection?.fetch
  return typeof fetch?.register === 'function' ? fetch.register.bind(fetch) : undefined
}

/**
 * Register one POST route behind the `/api` fence.
 *
 * @returns whether the route is registered right now — `false` when the registrar is absent
 * or refused, in which case the caller's own no-data path answers.
 */
export function registerPostRoute(
  scope: EffectScope,
  connection: ConnectionFace | undefined,
  path: string,
  handler: (request: Request) => Response | Promise<Response>,
  label: string,
): boolean {
  const register = routeRegistrar(connection)
  if (register === undefined) return false
  try {
    scope.effect(() => {
      // A registrar that answers `undefined` instead of a disposer must still produce a valid
      // effect body; the empty cleanup keeps the registration alive for the fiber's lifetime.
      const dispose = register({ path, methods: ['POST'], requestBody: 'buffered', fetch: handler })
      return typeof dispose === 'function' ? dispose : () => {}
    }, label)
  } catch {
    // A hostile registry must not be able to break plugin assembly; the route just stays absent.
    return false
  }
  return true
}

/** Reply with a JSON body and the plugin's one cache policy: every payload is a live snapshot. */
export function replyJson(body: unknown): Response {
  return Response.json(body, { headers: { 'cache-control': 'no-store' } })
}

/** Happy-path envelope. */
export function replyValue<T>(value: T): Response {
  return replyJson({ ok: true, value })
}

/** Failure envelope. Always HTTP 200 so the client distinguishes "no data" from "no route". */
export function replyFailure(code: string, message: string): Response {
  return replyJson({ ok: false, error: { code, message } })
}

/** A parsed JSON body, or a typed rejection the caller turns into a `bad-request` reply. */
export type JsonBody = { ok: true; value: unknown } | { ok: false }

/** Read a buffered request body as JSON. Never throws: a non-JSON body is a client error. */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  try {
    return { ok: true, value: await request.json() }
  } catch {
    return { ok: false }
  }
}

/** Best-effort printable form of a thrown value: a hostile `toString` must not escape. */
export function messageOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unprintable error'
  }
}

/** Plain-object view of an untrusted payload: arrays and primitives are not records. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/**
 * Release an observation/lease (`Symbol.asyncDispose` first, then `Symbol.dispose`) without
 * letting a hostile disposer throw into the route.
 */
export async function disposeResource(resource: unknown): Promise<void> {
  if (resource === null || (typeof resource !== 'object' && typeof resource !== 'function')) return
  try {
    const asyncDispose = (resource as { [Symbol.asyncDispose]?: unknown })[Symbol.asyncDispose]
    if (typeof asyncDispose === 'function') {
      await (asyncDispose as () => Promise<void>).call(resource)
      return
    }
    const syncDispose = (resource as { [Symbol.dispose]?: unknown })[Symbol.dispose]
    if (typeof syncDispose === 'function') (syncDispose as () => void).call(resource)
  } catch {
    // The data has already been read; a broken disposer is not the route's problem.
  }
}
