/**
 * The skill catalogue, client side.
 *
 * The host's `/api/dsh-cost-breakdown/skills` route answers with what a skill *is* — description, source
 * bucket, on-disk path — which the activity ledger alone cannot say. The read is anchored to the session
 * (not just its cwd) on purpose: discovery hangs off the agent preset, and a bare `cwd` would only list the
 * global layer.
 *
 * Everything here is best-effort. A missing route, a refusal or an empty list all resolve to `null`, and
 * the card then renders its counts without enrichment rather than claiming the skill has no description.
 */

import type { SkillEntry } from '../../wire/model'

/** The host's skills route. Re-declared here: the bundle inlines every import and must never reach into a
 * host module. */
const SKILLS_ROUTE = '/api/dsh-cost-breakdown/skills'

/** Narrow one catalogue entry: `name` is the join key and must prove itself; the optional fields are kept
 * only when they validate. */
function entryOf(value: unknown): SkillEntry | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || record.name === '') return null
  return {
    name: record.name,
    description: typeof record.description === 'string' ? record.description : '',
    ...(typeof record.path === 'string' && record.path !== '' ? { path: record.path } : {}),
    ...(typeof record.source === 'string' && record.source !== '' ? { source: record.source } : {}),
  }
}

/** Narrow the route payload into a name-keyed map. `null` for anything unusable. */
export function catalogueOf(value: unknown): ReadonlyMap<string, SkillEntry> | null {
  if (value === null || typeof value !== 'object') return null
  const list = (value as { skills?: unknown }).skills
  if (!Array.isArray(list)) return null
  const entries: SkillEntry[] = []
  for (const item of list) {
    const entry = entryOf(item)
    if (entry !== null) entries.push(entry)
  }
  // An empty catalogue and a failed read are indistinguishable for the card's purpose.
  if (entries.length === 0) return null
  // A duplicate name resolves to the later entry, matching the registry's own last-wins layering.
  return new Map(entries.map(entry => [entry.name, entry]))
}

/**
 * Read the catalogue once.
 *
 * Both body fields are **omitted** rather than sent as null when unavailable: the host distinguishes a
 * missing key from an explicit empty one, and an empty session id would narrow discovery to nothing.
 */
export async function readCatalogue(cwd: string | undefined, sessionId: string | undefined): Promise<ReadonlyMap<string, SkillEntry> | null> {
  try {
    const response = await fetch(SKILLS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(cwd === undefined ? {} : { cwd }),
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (body === null || typeof body !== 'object') return null
    const envelope = body as { ok?: unknown; value?: unknown }
    // `ok: false` is a typed refusal; showing counts without enrichment is the honest reading.
    if (envelope.ok !== true) return null
    return catalogueOf(envelope.value)
  } catch {
    return null
  }
}

/** Which loader a copy control uses; tests substitute one that records the text. */
export type TextCopier = (text: string) => Promise<void>

/** The clipboard write through the platform API (absent outside a secure context). It **rejects** rather
 * than silently doing nothing, so the copy control can report the truth. */
const clipboardCopier: TextCopier = async (text) => {
  const clipboard = (globalThis.navigator as { clipboard?: { writeText?: unknown } } | undefined)?.clipboard
  if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard unavailable')
  await (clipboard.writeText as (value: string) => Promise<void>).call(clipboard, text)
}

let copier: TextCopier = clipboardCopier

/** Test seam: replace the clipboard writer (`null` restores the platform one). */
export function setSkillCopier(next: TextCopier | null): void {
  copier = next ?? clipboardCopier
}

/** Copy a skill's path. Resolves `true` only when the write landed. */
export async function copySkillPath(path: string): Promise<boolean> {
  try {
    await copier(path)
    return true
  } catch {
    return false
  }
}
