
import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/wire/model.d.ts
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
type Stage = 'user' | 'inject' | 'skill' | 'assistant' | 'tool';
/** One live system-prompt node. The effective system price is the last node whose
 * `tokens` is positive; earlier nodes stay so a momentarily empty system message does not
 * erase the prompt price. */
interface SystemNode {
  seq: number;
  time: number;
  tokens: number;
}
/** Precomputed counters over the *retained* records (not the whole log). */
interface RetainedCounts {
  turns: number;
  steps: number;
  injects: number;
  compactions: number;
  prunes: number;
  /** Distinct skill names among retained event rows. */
  skills?: number;
}
/** Billing summary of the newest retained request. */
interface NewestRequest {
  seq: number;
  total: number;
  /** Provider-reported prompt size, when the request carried usage. */
  prompt?: number;
}
/** One day in the activity ledger. */
interface LedgerDay {
  /** Billed tokens settled that day (input + cache read + cache write + output). */
  tokens: number;
  /** Completed model calls that day. */
  requests: number;
  /** Billed buckets per provider → model → period. Absent when only tokens are known. */
  cost?: CostLedger;
  /** Skill name → load count and last load time (epoch ms). */
  skills?: Record<string, {
    n: number;
    last: number;
  }>;
}
/** Per-session daily ledger, keyed by the host's local `YYYY-MM-DD` day. */
interface ActivityLedger {
  days: Record<string, LedgerDay>;
}
/** One available skill, as served by the skill-catalogue route. */
interface SkillEntry {
  name: string;
  description: string;
  path?: string;
  source?: string;
}
/** Display granularity for the request table. */
type Granularity = 'step' | 'turn';
/** Whether the cost curve is cumulative or per-step delta. */
type TrendMode = 'total' | 'delta';
/** Delta baseline: previous row, or last step of the previous turn. */
type DeltaBase = 'step' | 'turn';
/** File table ordering. */
type FileSort = 'count' | 'latest' | 'path';
/** Tool ranking ordering. */
type ToolSort = 'size' | 'count' | 'name';
/** Where the context surface is mounted. */
type Placement = 'all' | 'tab' | 'sidebar';
/** Whether the dock exposes the Insights entry. */
type InsightsEntry = 'show' | 'hide';
/** Whether the session time strip draws the duration curve. */
type DurationCurve = 'show' | 'hide';
/** User preferences persisted through the settings service (host config, volatile layer). */
interface Preferences {
  defaultPlacement: Placement;
  defaultGranularity: Granularity;
  defaultTrendMode: TrendMode;
  defaultDeltaBase: DeltaBase;
  defaultToolSort: ToolSort;
  defaultFileSort: FileSort;
  insightsEntry: InsightsEntry;
  defaultDurationCurve: DurationCurve;
}
/** The `contextTimeline` value. Collections (`requests`, `events`, `nodes`, `archive`) are
 * empty in the slim head generation and filled from `TimelineDetail`; `counts`, `last` and
 * `detailRev` only exist in that split generation. */
interface Snapshot {
  ok: boolean;
  /** Present only when the running harness is below the supported baseline: the host folds
   * nothing (all numbers zero) and the client shows an upgrade notice. */
  unsupported?: {
    current: string;
    minimum: string;
  };
  model?: string;
  provider?: string;
  contextWindow?: number;
  current: {
    system: number;
    tools: number;
    user: number;
    inject: number;
    skill: number;
    assistant: number;
    tool: number;
    total: number;
  };
  /** Image blocks in the live context (user uploads + tool results). */
  images?: number;
  /** Live tool results on the surface (skill-tool nodes count). */
  toolCalls?: number;
  /** Whole-session human inputs: non-injected user messages + answered questions. */
  humanInputs?: number;
  /** Whole-session replies: assistant messages carrying non-blank text. */
  answers?: number;
  /** Newest user message as a single-line preview (≤80 chars). */
  lastUser?: string;
  counts?: RetainedCounts;
  last?: NewestRequest;
  detailRev?: number;
  requests: RequestRow[];
  events: LedgerEvent[];
  cost?: CostLedger;
  calls?: CallLedger;
  turnCost?: TurnLedger;
  /** Per-request credit rates read from the platforms' own catalogues. Absent, never guessed. */
  creditRates?: {
    [provider: string]: {
      [model: string]: number;
    };
  };
  timing?: TimingTotals;
  systems?: SystemNode[];
  nodes: SurfaceEntry[];
  droppedNodes: number;
  archive: SurfaceEntry[];
  surfaceFloor?: number;
  archiveFloor?: number;
  fileOps?: FileOp[];
  fileOpsFloor?: number;
  spans?: TimingSegment[];
}
/** The heavy collections, fetched per viewing client by `POST /api/dsh-cost-breakdown/detail`. */
interface TimelineDetail {
  /** Mirrors the head's `detailRev`; the client's last-writer-wins cursor. */
  rev: number;
  /** Same-cut slim head, so a cold session's scalars are readable. */
  head?: Snapshot;
  requests: RequestRow[];
  events: LedgerEvent[];
  nodes: SurfaceEntry[];
  droppedNodes: number;
  archive: SurfaceEntry[];
  surfaceFloor?: number;
  archiveFloor?: number;
  fileOps?: FileOp[];
  fileOpsFloor?: number;
  spans?: TimingSegment[];
}
/** One executed file operation, folded from the durable tool lifecycle. Line counts are
 * estimates read from the call arguments. */
interface FileOp {
  seq: number;
  /** The touched file; for a path-less search, the searched pattern (`pattern: true`). */
  path: string;
  kind: 'read' | 'write' | 'search';
  tool: string;
  time?: number;
  err: boolean;
  added: number;
  removed: number;
  detail?: string;
  hits?: number;
  read?: {
    start: number;
    count: number;
  } | {
    count: number;
    est: true;
  };
  /** Nested Code-Mode op: the `run_code` result node it ran under. */
  parent?: number;
  /** Nested Code-Mode op: the model-written program description. */
  program?: string;
  pattern?: true;
}
/** One live (or archived) model-visible message on the surface. */
interface SurfaceEntry {
  seq: number;
  time?: number;
  cat: Stage;
  tokens: number;
  imgs?: number;
  /** Archive entries only: the seq of the replacement event that shadowed this node. */
  gone?: number;
  form?: string;
  /** Injection producer identity. */
  name?: string;
  text?: string;
  tool?: string;
  err?: boolean;
  skill?: string;
  calls?: string[];
}
/** One answered model call (a step); records sharing a `turn` form one turn run. */
interface RequestRow {
  turn?: number;
  step?: number;
  time: number;
  seq: number;
  system: number;
  tools: number;
  user: number;
  inject: number;
  assistant: number;
  tool: number;
  total: number;
  prompt?: number;
  skill?: number;
  /** Billed cache reads (hits) — the numerator of the hit rate; `prompt` is the denominator. */
  cacheRead?: number;
  output?: number;
  /** Active milliseconds of the step (start→end minus user waits), stamped at step end. */
  activeMs?: number;
  /** Client-set turn aggregation marker (the host never sets it). */
  stepCount?: number;
  /** Client-set signed net change in delta mode (the host never sets it). */
  net?: number;
}
/** One durable compaction/prune/inject/model/mode row rendered in the timeline. */
interface LedgerEvent {
  seq: number;
  time: number;
  kind: 'compaction' | 'prune' | 'inject' | 'model' | 'mode';
  form?: string;
  tokens?: number;
  count?: number;
  sub?: string;
  name?: string;
  detail?: string;
  from?: string;
  to?: string;
  /** Turn/step of the request recorded immediately before this event. */
  fromTurn?: number;
  fromStep?: number;
  /** Turn/step of the request this event belongs to. */
  turn?: number;
  step?: number;
}
/** One tool in a request-header epoch. */
interface HeaderedTool {
  name: string;
  tokens: number;
  /** `mcp:<server>`, the live attribution label, or the sentinel above. */
  plugin?: string;
}
/** Metadata of one request-header epoch (valid from `seq` until the next epoch). */
interface HeaderEpoch {
  seq: number;
  time: number;
  systemTokens?: number;
  tools: HeaderedTool[];
}
/** The `contextHeaders` value: a capped epoch list, newest last. */
interface HeaderTimeline {
  headers: HeaderEpoch[];
}
/** One currency's DeepSeek platform balance. */
interface BalanceEntry {
  currency: string;
  /** Derived from granted + toppedUp, so the two halves round together. */
  total: number;
  granted: number;
  toppedUp: number;
}
/** `POST /api/dsh-cost-breakdown/balance` value; `null` when unconfigured or unreadable. */
interface PlatformBalance {
  isAvailable: boolean;
  /** One entry per currency the account holds; at least one. */
  balances: BalanceEntry[];
}
/** Billed token buckets of one ledger period; provider-reported, never estimated. */
interface BucketTotals {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
/** One model's totals split by pricing period. Providers without period pricing book
 * everything under `peak` (the list-price bucket). */
interface ModelLedger {
  peak?: BucketTotals;
  off?: BucketTotals;
}
/** Session cost raw material: billed tokens indexed provider → model → period. */
interface CostLedger {
  [provider: string]: {
    [model: string]: ModelLedger;
  };
}
/** Session-level request counts per (provider, model) — the per-request billed platforms
 * (credits) need counts, not tokens. */
interface CallLedger {
  [provider: string]: {
    [model: string]: number;
  };
}
/** One turn's billing raw material, same shape as the session ledger so both go through one
 * pricing function and can never disagree. */
interface TurnEntry {
  usage: CostLedger;
  requests: {
    [provider: string]: {
      [model: string]: number;
    };
  };
}
/** Turn index (decimal string) → that turn's ledger. */
interface TurnLedger {
  [turn: string]: TurnEntry;
}
/** One segment of the session time strip. */
interface TimingSegment {
  kind: 'ttft' | 'reasoning' | 'text' | 'toolarg' | 'tools' | 'other';
  start: number;
  end: number;
}
/** Wall-clock totals of the whole session (milliseconds). */
interface TimingTotals {
  wallMs: number;
  ttftMs: number;
  genMs: number;
  reasoningMs?: number;
  reasoningBlocks?: number;
  textMs?: number;
  textBlocks?: number;
  toolArgMs?: number;
  toolArgBlocks?: number;
  speedTokens?: number;
  speedMs?: number;
  calls: number;
  toolsMs: number;
  toolCalls: number;
  tools: Record<string, {
    calls: number;
    ms: number;
  }>;
}
/** Which pricing period a request was billed in. */
type Period = 'peak' | 'off';
//#endregion
//#region src/host/settings.d.ts
/**
 * The shipped retention limits and the built-in holiday calendar. Every field may be overridden
 * per loader row, and the schema defaults are derived from this object so the two can never drift.
 */
declare const DEFAULT_BOUNDS: {
  maxRequestSteps: number;
  /** Newest whole-turn window. Trimming happens on turn boundaries, never mid-turn. */
  maxKeptTurns: number;
  maxEvents: number;
  /** Pathological-session backstop only: the whole node slice rides every push (~150 B/node). */
  maxNodes: number;
  maxArchiveNodes: number;
  maxFileOps: number;
  /** Chinese public holidays (Beijing dates) that bill off-peak all day. */
  holidays: string[];
};
/** Resolved retention limits, derived from {@link DEFAULT_BOUNDS} so the types agree. */
type FoldBounds = typeof DEFAULT_BOUNDS;
/**
 * Raw row configuration: any retention bound plus any display preference, all optional because
 * the schema fills the rest. Consumers never read fields directly — they call
 * {@link resolveBounds}, so a field added here cannot silently miss a default.
 */
export type Config = Partial<FoldBounds> & Partial<Preferences>;
/**
 * The row schema: retention bounds plus the volatile display preferences.
 *
 * Every enum union and the holiday array are `.loose()` on purpose. A persisted preference from
 * a newer build, or a hand-edited `cordis.patch.yml`, must degrade to the default instead of
 * failing the entry load — a failed load removes the whole plugin, not just the one field.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
  maxRequestSteps: z<number, number, "defined">;
  maxKeptTurns: z<number, number, "defined">;
  maxEvents: z<number, number, "defined">;
  maxNodes: z<number, number, "defined">;
  maxArchiveNodes: z<number, number, "defined">;
  maxFileOps: z<number, number, "defined">;
  holidays: z<string[], string[], "defined">;
  defaultPlacement: z<"all" | "sidebar" | "tab", "all" | "sidebar" | "tab", "defined">;
  defaultGranularity: z<"step" | "turn", "step" | "turn", "defined">;
  defaultTrendMode: z<"delta" | "total", "delta" | "total", "defined">;
  defaultDeltaBase: z<"step" | "turn", "step" | "turn", "defined">;
  defaultToolSort: z<"count" | "name" | "size", "count" | "name" | "size", "defined">;
  defaultFileSort: z<"count" | "latest" | "path", "count" | "latest" | "path", "defined">;
  insightsEntry: z<"hide" | "show", "hide" | "show", "defined">;
  defaultDurationCurve: z<"hide" | "show", "hide" | "show", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  maxRequestSteps: z<number, number, "defined">;
  maxKeptTurns: z<number, number, "defined">;
  maxEvents: z<number, number, "defined">;
  maxNodes: z<number, number, "defined">;
  maxArchiveNodes: z<number, number, "defined">;
  maxFileOps: z<number, number, "defined">;
  holidays: z<string[], string[], "defined">;
  defaultPlacement: z<"all" | "sidebar" | "tab", "all" | "sidebar" | "tab", "defined">;
  defaultGranularity: z<"step" | "turn", "step" | "turn", "defined">;
  defaultTrendMode: z<"delta" | "total", "delta" | "total", "defined">;
  defaultDeltaBase: z<"step" | "turn", "step" | "turn", "defined">;
  defaultToolSort: z<"count" | "name" | "size", "count" | "name" | "size", "defined">;
  defaultFileSort: z<"count" | "latest" | "path", "count" | "latest" | "path", "defined">;
  insightsEntry: z<"hide" | "show", "hide" | "show", "defined">;
  defaultDurationCurve: z<"hide" | "show", "hide" | "show", "defined">;
}>>, "plain">;
//#endregion
//#region src/host/plugin.d.ts
/** Plugin name (equals the package name): used for logs and for attribution self-exclusion. The
 * settings namespace does NOT come from it — it comes from the loader row id `cost-breakdown`. */
export declare const name = "dsh-cost-breakdown";
/** Hard dependency: without the registry Cordis keeps this plugin pending. */
export declare const inject: string[];
/**
 * Assemble the plugin.
 *
 * Order rationale:
 * 1. Balance, credits and skills are armed **before** the baseline gate, because they rely only
 *    on interfaces verified at runtime and must keep working on every harness that can load the
 *    plugin at all — including the ones the gate sends down the degraded path.
 * 2. The version probe decides between the degraded trio and the real fold. An unknown version
 *    fails open: only a *proven* older harness is degraded.
 * 3. Attribution and the step-identity guard are installed before the units register, since the
 *    headers unit captures the attribution resolve function at construction.
 * 4. The cold-read gate is created once and shared by the detail route's cold arm and the
 *    prewarm sweep.
 * 5. The detail channel is armed before the timeline unit registers, because the unit's view
 *    re-reads the channel gate on every serve to pick the wire generation.
 */
export declare function apply(ctx: Context, config: Config): void;
//#endregion
export type { ActivityLedger, BalanceEntry, BucketTotals, CallLedger, CostLedger, FileOp, FoldBounds, HeaderEpoch, HeaderTimeline, HeaderedTool, LedgerDay, LedgerEvent, Period, PlatformBalance, Preferences, RequestRow, SkillEntry, Snapshot, SurfaceEntry, SystemNode, TimelineDetail, TimingSegment, TimingTotals, TurnEntry, TurnLedger };