/**
 * Zod schemas for everything that leaves the host half.
 *
 * Two jobs, both load-bearing:
 *  1. `stateSchema` guards the persisted projection-cache rows before they seed a fold. A row
 *     written by an older build must either parse or be discarded — never be half-applied.
 *  2. `viewSchema` guards every payload the registry publishes to a browser. The old tree used
 *     `.strict()` here on purpose: an extra field reaching the wire would be a field nobody
 *     prices, so it fails loudly in development instead of shipping.
 *
 * The projection `view` schemas are deliberately narrower than the state schemas: state carries
 * working slots (open step, pending call names) that must never leak.
 */

import { z } from 'zod'
import type {
  ActivityLedger, BucketTotals, CostLedger, HeaderTimeline, LedgerDay, Snapshot, TimelineDetail,
} from './model'

const counter = z.number().int().nonnegative()

// ---------------------------------------------------------------------------
// Leaf records
// ---------------------------------------------------------------------------

const systemNode = z.object({
  seq: counter,
  time: z.number(),
  tokens: counter,
}).strict()

const surfaceEntry = z.object({
  seq: counter,
  time: z.number().optional(),
  cat: z.enum(['user', 'inject', 'skill', 'assistant', 'tool']),
  tokens: counter,
  imgs: counter.optional(),
  gone: counter.optional(),
  form: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  tool: z.string().optional(),
  err: z.boolean().optional(),
  skill: z.string().optional(),
  calls: z.array(z.string()).optional(),
}).strict()

const requestRow = z.object({
  turn: z.number().optional(),
  step: z.number().optional(),
  time: z.number(),
  seq: z.number(),
  system: counter,
  tools: counter,
  user: counter,
  inject: counter,
  assistant: counter,
  tool: counter,
  total: counter,
  prompt: counter.optional(),
  skill: counter.optional(),
  cacheRead: counter.optional(),
  output: counter.optional(),
  activeMs: z.number().nonnegative().optional(),
  stepCount: z.number().int().positive().optional(),
  net: z.number().optional(),
}).strict()

const ledgerEvent = z.object({
  seq: z.number(),
  time: z.number(),
  kind: z.enum(['compaction', 'prune', 'inject', 'model', 'mode']),
  form: z.string().optional(),
  tokens: z.number().optional(),
  count: z.number().optional(),
  sub: z.string().optional(),
  name: z.string().optional(),
  detail: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  fromTurn: z.number().optional(),
  fromStep: z.number().optional(),
  turn: z.number().optional(),
  step: z.number().optional(),
}).strict()

const fileOp = z.object({
  seq: z.number(),
  path: z.string(),
  kind: z.enum(['read', 'write', 'search']),
  tool: z.string(),
  time: z.number().optional(),
  err: z.boolean(),
  added: counter,
  removed: counter,
  detail: z.string().optional(),
  hits: z.number().optional(),
  read: z.union([
    z.object({ start: z.number(), count: z.number() }).strict(),
    z.object({ count: z.number(), est: z.literal(true) }).strict(),
  ]).optional(),
  parent: z.number().optional(),
  program: z.string().optional(),
  pattern: z.literal(true).optional(),
}).strict()

const timingSegment = z.object({
  kind: z.enum(['ttft', 'reasoning', 'text', 'toolarg', 'tools', 'other']),
  start: z.number(),
  end: z.number(),
}).strict()

const toolTiming = z.object({ calls: z.number(), ms: z.number() }).strict()

const timingTotals = z.object({
  wallMs: z.number(),
  ttftMs: z.number(),
  genMs: z.number(),
  reasoningMs: z.number().optional(),
  reasoningBlocks: z.number().optional(),
  textMs: z.number().optional(),
  textBlocks: z.number().optional(),
  toolArgMs: z.number().optional(),
  toolArgBlocks: z.number().optional(),
  speedTokens: z.number().optional(),
  speedMs: z.number().optional(),
  calls: z.number(),
  toolsMs: z.number(),
  toolCalls: z.number(),
  tools: z.record(z.string(), toolTiming),
}).strict()

const bucketTotals: z.ZodType<BucketTotals> = z.object({
  uncached: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  output: z.number(),
}).strict()

const modelLedger = z.object({
  peak: bucketTotals.optional(),
  off: bucketTotals.optional(),
}).strict()

/** Cost ledgers arrive from persisted state written by earlier builds whose keys are arbitrary
 * provider/model ids; only the leaf shape can be asserted. */
const costLedger: z.ZodType<CostLedger> = z.record(
  z.string(),
  z.record(z.string(), modelLedger),
)

const callLedger = z.record(z.string(), z.record(z.string(), z.number()))

const turnEntry = z.object({
  usage: costLedger,
  requests: callLedger,
}).strict()

const turnLedger = z.record(z.string(), turnEntry)

const creditRates = z.record(z.string(), z.record(z.string(), z.number()))

const retainedCounts = z.object({
  turns: counter,
  steps: counter,
  injects: counter,
  compactions: counter,
  prunes: counter,
  skills: counter.optional(),
}).strict()

const newestRequest = z.object({
  seq: z.number(),
  total: counter,
  prompt: counter.optional(),
}).strict()

// ---------------------------------------------------------------------------
// Projection 1: contextTimeline — view payload
// ---------------------------------------------------------------------------

/** The published timeline value. Collections are optional-but-present on the inline generation
 * and empty on the slim head; `detailRev`'s presence is what marks the split generation. */
export const timelineViewSchema: z.ZodType<Snapshot> = z.object({
  ok: z.boolean(),
  unsupported: z.object({ current: z.string(), minimum: z.string() }).strict().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  contextWindow: z.number().optional(),
  current: z.object({
    system: counter,
    tools: counter,
    user: counter,
    inject: counter,
    skill: counter,
    assistant: counter,
    tool: counter,
    total: counter,
  }).strict(),
  images: counter.optional(),
  toolCalls: counter.optional(),
  humanInputs: counter.optional(),
  answers: counter.optional(),
  lastUser: z.string().optional(),
  counts: retainedCounts.optional(),
  last: newestRequest.optional(),
  detailRev: counter.optional(),
  requests: z.array(requestRow),
  events: z.array(ledgerEvent),
  cost: costLedger.optional(),
  calls: callLedger.optional(),
  turnCost: turnLedger.optional(),
  creditRates: creditRates.optional(),
  timing: timingTotals.optional(),
  systems: z.array(systemNode).optional(),
  nodes: z.array(surfaceEntry),
  droppedNodes: counter,
  archive: z.array(surfaceEntry),
  surfaceFloor: z.number().optional(),
  archiveFloor: z.number().optional(),
  fileOps: z.array(fileOp).optional(),
  fileOpsFloor: counter.optional(),
  spans: z.array(timingSegment).optional(),
}).strict() as unknown as z.ZodType<Snapshot>

/** The detail route payload. */
export const timelineDetailSchema: z.ZodType<TimelineDetail> = z.object({
  rev: counter,
  head: timelineViewSchema.optional(),
  requests: z.array(requestRow),
  events: z.array(ledgerEvent),
  nodes: z.array(surfaceEntry),
  droppedNodes: counter,
  archive: z.array(surfaceEntry),
  surfaceFloor: z.number().optional(),
  archiveFloor: z.number().optional(),
  fileOps: z.array(fileOp).optional(),
  fileOpsFloor: counter.optional(),
  spans: z.array(timingSegment).optional(),
}).strict() as unknown as z.ZodType<TimelineDetail>

// ---------------------------------------------------------------------------
// Projection 1: contextTimeline — persisted state
// ---------------------------------------------------------------------------

/** Working state of the timeline fold. This is exactly what the projection cache checkpoints,
 * so it must be plain JSON: every optional field is *absent* rather than `undefined`, because
 * one `undefined`-valued property makes the whole checkpoint unserialisable.
 *
 * Not exported as a public type: `TimelineState` lives with the reducer. */
export const timelineStateSchema = z.object({
  surface: z.array(surfaceEntry),
  sums: z.object({
    user: z.number(), inject: z.number(), skill: z.number(),
    assistant: z.number(), tool: z.number(),
  }).strict(),
  systemTokens: z.number(),
  systems: z.array(systemNode).optional(),
  toolsTokens: z.number(),
  model: z.string().optional(),
  provider: z.string().optional(),
  lastModel: z.string().optional(),
  contextWindow: z.number().optional(),
  requests: z.array(requestRow),
  turnRuns: z.number().optional(),
  events: z.array(ledgerEvent),
  archived: z.array(surfaceEntry),
  cost: costLedger.optional(),
  turnCost: turnLedger.optional(),
  calls: callLedger.optional(),
  humanInputs: z.number().optional(),
  answers: z.number().optional(),
  lastUser: z.string().optional(),
  archiveFloor: z.number().optional(),
  detailRev: z.number().optional(),
  timing: timingTotals.optional(),
  stepStart: z.object({ time: z.number(), firstToken: z.number().optional() }).strict().optional(),
  stepWaits: z.array(z.object({ start: z.number(), end: z.number() }).strict()).optional(),
  stepApprovals: z.record(z.string(), z.number()).optional(),
  stepRequestSeq: z.number().optional(),
  spans: z.array(timingSegment),
  stepSpans: z.array(timingSegment).optional(),
  callNames: z.record(z.string(), z.object({
    name: z.string(), start: z.number(), argsRaw: z.string().optional(),
  }).strict()),
  pendingShadowedSeqs: z.array(z.number()).optional(),
  pendingShadowEventSeq: z.number().optional(),
  fileOps: z.array(fileOp),
  fileOpsFloor: counter.optional(),
  pendingCodeOps: z.record(z.string(), z.array(fileOp)).optional(),
}).strict()

// ---------------------------------------------------------------------------
// Projection 2: contextHeaders
// ---------------------------------------------------------------------------

const headeredTool = z.object({
  name: z.string(),
  tokens: z.number(),
  plugin: z.string().optional(),
}).strict()

const headerEpoch = z.object({
  seq: z.number(),
  time: z.number(),
  systemTokens: z.number().optional(),
  tools: z.array(headeredTool),
}).strict()

export const headerViewSchema: z.ZodType<HeaderTimeline> = z.object({
  headers: z.array(headerEpoch),
}).strict() as unknown as z.ZodType<HeaderTimeline>

/** Epoch metadata. The stored shape is a superset of what the view serves: it still accepts
 * legacy rows that carried the system text and tool schemas, so an old cache row keeps
 * working instead of being discarded (and an idle session never re-folds, so its key would
 * hang forever). */
export const headerStateSchema = z.object({
  headers: z.array(z.object({
    seq: z.number(),
    time: z.number(),
    system: z.string().optional(),
    systemTokens: z.number().optional(),
    tools: z.array(z.object({
      name: z.string(),
      tokens: z.number(),
      description: z.string().optional(),
      plugin: z.string().optional(),
      schema: z.unknown().optional(),
    }).strict()),
  }).strict()),
}).strict()

// ---------------------------------------------------------------------------
// Projection 3: contextActivity
// ---------------------------------------------------------------------------

const dayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const ledgerDay: z.ZodType<LedgerDay> = z.object({
  tokens: z.number(),
  requests: z.number(),
  cost: costLedger.optional(),
  skills: z.record(z.string(), z.object({ n: z.number(), last: z.number() }).strict()).optional(),
}).strict() as unknown as z.ZodType<LedgerDay>

export const activityViewSchema: z.ZodType<ActivityLedger> = z.object({
  days: z.record(dayKey, ledgerDay),
}).strict() as unknown as z.ZodType<ActivityLedger>

export const activityStateSchema = z.object({
  days: z.record(dayKey, ledgerDay),
  model: z.string().optional(),
  provider: z.string().optional(),
  stepStart: z.number().optional(),
  skillCalls: z.array(z.string()).optional(),
}).strict()

// ---------------------------------------------------------------------------
// Route payloads
// ---------------------------------------------------------------------------

export const balanceViewSchema = z.object({
  isAvailable: z.boolean(),
  balances: z.array(z.object({
    currency: z.string(),
    total: z.number(),
    granted: z.number(),
    toppedUp: z.number(),
  }).strict()),
}).strict()

export const skillEntrySchema = z.object({
  name: z.string(),
  description: z.string(),
  path: z.string().optional(),
  source: z.string().optional(),
}).strict()

export const skillsViewSchema = z.object({
  skills: z.array(skillEntrySchema),
}).strict()

export const creditsViewSchema = z.object({
  total: z.number(),
  unlimited: z.boolean(),
  cycleResetTime: z.string().optional(),
}).strict()

/** The failed-route envelope. `code` is namespaced so a client can switch on it without
 * matching English text. */
export const routeFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }).strict(),
}).strict()
