/**
 * Boundary washers: every value arriving from the host is re-validated here before any view
 * touches it.
 *
 * Why this exists at all: the two halves never share a module instance, and a host can be
 * upgraded (or a cached projection row can survive) between the client bundle loading and a
 * payload arriving. A malformed payload must therefore not be able to throw during render — a
 * render throw unmounts the conversation view, which is far worse than showing a loading state
 * or a repaired number.
 *
 * Two rules govern every washer here:
 *   - **Reference stability.** A payload that already passes the fast shape check is returned
 *     as-is, so a `useSyncExternalStore` selector sees the same object across unrelated events.
 *     A washer that always rebuilt would re-render every surface on every event.
 *   - **Absence is information.** A missing optional key means "an older host folded this", which
 *     is distinguishable from an empty list and must stay distinguishable: the views branch on it.
 */

import type {
  ActivityLedger, CallLedger, CostLedger, HeaderTimeline, LedgerDay, LedgerEvent, ModelLedger,
  RequestRow, Snapshot, SurfaceEntry, TimingTotals,
} from '../../wire/model'
import { estimateSystemText } from '../../core/tokens'

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

/** Plain-object view of an untrusted payload. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** A finite number, or 0. Used where a NaN must not leak into a percentage. */
export function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** A finite non-negative number, or 0. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** An optional non-negative number: anything else stays **absent** rather than becoming 0, so a
 * host that never folded the field renders the un-split layout instead of a row of zeroes. */
function optNumOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Object entries only; `null`/primitives inside an array are dropped. */
function objectsOf<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is T => entry !== null && typeof entry === 'object')
}

function recordsOnly(value: unknown): boolean {
  return Array.isArray(value) && value.every(entry => entry !== null && typeof entry === 'object')
}

// ---------------------------------------------------------------------------
// Cost ledger
// ---------------------------------------------------------------------------

/** Washed cost ledger, or `undefined` when the payload has no usable branch at all. Invalid
 * branches are dropped and invalid buckets zero-filled: garbage must price as 0, never as NaN. */
function costLedgerOf(value: unknown): CostLedger | undefined {
  const data = asRecord(value)
  if (data === null) return undefined
  const out: CostLedger = {}
  for (const provider of Object.keys(data)) {
    const models = asRecord(data[provider])
    if (models === null) continue
    const branch: { [model: string]: ModelLedger } = {}
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null) continue
      const copy: ModelLedger = {}
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        copy[period] = {
          uncached: numOf(bucket.uncached),
          cacheRead: numOf(bucket.cacheRead),
          cacheWrite: numOf(bucket.cacheWrite),
          output: numOf(bucket.output),
        }
      }
      branch[model] = copy
    }
    out[provider] = branch
  }
  return out
}

/** Fast-path precondition: every provider and every model branch is a record. Deliberately only
 * checked to this depth — the bucket fields are numbers and are handled by `numOf`. */
function costFastOk(value: unknown): boolean {
  if (value === undefined) return true
  const data = asRecord(value)
  if (data === null) return false
  return Object.keys(data).every((provider) => {
    const models = asRecord(data[provider])
    return models !== null
  })
}

function callLedgerOf(value: unknown): CallLedger | undefined {
  const data = asRecord(value)
  if (data === null) return undefined
  const out: CallLedger = {}
  for (const provider of Object.keys(data)) {
    const models = asRecord(data[provider])
    if (models === null) continue
    const branch: { [model: string]: number } = {}
    for (const model of Object.keys(models)) branch[model] = countOf(models[model])
    out[provider] = branch
  }
  return out
}

function copyCost(value: unknown): CostLedger | undefined {
  return costLedgerOf(value)
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

function timingFastOk(value: unknown): boolean {
  if (value === undefined) return true
  const totals = asRecord(value)
  if (totals === null) return false
  for (const key of ['wallMs', 'ttftMs', 'genMs', 'calls', 'toolsMs', 'toolCalls']) {
    if (typeof totals[key] !== 'number') return false
  }
  for (const key of ['reasoningMs', 'textMs', 'toolArgMs', 'reasoningBlocks', 'textBlocks', 'toolArgBlocks']) {
    const scalar = totals[key]
    if (scalar !== undefined && (typeof scalar !== 'number' || !Number.isFinite(scalar) || scalar < 0)) return false
  }
  const tools = asRecord(totals.tools)
  if (tools === null) return false
  for (const name of Object.keys(tools)) {
    const row = asRecord(tools[name])
    if (row === null) return false
    if (typeof row.calls !== 'number' || typeof row.ms !== 'number') return false
  }
  return true
}

/** Narrow the served timing totals. A malformed per-tool row loses only itself, so the ranking
 * never empties because of one bad name. */
export function timingOf(value: unknown): TimingTotals | null {
  const data = asRecord(value)
  if (data === null) return null
  const tools: Record<string, { calls: number; ms: number }> = {}
  const rawTools = asRecord(data.tools)
  if (rawTools !== null) {
    for (const name of Object.keys(rawTools)) {
      // An own `__proto__` key would set the prototype rather than become a row.
      if (name === '__proto__' || !Object.hasOwn(rawTools, name)) continue
      const row = asRecord(rawTools[name])
      if (row === null) continue
      const calls = row.calls
      const ms = row.ms
      // `!(calls >= 0)` rather than `calls < 0`: the former rejects NaN too.
      if (typeof calls !== 'number' || !(calls >= 0) || typeof ms !== 'number' || !(ms >= 0)) continue
      tools[name] = { calls, ms }
    }
  }
  const totals: TimingTotals = {
    wallMs: countOf(data.wallMs),
    ttftMs: countOf(data.ttftMs),
    genMs: countOf(data.genMs),
    calls: countOf(data.calls),
    toolsMs: countOf(data.toolsMs),
    toolCalls: countOf(data.toolCalls),
    tools,
  }
  const optional: Array<[keyof TimingTotals, unknown]> = [
    ['reasoningMs', data.reasoningMs], ['reasoningBlocks', data.reasoningBlocks],
    ['textMs', data.textMs], ['textBlocks', data.textBlocks],
    ['toolArgMs', data.toolArgMs], ['toolArgBlocks', data.toolArgBlocks],
    ['speedTokens', data.speedTokens], ['speedMs', data.speedMs],
  ]
  for (const [key, raw] of optional) {
    const scalar = optNumOf(raw)
    if (scalar !== undefined) (totals as unknown as Record<string, number>)[key] = scalar
  }
  return totals
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

function systemsFastOk(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    const node = asRecord(entry)
    if (node === null) return false
    return typeof node.seq === 'number' && Number.isFinite(node.seq)
      && typeof node.time === 'number' && Number.isFinite(node.time)
      && typeof node.tokens === 'number' && Number.isFinite(node.tokens)
  })
}

function systemsOf(value: unknown): Snapshot['systems'] {
  const out: NonNullable<Snapshot['systems']> = []
  for (const entry of objectsOf<Record<string, unknown>>(value)) {
    const { seq, time, tokens } = entry
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) continue
    out.push({ seq, time, tokens })
  }
  return out.sort((left, right) => left.seq - right.seq)
}

function countsOf(value: unknown): Snapshot['counts'] {
  const data = asRecord(value)
  if (data === null) return undefined
  return {
    turns: numOf(data.turns),
    steps: numOf(data.steps),
    injects: numOf(data.injects),
    compactions: numOf(data.compactions),
    prunes: numOf(data.prunes),
    skills: numOf(data.skills),
  }
}

function newestOf(value: unknown): Snapshot['last'] {
  const data = asRecord(value)
  if (data === null) return undefined
  if (typeof data.seq !== 'number' || !Number.isFinite(data.seq)) return undefined
  if (typeof data.total !== 'number' || !Number.isFinite(data.total)) return undefined
  return {
    seq: data.seq,
    total: data.total,
    ...(typeof data.prompt === 'number' && Number.isFinite(data.prompt) ? { prompt: data.prompt } : {}),
  }
}

export function unsupportedOf(value: unknown): { current: string; minimum: string } | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.current !== 'string' || typeof data.minimum !== 'string') return null
  return { current: data.current, minimum: data.minimum }
}

/** The collection block shared by the inline snapshot and the split detail payload.
 *
 * `fileOps`/`spans` are presence-keyed while the other collections are not: a **missing** key
 * means an older host never folded them (the card then takes the legacy path), and that must stay
 * distinguishable from a host serving an empty list. */
export function collectionsOf(data: Record<string, unknown>): Pick<Snapshot,
  'requests' | 'events' | 'nodes' | 'droppedNodes' | 'archive'
  | 'surfaceFloor' | 'archiveFloor' | 'fileOps' | 'fileOpsFloor' | 'spans'> {
  return {
    requests: objectsOf<RequestRow>(data.requests),
    events: objectsOf<LedgerEvent>(data.events),
    nodes: objectsOf<SurfaceEntry>(data.nodes),
    droppedNodes: numOf(data.droppedNodes),
    archive: objectsOf<SurfaceEntry>(data.archive),
    ...(typeof data.surfaceFloor === 'number' ? { surfaceFloor: data.surfaceFloor } : {}),
    ...(typeof data.archiveFloor === 'number' ? { archiveFloor: data.archiveFloor } : {}),
    ...(data.fileOps !== undefined ? { fileOps: objectsOf(data.fileOps) } : {}),
    ...(typeof data.fileOpsFloor === 'number' ? { fileOpsFloor: data.fileOpsFloor } : {}),
    ...(data.spans !== undefined ? { spans: objectsOf(data.spans) } : {}),
  }
}

/**
 * Narrow a served projection value into a render-safe snapshot.
 *
 * A non-record stays `null` (the caller shows its loading state); a record that does not match the
 * wire shape is **repaired** field by field, so a damaged payload cannot throw during render and
 * unmount the conversation view.
 */
export function snapshotOf(value: unknown): Snapshot | null {
  const data = asRecord(value)
  if (data === null) return null
  const current = asRecord(data.current)
  const numericBreakdown = current !== null
    && ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool', 'total']
      .every(key => typeof current[key] === 'number')
  if (numericBreakdown
    && recordsOnly(data.requests)
    && recordsOnly(data.events)
    && recordsOnly(data.nodes)
    && recordsOnly(data.archive)
    && systemsFastOk(data.systems)
    && timingFastOk(data.timing)
    && costFastOk(data.cost)) {
    // Pass-through keeps the value reference-stable for selector equality.
    return data as unknown as Snapshot
  }
  const safeCurrent = current ?? {}
  const cost = copyCost(data.cost)
  const timing = timingOf(data.timing)
  const unsupported = unsupportedOf(data.unsupported)
  const counts = countsOf(data.counts)
  const last = newestOf(data.last)
  return {
    ok: true,
    ...(unsupported !== null ? { unsupported } : {}),
    ...(typeof data.model === 'string' ? { model: data.model } : {}),
    ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
    ...(typeof data.contextWindow === 'number' ? { contextWindow: data.contextWindow } : {}),
    current: {
      system: numOf(safeCurrent.system),
      tools: numOf(safeCurrent.tools),
      user: numOf(safeCurrent.user),
      inject: numOf(safeCurrent.inject),
      skill: numOf(safeCurrent.skill),
      assistant: numOf(safeCurrent.assistant),
      tool: numOf(safeCurrent.tool),
      total: numOf(safeCurrent.total),
    },
    ...collectionsOf(data),
    ...(typeof data.images === 'number' ? { images: data.images } : {}),
    ...(typeof data.toolCalls === 'number' ? { toolCalls: data.toolCalls } : {}),
    ...(typeof data.humanInputs === 'number' ? { humanInputs: data.humanInputs } : {}),
    ...(typeof data.answers === 'number' && Number.isFinite(data.answers) ? { answers: data.answers } : {}),
    ...(typeof data.lastUser === 'string' && data.lastUser !== '' ? { lastUser: data.lastUser.slice(0, 200) } : {}),
    ...(counts !== undefined ? { counts } : {}),
    ...(last !== undefined ? { last } : {}),
    ...(typeof data.detailRev === 'number' && Number.isFinite(data.detailRev) ? { detailRev: data.detailRev } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(callLedgerOf(data.calls) !== undefined ? { calls: callLedgerOf(data.calls) } : {}),
    ...(timing !== null ? { timing } : {}),
    ...(data.systems !== undefined ? { systems: systemsOf(data.systems) } : {}),
  }
}

// ---------------------------------------------------------------------------
// Header epochs
// ---------------------------------------------------------------------------

/**
 * Narrow the `contextHeaders` projection.
 *
 * One malformed epoch nulls the **whole** projection: downstream readers call
 * `tool.name.toLowerCase()` and diff `tokens` without re-checking, so a half-valid list would
 * throw somewhere far from here.
 *
 * Hosts predating the epoch-metadata split still serve the system **text** where the token price
 * now lives, so an unpriced entry is repaired with the shared estimation heuristic.
 */
export function headersOf(value: unknown): HeaderTimeline | null {
  const headers = asRecord(value)
  if (headers === null || !Array.isArray(headers.headers)) return null
  for (const entry of headers.headers as unknown[]) {
    const epoch = asRecord(entry)
    if (epoch === null || !Array.isArray(epoch.tools)) return null
    if (epoch.systemTokens !== undefined
      && (typeof epoch.systemTokens !== 'number' || !Number.isFinite(epoch.systemTokens))) return null
    for (const tool of epoch.tools as unknown[]) {
      const row = asRecord(tool)
      if (row === null) return null
      if (typeof row.name !== 'string') return null
      if (typeof row.tokens !== 'number' || !Number.isFinite(row.tokens)) return null
      if (row.plugin !== undefined && typeof row.plugin !== 'string') return null
    }
  }
  const legacy = (headers.headers as Array<Record<string, unknown>>)
    .some(epoch => epoch.systemTokens === undefined && typeof epoch.system === 'string' && epoch.system !== '')
  if (!legacy) return headers as unknown as HeaderTimeline
  // Rewrite in place rather than discard: the remaining metadata stays usable, and `|| undefined`
  // keeps "unpriced" for an estimate of zero instead of materialising a 0 price.
  return {
    headers: (headers.headers as Array<Record<string, unknown>>).map((epoch) => {
      if (epoch.systemTokens !== undefined) return epoch
      return { ...epoch, systemTokens: estimateSystemText(epoch.system) || undefined }
    }),
  } as unknown as HeaderTimeline
}

// ---------------------------------------------------------------------------
// Activity ledger
// ---------------------------------------------------------------------------

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

/** Narrow one day row. `dirty` reports whether anything had to be repaired, which decides
 * pass-through (reference-stable) versus rebuild. */
function dayOf(value: unknown): { day: LedgerDay; dirty: boolean } | null {
  const data = asRecord(value)
  if (data === null) return null
  let dirty = false
  const tokens = data.tokens
  const requests = data.requests
  const safeTokens = typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : (dirty = true, 0)
  const safeRequests = typeof requests === 'number' && Number.isFinite(requests) ? requests : (dirty = true, 0)
  const day: LedgerDay = { tokens: safeTokens, requests: safeRequests }
  if (data.cost !== undefined) {
    const cost = costLedgerOf(data.cost)
    if (cost !== undefined) day.cost = cost
    else dirty = true
  }
  if (data.skills !== undefined) {
    const raw = asRecord(data.skills)
    if (raw !== null) {
      const skills: Record<string, { n: number; last: number }> = {}
      for (const name of Object.keys(raw)) {
        const tally = asRecord(raw[name])
        if (tally === null) { dirty = true; continue }
        const n = tally.n
        const last = tally.last
        if (typeof n !== 'number' || !Number.isFinite(n) || typeof last !== 'number' || !Number.isFinite(last)) {
          dirty = true
          continue
        }
        skills[name] = { n, last }
      }
      day.skills = skills
    } else dirty = true
  }
  return { day, dirty }
}

/** Narrow the per-day activity projection. `null` means the key is absent (an older host), which
 * is not the same as an empty ledger. */
export function activityOf(value: unknown): ActivityLedger | null {
  const data = asRecord(value)
  if (data === null) return null
  const rawDays = asRecord(data.days)
  if (rawDays === null) return null
  let dirty = false
  const days: Record<string, LedgerDay> = {}
  for (const key of Object.keys(rawDays)) {
    // Day keys are compared lexicographically by the heatmap and the date filter, so a malformed
    // one would sort into the wrong week.
    if (!DAY_KEY.test(key)) { dirty = true; continue }
    const washed = dayOf(rawDays[key])
    if (washed === null) { dirty = true; continue }
    if (washed.dirty) dirty = true
    days[key] = washed.day
  }
  if (!dirty) return data as unknown as ActivityLedger
  return { days }
}
