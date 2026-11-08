/**
 * The plugin's wire model — the JSON that crosses from the host half to the browser half.
 *
 * These names are a contract, not an implementation detail: the two halves are built from
 * the same source but never share a module instance, and a host restart can serve a page
 * whose client bundle was loaded a minute earlier. Every field name here is what actually
 * travels, so renaming one is a wire break, not a refactor.
 *
 * All quantities are integers unless stated otherwise. Token counts are provider-reported
 * or heuristic estimates; money never appears on this wire (the host writes tokens only).
 */

/** Billing surface bucket. `skill` isolates the harness-injected skill mechanism
 * (`<available_skills>` catalog summary, `/name` invocations, `skill` tool loads) from
 * ordinary injected context, because it is billed and displayed separately. */
export type Stage = 'user' | 'inject' | 'skill' | 'assistant' | 'tool'

/** One live system-prompt node. The effective system price is the last node whose
 * `tokens` is positive; earlier nodes stay so a momentarily empty system message does not
 * erase the prompt price. */
export interface SystemNode {
  seq: number
  time: number
  tokens: number
}

/** Precomputed counters over the *retained* records (not the whole log). */
export interface RetainedCounts {
  turns: number
  steps: number
  injects: number
  compactions: number
  prunes: number
  /** Distinct skill names among retained event rows. */
  skills?: number
}

/** Billing summary of the newest retained request. */
export interface NewestRequest {
  seq: number
  total: number
  /** Provider-reported prompt size, when the request carried usage. */
  prompt?: number
}

/** One day in the activity ledger. */
export interface LedgerDay {
  /** Billed tokens settled that day (input + cache read + cache write + output). */
  tokens: number
  /** Completed model calls that day. */
  requests: number
  /** Billed buckets per provider → model → period. Absent when only tokens are known. */
  cost?: CostLedger
  /** Skill name → load count and last load time (epoch ms). */
  skills?: Record<string, { n: number; last: number }>
}

/** Per-session daily ledger, keyed by the host's local `YYYY-MM-DD` day. */
export interface ActivityLedger {
  days: Record<string, LedgerDay>
}

/** One available skill, as served by the skill-catalogue route. */
export interface SkillEntry {
  name: string
  description: string
  path?: string
  source?: string
}

/** Display granularity for the request table. */
export type Granularity = 'step' | 'turn'
/** Whether the cost curve is cumulative or per-step delta. */
export type TrendMode = 'total' | 'delta'
/** File table ordering. */
export type FileSort = 'count' | 'latest' | 'path'
/** Tool ranking ordering. */
export type ToolSort = 'size' | 'count' | 'name'
/** Where the context surface is mounted. */
export type Placement = 'all' | 'tab' | 'sidebar'
/** Whether the dock exposes the Insights entry. */
export type InsightsEntry = 'show' | 'hide'
/** Whether the session time strip draws the duration curve. */
export type DurationCurve = 'show' | 'hide'
/** Which subscription tier the user pays for, as a 0-based index into the plan family's tier list.
 * One number across families whose tier counts differ: 0 is the entry tier everywhere. */
export type PlanTierIndex = number

/** User preferences persisted through the settings service (host config, volatile layer). */
export interface Preferences {
  defaultPlacement: Placement
  defaultGranularity: Granularity
  defaultTrendMode: TrendMode
  defaultToolSort: ToolSort
  defaultFileSort: FileSort
  insightsEntry: InsightsEntry
  defaultDurationCurve: DurationCurve
  defaultPlanTier: PlanTierIndex
}

/** Editable preference keys (derived so a rename cannot silently drop a form field). */
export type PreferenceKey = keyof Preferences

/** The `contextTimeline` value. Collections (`requests`, `events`, `nodes`, `archive`) are
 * empty in the slim head generation and filled from `TimelineDetail`; `counts`, `last` and
 * `detailRev` only exist in that split generation. */
export interface Snapshot {
  ok: boolean
  /** Present only when the running harness is below the supported baseline: the host folds
   * nothing (all numbers zero) and the client shows an upgrade notice. */
  unsupported?: { current: string; minimum: string }
  model?: string
  provider?: string
  contextWindow?: number
  current: {
    system: number
    tools: number
    user: number
    inject: number
    skill: number
    assistant: number
    tool: number
    total: number
  }
  /** Image blocks in the live context (user uploads + tool results). */
  images?: number
  /** Live tool results on the surface (skill-tool nodes count). */
  toolCalls?: number
  /** Whole-session human inputs: non-injected user messages + answered questions. */
  humanInputs?: number
  /** Whole-session replies: assistant messages carrying non-blank text. */
  answers?: number
  /** Newest user message as a single-line preview (≤80 chars). */
  lastUser?: string
  counts?: RetainedCounts
  last?: NewestRequest
  detailRev?: number
  requests: RequestRow[]
  events: LedgerEvent[]
  cost?: CostLedger
  calls?: CallLedger
  turnCost?: TurnLedger
  /** Per-request credit rates read from the platforms' own catalogues. Absent, never guessed. */
  creditRates?: { [provider: string]: { [model: string]: number } }
  timing?: TimingTotals
  systems?: SystemNode[]
  nodes: SurfaceEntry[]
  droppedNodes: number
  archive: SurfaceEntry[]
  surfaceFloor?: number
  archiveFloor?: number
  fileOps?: FileOp[]
  fileOpsFloor?: number
  spans?: TimingSegment[]
}

/** Alias kept for consumers that name the projection by its key. */
export type TimelineSnapshot = Snapshot

/** The heavy collections, fetched per viewing client by `POST /api/dsh-cost-breakdown/detail`. */
export interface TimelineDetail {
  /** Mirrors the head's `detailRev`; the client's last-writer-wins cursor. */
  rev: number
  /** Same-cut slim head, so a cold session's scalars are readable. */
  head?: Snapshot
  requests: RequestRow[]
  events: LedgerEvent[]
  nodes: SurfaceEntry[]
  droppedNodes: number
  archive: SurfaceEntry[]
  surfaceFloor?: number
  archiveFloor?: number
  fileOps?: FileOp[]
  fileOpsFloor?: number
  spans?: TimingSegment[]
}

/** One executed file operation, folded from the durable tool lifecycle. Line counts are
 * estimates read from the call arguments. */
export interface FileOp {
  seq: number
  /** The touched file; for a path-less search, the searched pattern (`pattern: true`). */
  path: string
  kind: 'read' | 'write' | 'search'
  tool: string
  time?: number
  err: boolean
  added: number
  removed: number
  detail?: string
  hits?: number
  read?: { start: number; count: number } | { count: number; est: true }
  /** Nested Code-Mode op: the `run_code` result node it ran under. */
  parent?: number
  /** Nested Code-Mode op: the model-written program description. */
  program?: string
  pattern?: true
}

/** One live (or archived) model-visible message on the surface. */
export interface SurfaceEntry {
  seq: number
  time?: number
  cat: Stage
  tokens: number
  imgs?: number
  /** Archive entries only: the seq of the replacement event that shadowed this node. */
  gone?: number
  form?: string
  /** Injection producer identity. */
  name?: string
  text?: string
  tool?: string
  err?: boolean
  skill?: string
  calls?: string[]
}

/** One answered model call (a step); records sharing a `turn` form one turn run. */
export interface RequestRow {
  turn?: number
  step?: number
  time: number
  seq: number
  system: number
  tools: number
  user: number
  inject: number
  assistant: number
  tool: number
  total: number
  prompt?: number
  skill?: number
  /** Billed cache reads (hits) — the numerator of the hit rate; `prompt` is the denominator. */
  cacheRead?: number
  output?: number
  /** Active milliseconds of the step (start→end minus user waits), stamped at step end. */
  activeMs?: number
  /** Client-set turn aggregation marker (the host never sets it). */
  stepCount?: number
  /** Client-set signed net change in delta mode (the host never sets it). */
  net?: number
}

/** One durable compaction/prune/inject/model/mode row rendered in the timeline. */
export interface LedgerEvent {
  seq: number
  time: number
  kind: 'compaction' | 'prune' | 'inject' | 'model' | 'mode'
  form?: string
  tokens?: number
  count?: number
  sub?: string
  name?: string
  detail?: string
  from?: string
  to?: string
  /** Turn/step of the request recorded immediately before this event. */
  fromTurn?: number
  fromStep?: number
  /** Turn/step of the request this event belongs to. */
  turn?: number
  step?: number
}

/** Sentinel for a tool that cannot be attributed to an owning plugin. */
export const UNATTRIBUTED_TOOL = '<unknown-plugin>'

/** One tool in a request-header epoch. */
export interface HeaderedTool {
  name: string
  tokens: number
  /** `mcp:<server>`, the live attribution label, or the sentinel above. */
  plugin?: string
}

/** Metadata of one request-header epoch (valid from `seq` until the next epoch). */
export interface HeaderEpoch {
  seq: number
  time: number
  systemTokens?: number
  tools: HeaderedTool[]
}

/** The `contextHeaders` value: a capped epoch list, newest last. */
export interface HeaderTimeline {
  headers: HeaderEpoch[]
}

/** A header epoch's content, mapped client-side from durable events. */
export interface HeaderContent {
  system?: string
  tools: Array<{ name: string; description?: string; schema?: unknown }>
}

/** One currency's DeepSeek platform balance. */
export interface BalanceEntry {
  currency: string
  /** Derived from granted + toppedUp, so the two halves round together. */
  total: number
  granted: number
  toppedUp: number
}

/** `POST /api/dsh-cost-breakdown/balance` value; `null` when unconfigured or unreadable. */
export interface PlatformBalance {
  isAvailable: boolean
  /** One entry per currency the account holds; at least one. */
  balances: BalanceEntry[]
}

/** Per-million-token rates (USD). Missing cache fields fall back to the input rate. */
export interface RateQuad { hit: number; miss: number; write: number; out: number }

/** Billed token buckets of one ledger period; provider-reported, never estimated. */
export interface BucketTotals {
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** One model's totals split by pricing period. Providers without period pricing book
 * everything under `peak` (the list-price bucket). */
export interface ModelLedger {
  peak?: BucketTotals
  off?: BucketTotals
}

/** Session cost raw material: billed tokens indexed provider → model → period. */
export interface CostLedger {
  [provider: string]: { [model: string]: ModelLedger }
}

/** Session-level request counts per (provider, model) — the per-request billed platforms
 * (credits) need counts, not tokens. */
export interface CallLedger {
  [provider: string]: { [model: string]: number }
}

/** One turn's billing raw material, same shape as the session ledger so both go through one
 * pricing function and can never disagree. */
export interface TurnEntry {
  usage: CostLedger
  requests: { [provider: string]: { [model: string]: number } }
}

/** Turn index (decimal string) → that turn's ledger. */
export interface TurnLedger {
  [turn: string]: TurnEntry
}

/** One segment of the session time strip. */
export interface TimingSegment {
  kind: 'ttft' | 'reasoning' | 'text' | 'toolarg' | 'tools' | 'other'
  start: number
  end: number
}

/** Wall-clock totals of the whole session (milliseconds). */
export interface TimingTotals {
  wallMs: number
  ttftMs: number
  genMs: number
  reasoningMs?: number
  reasoningBlocks?: number
  textMs?: number
  textBlocks?: number
  toolArgMs?: number
  toolArgBlocks?: number
  speedTokens?: number
  speedMs?: number
  calls: number
  toolsMs: number
  toolCalls: number
  tools: Record<string, { calls: number; ms: number }>
}

/** Which pricing period a request was billed in. */
export type Period = 'peak' | 'off'

/** Credit rates: provider → model → credits charged per request. Normalised by
 * `core/credits.ts`; carried on the timeline head so the browser never guesses a rate. */
export type CreditRateTable = Record<string, Record<string, number>>

/** One relay price row: the relay's own published price for one model. */
export interface RelayPrice {
  model: string
  platform: string
  group: string
  mode: 'token' | 'image'
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  perImage?: number
  multiplier?: number
  tiers?: Array<{ minTokens: number; input?: number; output?: number }>
}

/** A relay's published price table, plus when the host read it. */
export interface RelayPriceTable {
  relays: Record<string, Record<string, RelayPrice>>
  at: number
}

/** One quota window of a subscription plan, as the vendor reports it. */
export interface PlanQuotaWindow {
  /** The vendor's own label for the window (`5h`, `weekly`, `monthly`, …), printed verbatim. */
  label: string
  /** The window's ceiling. */
  total: number
  /** How much of the ceiling is consumed; never above `total`. */
  used: number
}

/** One subscription plan's live quota, relayed by the host's plan-quota route. */
export interface PlanQuota {
  /** The harness route id the quota belongs to. */
  provider: string
  /** The plan family this route bills through. */
  familyId: string
  windows: PlanQuotaWindow[]
  /** When the host read it (epoch ms), so the panel can say how fresh the figure is. */
  at: number
}

/** Route id → that plan's quota. A plan the host could not read is simply absent. */
export type PlanQuotaTable = Record<string, PlanQuota>

/** One credit edition's remaining balance, relayed by the host's credits route. */
export interface PlatformCredits {
  total: number
  unlimited: boolean
  /** ISO instant the cycle resets, when the platform reports one. */
  cycleResetTime?: string
}
