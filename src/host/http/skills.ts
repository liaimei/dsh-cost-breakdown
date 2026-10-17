/// <reference types="node" />
/**
 * `POST /api/dsh-cost-breakdown/skills` — the skill catalogue behind the Insights skill card.
 *
 * The harness's own `skills/list` remote strips provenance from the wire shape, so this plugin
 * reads the host-side registry directly. Session addressing is the subtle part: on the web
 * composition, skill discovery hangs off the agent preset, and a bare global registry lists
 * nothing. Resolution mirrors the harness's own skill-catalog:
 *
 * 1. A **live agent** addressed by `sessionId` → `agentPresets.serviceFor(live, 'skills')`.
 * 2. Otherwise the **global** `skills` registry, scoped by a preset scope lease when one can be
 *    acquired (a cold session's preset).
 * 3. Otherwise `null` — the card keeps rendering counts, just without enrichment.
 *
 * Any throw resolves `value: null`; the preset lease is always disposed.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillEntry } from '../../wire/model'
import {
  type ConnectionFace,
  asRecord,
  disposeResource,
  readJsonBody,
  registerPostRoute,
  replyValue,
  routePath,
} from './router'

/** The skills route, inside the authenticated `/api` fence. */
export const SKILLS_ROUTE = routePath('skills')

/** Render cap: a registry that materialises a skill per directory could otherwise return megabytes. */
const MAX_SKILLS = 500

/** The registry interface consumed here. */
interface SkillRegistryFace {
  list(options: { cwd?: string; scope?: unknown }): Promise<unknown>
}

/** Non-empty string, else `undefined` — downstream cannot tell "empty" from "missing" otherwise. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Narrow one registry summary into a wire entry: the name is the join key and must stand on its
 * own, else the whole entry is dropped while valid siblings still serve. */
function skillEntryOf(value: unknown): SkillEntry | null {
  const record = asRecord(value)
  if (record === null || typeof record.name !== 'string' || record.name === '') return null
  return {
    name: record.name,
    description: typeof record.description === 'string' ? record.description : '',
    ...typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {},
    ...typeof record.source === 'string' && record.source !== '' ? { source: record.source } : {},
  }
}

/** A cold session's catalogue view: its workspace and its recorded preset. */
interface SessionView {
  cwd?: string
  agentPreset?: string
}

/**
 * The session's catalogue view, read from a `sessionQuery` observation. An unknown session
 * leaves only the request's own `cwd` as a selector.
 */
async function sessionViewOf(ctx: Context, sessionId: string | undefined): Promise<SessionView> {
  if (sessionId === undefined) return {}
  const query = asRecord(ctx.get('sessionQuery'))
  if (typeof query?.observeSession !== 'function') return {}
  let observation: unknown
  try {
    observation = await (query.observeSession as (id: string) => Promise<unknown>).call(query, sessionId)
  } catch {
    return {}
  }
  try {
    const obs = asRecord(observation)
    const cwd = stringOf(asRecord(obs?.header)?.cwd)
    const agentPreset = stringOf(asRecord(asRecord(obs?.projections)?.values)?.agentPreset)
    return {
      ...cwd === undefined ? {} : { cwd },
      ...agentPreset === undefined ? {} : { agentPreset },
    }
  } finally {
    await disposeResource(observation)
  }
}

/** The registry a read resolved to, plus the scope selector and any lease to release. */
interface RegistryChoice {
  registry: SkillRegistryFace
  scope: unknown
  lease: unknown
}

/**
 * Resolve the registry and scope for one read (matching the harness's own skill-catalog): the
 * live agent's preset-scoped registry first, then the global registry under a preset scope
 * lease; with neither, the unscoped global registry — the card then does no enrichment.
 */
async function resolveRegistry(
  ctx: Context,
  sessionId: string | undefined,
  agentPreset: string | undefined,
): Promise<RegistryChoice | null> {
  const presets = asRecord(ctx.get('agentPresets'))
  let live: unknown
  if (sessionId !== undefined) {
    const agents = asRecord(ctx.get('agents'))
    if (typeof agents?.get === 'function') {
      try {
        live = (agents.get as (id: string) => unknown).call(agents, sessionId)
      } catch {
        live = undefined
      }
    }
  }
  if (live !== undefined && live !== null && typeof presets?.serviceFor === 'function') {
    const scoped = asRecord((presets.serviceFor as (agent: unknown, name: string) => unknown).call(presets, live, 'skills'))
    if (scoped !== null && typeof scoped.list === 'function') {
      return { registry: scoped as unknown as SkillRegistryFace, scope: live, lease: undefined }
    }
  }
  const registry = asRecord(ctx.get('skills'))
  if (registry === null || typeof registry.list !== 'function') return null
  let scope: unknown
  let lease: unknown
  if (typeof presets?.acquireScope === 'function') {
    try {
      lease = await (presets.acquireScope as (id?: string) => Promise<unknown>).call(presets, agentPreset)
      scope = asRecord(lease)?.key
    } catch {
      // Unknown or unavailable preset: fall back to the global layer.
      lease = undefined
    }
  }
  return { registry: registry as unknown as SkillRegistryFace, scope, lease }
}

/** The route reply body. */
export interface SkillCatalogue {
  skills: SkillEntry[]
}

/**
 * Resolve the catalogue for one request body. Never throws: any failure yields `null`, and the
 * lease is disposed in a `finally`.
 */
export async function readSkillCatalogue(ctx: Context, body: unknown): Promise<SkillCatalogue | null> {
  const record = asRecord(body)
  const sessionId = stringOf(record?.sessionId)
  let lease: unknown
  try {
    const view = await sessionViewOf(ctx, sessionId)
    const cwd = view.cwd ?? stringOf(record?.cwd)
    const choice = await resolveRegistry(ctx, sessionId, view.agentPreset)
    if (choice === null) return null
    lease = choice.lease
    const listed: unknown = await choice.registry.list({
      ...cwd === undefined ? {} : { cwd },
      ...choice.scope === undefined ? {} : { scope: choice.scope },
    })
    const rows = Array.isArray(listed) ? listed : []
    const skills: SkillEntry[] = []
    for (const row of rows) {
      const entry = skillEntryOf(row)
      if (entry !== null) skills.push(entry)
      if (skills.length >= MAX_SKILLS) break
    }
    return { skills }
  } catch {
    // Any failure returns null: the card renders counts only, without enrichment.
    return null
  } finally {
    await disposeResource(lease)
  }
}

/** Arm the skills route as soon as `connection` is provided. */
export function watchSkillsChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (request: Request): Promise<Response> => {
      const body = await readJsonBody(request)
      // The body is the only addressing input; an unparseable one cannot name a session or a
      // workspace, so it resolves the same typed `null` as any other failure.
      if (!body.ok) return replyValue(null)
      return replyValue(await readSkillCatalogue(ctx, body.value))
    }
    registerPostRoute(
      c,
      c.get('connection') as ConnectionFace | undefined,
      SKILLS_ROUTE,
      handler,
      'dsh-cost-breakdown: skills route',
    )
  })
}
