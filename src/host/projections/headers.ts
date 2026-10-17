/**
 * The `contextHeaders` projection unit — request-header epoch *metadata*.
 *
 * An epoch is the configuration a request went out with: which tools were registered, how expensive
 * they were, and how large the system prompt was. The **content** (the full prompt text, the full
 * tool schemas) is deliberately not part of this value: a projection value is served on every
 * `session.list` row, every baseline and every change frame, so content here would be multiplied by
 * session count × epoch count. The client fetches an epoch's content on demand from the session
 * history instead.
 *
 * **`stateVersion` stays 1 on purpose.** Bumping it would discard every cached row, and an idle
 * session has no projection refresh channel — its key would simply hang until the session went live
 * again. Read compatibility is therefore handled in `view` instead: the stored shape is a **superset**
 * of what is served, so a v1 row that carried the system text and the raw tool schemas still parses,
 * and the view normalises both generations down to metadata only.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateSystemText, estimateToolSchema } from '../../core/tokens'
import type { HeaderEpoch, HeaderedTool, HeaderTimeline } from '../../wire/model'
import { headerStateSchema, headerViewSchema } from '../../wire/schema'
import { isRecord } from '../fold/records'
// Type-only side effect: installs this plugin's projection-key augmentation.
import type {} from './augment'

/** The projection key this unit owns. */
export const HEADERS_KEY = 'contextHeaders' as const

/** Pinned at 1; see the module header for why this one never moves. */
export const HEADERS_STATE_VERSION = 1

/** Only the newest epochs are retained; older ones scroll off the front. */
export const HEADERS_MAX = 50

/**
 * One stored tool: v1 rows carry the producer's description and raw schema, and every fold since
 * appends metadata only.
 */
interface StoredTool {
  name: string
  tokens: number
  description?: string
  plugin?: string
  schema?: unknown
}

/** One stored epoch: v1 rows carry `system`, later folds carry `systemTokens`. */
interface StoredEpoch {
  seq: number
  time: number
  system?: string
  systemTokens?: number
  tools: StoredTool[]
}

/** The headers unit's persisted state: epoch metadata rows, oldest first. */
export interface HeadersState {
  headers: StoredEpoch[]
}

/** Attribute a tool name to its owning plugin; best-effort, `undefined` when unknown. */
export type OwnerResolver = (name: string) => string | undefined

/**
 * Fold one `request/header` event into a stored epoch.
 *
 * @returns `null` for every other event family, and for a header payload that is not a record — this
 * unit has no try/catch, so an impossible shape must degrade to "not an epoch" rather than throw out
 * of the registry's drive loop.
 */
function epochOf(event: SessionEvent): StoredEpoch | null {
  if (event.type !== 'request/header') return null
  const rawHeader = (event.data as { header?: unknown } | undefined)?.header
  if (!isRecord(rawHeader)) return null
  // The supported epoch header never carries a system prompt (`EpochHeader.system` is `never`), so
  // an epoch folds metadata only. The stored `system` field exists purely for cached v1 rows.
  const tools = Array.isArray(rawHeader.tools) ? rawHeader.tools : []
  return {
    seq: event.seq,
    time: event.time,
    tools: tools.map((tool): StoredTool => {
      // A null or primitive entry degrades to an unnamed, JSON-priced tool instead of throwing.
      const record = isRecord(tool) ? tool : {}
      const entry: StoredTool = {
        name: typeof record.name === 'string' ? record.name : '?',
        tokens: estimateToolSchema(tool),
      }
      // Kept verbatim so the view's resolver can never override what a producer wrote. No supported
      // baseline writes it (ToolSchema has no plugin field), so this only serves forward compat.
      if (typeof record.plugin === 'string' && record.plugin !== '') entry.plugin = record.plugin
      return entry
    }),
  }
}

/** The wire form of one epoch: metadata only, with `plugin` filled in when it is known. */
function wireEpochOf(epoch: StoredEpoch, resolve: OwnerResolver | undefined): HeaderEpoch {
  const record: HeaderEpoch = {
    seq: epoch.seq,
    time: epoch.time,
    tools: epoch.tools.map((tool): HeaderedTool => {
      const entry: HeaderedTool = { name: tool.name, tokens: tool.tokens }
      const plugin = tool.plugin ?? (resolve !== undefined ? resolve(tool.name) : undefined)
      if (plugin !== undefined) entry.plugin = plugin
      return entry
    }),
  }
  // Stored metadata first; a legacy v1 row falls back to pricing its retained system text once, at
  // read time, so an old cache row still yields a usable prompt size.
  const systemTokens = epoch.systemTokens
    ?? (typeof epoch.system === 'string' && epoch.system !== '' ? estimateSystemText(epoch.system) : undefined)
  if (systemTokens !== undefined) record.systemTokens = systemTokens
  return record
}

/**
 * Build the unit.
 *
 * @param resolve - best-effort "which plugin registered this tool" attribution; applied at view time
 *                  so an epoch folded before attribution existed still renders a label.
 */
export function createHeadersUnit(
  resolve?: OwnerResolver,
): ProjectionDefinition<typeof HEADERS_KEY, HeadersState> {
  return {
    key: HEADERS_KEY,
    stateSchema: headerStateSchema,
    init: () => ({ headers: [] }),
    apply: (state: HeadersState, event: SessionEvent): HeadersState => {
      const epoch = epochOf(event)
      if (epoch === null) return state
      // The agent loop suppresses unchanged headers itself; this guards a replay of the same epoch.
      const last = state.headers.at(-1)
      if (last !== undefined && last.seq === epoch.seq) return state
      const headers = [...state.headers, epoch]
      return { headers: headers.length > HEADERS_MAX ? headers.slice(-HEADERS_MAX) : headers }
    },
    wire: {
      viewSchema: headerViewSchema,
      view: (state: HeadersState): HeaderTimeline => ({
        headers: state.headers.map(epoch => wireEpochOf(epoch, resolve)),
      }),
    },
    stateVersion: HEADERS_STATE_VERSION,
  }
}
