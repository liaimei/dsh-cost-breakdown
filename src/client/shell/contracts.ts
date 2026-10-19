/**
 * The harness boundary: typed faces for every runtime service this bundle touches, and the
 * defensive readers that use them.
 *
 * These are **faces, not imports**. The runtime implementations belong to the user's harness, so
 * every member is optional and every read is re-validated at the call site: a service may be
 * trimmed from a deployment, may arrive after this plugin assemles, or may be replaced by an
 * untrusted implementation. Nothing here may assume a shape it has not proved.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType, ReactElement } from 'react'
import type { Snapshot } from '../../wire/model'
import type { Translate } from '../i18n/dict'
import { activityOf, headersOf, snapshotOf, timingOf } from './washers'
import type { ActivityLedger, HeaderTimeline, TimingTotals } from '../../wire/model'

/** The dictionary service. `bind` returns a translator already scoped to a namespace — components
 * should hold only that form, because an unbound `t` loses its namespace. */
export interface LocaleFace {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): Translate
  getLocale?(): { active: string }
}

/** One slot registration. `name` picks the seat; `id`/`key` distinguish entries in one seat (a keyed
 * seat mounts the entry whose key matches the current value, e.g. `main`). */
export interface SlotRegistration {
  name: string
  id?: string
  order?: number
  key?: string
  /** Dictionary namespace; the framework synthesises a `t` seat from it. */
  locale?: string
  label?: () => string
  inject?: (sessionId?: string) => unknown
}

/** The slot service. `inject` returns the registration's **cleanup function** (the callback's return
 * value), which is why callers collect it into their own disposers. */
export interface SlotsFace {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string } & Record<string, unknown>) => ReactElement | null,
  ): unknown
}

/** A right-sidebar tab guide entry, as the harness's `SidebarRightGuideEntry` declares it. */
export interface SidebarGuideEntry {
  order: number
  title: () => string
  description?: () => string
  icon?: ComponentType<{ size?: number }>
}

/** A tab *kind* registration: `kind` is the key the panel slot uses, `id` is the instance. */
export interface SidebarTabDefinition {
  id: string
  kind: string
  title: () => string
  guide?: readonly SidebarGuideEntry[]
}

/** The right-sidebar tab registry (`ctx.sidebarRightTabs`), reached through a deferred inject: a
 * deployment without it still assembles completely. */
export interface SidebarTabsFace {
  register(definition: SidebarTabDefinition): () => void
}

/** The right-sidebar navigation face (`ctx.sidebarRight`): `openResource` claims a
 * `dsh-resource://file/…` address through a bundled preview type. When it is missing or refuses, the
 * caller falls back to the system opener. */
export interface SidebarResourceFace {
  openResource(address: string): void
}

/** One settled chat node. It carries the `seq` of the surface event it came from, so the browser can
 * join on seq instead of projecting content itself. */
export interface ConversationNode {
  kind: string
  seq: number
  messageId?: unknown
  content?: readonly unknown[]
  blocks?: readonly unknown[]
  call?: { name: string; argsRaw: string } | null
  isError?: boolean
  summary?: string | null
  subCalls?: readonly unknown[]
  meta?: unknown
}

/** A persisted image attachment reference. Declaration-only: the durable log never inlines bytes. */
export interface ImageRef {
  attachmentId: string
  name?: string
  bytes?: number
  width?: number
  height?: number
  originalDimensions?: { width: number; height: number }
}

/** Loads a display URL for an attachment. Must reject rather than return an empty string, so the
 * card can show its unavailable state. */
export type ImageLoader = (attachment: ImageRef) => Promise<string>

/** The chat attachment service; optional everywhere. Without it an image node renders a
 * metadata-only card instead of failing. */
export interface ChatAttachmentFace {
  imageUrl?(sessionId: string, attachment: ImageRef): Promise<string>
}

/** The framework's standard seat kit for a session-scoped slot component. */
export interface SessionSeatProps {
  sessionId?: string
  useProjection?: (key: string) => unknown
  useChat?: UseChatHook
}

/** `useChat` seat: the selector must return a reference-stable slice, or the view re-renders on
 * every event. */
export type UseChatHook = <T>(selector: (snapshot: unknown) => T) => T

/** The right-sidebar variant of the seat: that column is too narrow for the header cards, and
 * `host: 'sidebar'` is the only switch the view branches on. */
export interface ContextSeatProps extends SessionSeatProps {
  host?: 'sidebar'
}

/** The slot-component seat the composer-row component receives. */
export interface DockSeatProps extends SessionSeatProps {
  sessionId?: string
}

/** The plugin's Context, with the two hard injects as compile-time facts. Every other service is
 * reached defensively or through a deferred inject. */
export type ClientContext = Context & {
  locale: LocaleFace
  slots: SlotsFace
}

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

/** A plain-object view of an untrusted service face. */
export function faceOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

/** Read one projection key through the seat and wash it. The seat is a hook: it must be called
 * unconditionally at the top of a component, once per key, in stable order. */
export function projectionOf<T>(
  props: SessionSeatProps,
  key: string,
  wash: (value: unknown) => T | null,
): T | null {
  if (typeof props.useProjection !== 'function') return null
  return wash(props.useProjection(key))
}

/** The timeline value from the seat. */
export function timelineOf(props: SessionSeatProps): Snapshot | null {
  return projectionOf(props, 'contextTimeline', snapshotOf)
}

/** The header-epoch value from the seat. */
export function headerEpochsOf(props: SessionSeatProps): HeaderTimeline | null {
  return projectionOf(props, 'contextHeaders', headersOf)
}

/** A projection the token meter owns (pressure, breakdown, usage) — read with the vocabulary this
 * plugin mirrors rather than importing the meter. */
export function meterProjectionOf<T>(props: SessionSeatProps, key: string, wash: (value: unknown) => T | null): T | null {
  return projectionOf(props, key, wash)
}

/** The chat nodes from the seat; `undefined` when the seat delivered no real array, in which case the
 * caller renders without the join. */
export function conversationNodesOf(props: SessionSeatProps): readonly ConversationNode[] | undefined {
  const useChat = props.useChat
  if (typeof useChat !== 'function') return undefined
  try {
    // `s.legacy` is a stable object; the array is read outside the selector.
    const slice = useChat((snapshot: unknown) => {
      if (snapshot === null || typeof snapshot !== 'object') return undefined
      return (snapshot as { legacy?: unknown }).legacy
    })
    const nodes = slice !== null && typeof slice === 'object' ? (slice as { nodes?: unknown }).nodes : undefined
    return Array.isArray(nodes) ? nodes as readonly ConversationNode[] : undefined
  } catch {
    // An untrusted seat degrades the join to empty rather than the view to a crash.
    return undefined
  }
}

/** A session-scoped image loader; `undefined` when the service is missing or untrusted, which renders
 * metadata-only cards. */
export function imageLoaderOf(ctx: ClientContext, sessionId: string | undefined): ImageLoader | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const conversation = ctx.get('uiConversation') as ChatAttachmentFace | undefined
    if (conversation !== undefined && typeof conversation.imageUrl === 'function') {
      const imageUrl = conversation.imageUrl.bind(conversation)
      return attachment => imageUrl(sessionId, attachment)
    }
  } catch {
    // Missing or hostile service: metadata-only cards.
  }
  return undefined
}

/** The activity ledger from the seat. */
export function activityLedgerOf(props: SessionSeatProps): ActivityLedger | null {
  return projectionOf(props, 'contextActivity', activityOf)
}

/** Timing totals from a snapshot (already washed by `snapshotOf`). */
export function timingFrom(snapshot: Snapshot | null): TimingTotals | null {
  return snapshot === null ? null : timingOf(snapshot.timing)
}

/** The session's workspace root, taken from **its** session-list row rather than the host process's
 * cwd: a plugin serving several workspaces must resolve relative paths against the session that
 * produced them. */
export function workspaceOf(ctx: ClientContext, sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const sessions = ctx.get('sessions') as { list?: { getSnapshot(): unknown } } | undefined
    const snapshot = typeof sessions?.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
    const byId = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { byId?: unknown }).byId : undefined
    const row: unknown = byId !== null && typeof byId === 'object' ? (byId as Record<string, unknown>)[sessionId] : undefined
    const cwd = row !== null && typeof row === 'object' ? (row as { cwd?: unknown }).cwd : undefined
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/** The sessions service face this plugin consumes. `refresh` is optional so a trimmed deployment can
 * still list sessions. */
export interface SessionsFace {
  list?: { getSnapshot(): unknown; subscribe?(listener: () => void): () => void }
  scope?(id: string): { bail(subject: unknown, event: string, payload: unknown): unknown } | undefined
  refresh?(): Promise<unknown>
}

/** The connection service face: a generic RPC caller, plus the loopback fact the harness's own open
 * entry points rely on. */
export interface ConnectionFace {
  isLoopback?: boolean
  rpc?: {
    call?(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

const OPEN_CHANNEL = '/api'
const CAN_OPEN_ENDPOINT = 'session/canOpenWorkspacePath'
const OPEN_ENDPOINT = 'session/openWorkspacePath'

/** A bound generic RPC caller; `undefined` when the service is missing or untrusted. */
function rpcCallerOf(ctx: ClientContext): ((channel: string, endpoint: string, payload: unknown) => Promise<unknown>) | undefined {
  try {
    const rpc = faceOf((ctx.get('connection') as ConnectionFace | undefined)?.rpc)
    const call = rpc?.call
    if (rpc !== null && typeof call === 'function') {
      return (call as (channel: string, endpoint: string, payload: unknown) => Promise<unknown>).bind(rpc)
    }
  } catch {
    // Missing or hostile connection: callers degrade to "cannot open".
  }
  return undefined
}

/** Whether this deployment can hand a path to the native desktop: loopback **and** a positive RPC
 * round trip confirming the session controller's ability. Any missing part, untrusted face or
 * transport failure resolves to `false`. */
export async function canOpenPaths(ctx: ClientContext): Promise<boolean> {
  const call = rpcCallerOf(ctx)
  if (call === undefined) return false
  try {
    const connection = ctx.get('connection') as ConnectionFace | undefined
    if (connection?.isLoopback !== true) return false
    const result = await call(OPEN_CHANNEL, CAN_OPEN_ENDPOINT, { args: {} })
    const record = faceOf(result)
    return record !== null && record.ok === true && record.value === true
  } catch {
    return false
  }
}

/** The session controller's system path opener; `undefined` without an RPC caller. Fire-and-forget:
 * opening is best effort and its failure stays silent. */
export function openPathWith(ctx: ClientContext): ((path: string) => void) | undefined {
  const call = rpcCallerOf(ctx)
  if (call === undefined) return undefined
  return (path: string): void => {
    try {
      // `args` is keyed by the remote's declared parameter names (the gateway's wire contract —
      // an array payload is rejected host-side).
      void call(OPEN_CHANNEL, OPEN_ENDPOINT, { args: { request: { path } } })
        .catch(() => { /* best effort */ })
    } catch {
      // Same contract for a transport that throws synchronously.
    }
  }
}

/** The right-sidebar resource opener; `undefined` when that column is absent, in which case callers
 * keep their system-open fallback. `openResource` throws when nobody claims the address, which is how
 * the caller learns the address is unclaimed. */
export function resourceOpenerOf(ctx: ClientContext): ((address: string) => boolean) | undefined {
  const face = (): SidebarResourceFace | undefined => {
    try {
      const record = faceOf(ctx.get('sidebarRight'))
      return record !== null && typeof record.openResource === 'function'
        ? record as unknown as SidebarResourceFace
        : undefined
    } catch {
      return undefined
    }
  }
  if (face() === undefined) return undefined
  return (address: string): boolean => {
    const current = face()
    if (current === undefined) return false
    try {
      current.openResource(address)
      return true
    } catch {
      // No preview type claimed it, or no session surface is mounted.
      return false
    }
  }
}

/** Jump to a session through the view host's own selection verb (`uiWorkspace.openSession`) — the
 * same one a sidebar row click uses. A missing or untrusted face is swallowed so a dead jump stays
 * on the current page. */
export function openSessionWith(ctx: ClientContext, id: string): void {
  try {
    const workspace = faceOf(ctx.get('uiWorkspace'))
    const open = workspace?.openSession
    if (typeof open === 'function') open.call(workspace, id)
  } catch {
    // Missing or hostile face: the jump is best effort.
  }
}

/** The input-trigger service (`ctx.inputTriggers`): one `'/'` source whose candidates, pick and Enter
 * handling all stay client-side. */
export interface InputTriggersFace {
  registerSource(source: {
    trigger: '/'
    name: string
    order?: number
    candidates(
      session: { sessionId: string },
      request: { query: string; position: string; signal: AbortSignal },
    ): Promise<readonly TriggerCandidate[]>
    onPick(pick: TriggerPick): 'handled' | undefined
    matchEnter?(
      session: { sessionId: string },
      line: string,
      signal: AbortSignal,
    ): Promise<'handled' | undefined>
  }): () => void
}

/** One menu candidate. Grouping fields replace the menu's source-title row, which would otherwise
 * print the raw source name. */
export interface TriggerCandidate {
  name: string
  label: string
  icon?: ComponentType<{ size?: number }>
  section?: string
  description?: string
}

/** Where a picked candidate came from: the typed span it replaced. */
export interface TriggerPick {
  session: { sessionId: string }
  position: string
  via: string
  span: unknown
}

/** A deferred service face, resolved by name at the call site. */
export function serviceOf<T>(ctx: ClientContext, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/** The gateway's history paging verb (`remote.session.page`): `throughSeq` is an inclusive log cut that must
 * name a real event, `beforeSeq` an exclusive upper bound. Rows are `SessionHistoryRecord`s — `{type:'event',
 * event}` plus the packed chunk rows the browser's mapper skips. */
export interface SessionPageFace {
  page(request: {
    address: { kind: 'session'; sessionId: string }
    throughSeq: number
    beforeSeq?: number
    maxMessages?: number
  }, signal?: AbortSignal): Promise<unknown>
}
