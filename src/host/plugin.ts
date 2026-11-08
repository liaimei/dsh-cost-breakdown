/**
 * `dsh-cost-breakdown` — the host half's Cordis entry point.
 *
 * A plain Cordis ESM plugin module, loaded by the harness as the `dsh-cost-breakdown` loader row.
 * It contributes three client-visible session-projection units (`contextTimeline`,
 * `contextHeaders`, `contextActivity`) that fold the durable `session/event` log into JSON the
 * harness caches, streams and baselines; plus the five `/api` routes, the balance/credits/skills
 * readers, a tool-attribution hook and the step-identity guard.
 *
 * The session-projection registry is a hard dependency: without it Cordis keeps this plugin
 * PENDING forever, and every registration is an effect whose disposer rides this fiber.
 *
 * **Assembly order is load-bearing** (see the numbered notes inside {@link apply}), because the
 * projection units capture collaborators at construction time and the baseline gate can return
 * before anything below it exists.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: brings the registry's context/module augmentation into this compilation unit.
import type {} from '@deepseek-ai/dsh-session-projection'
import { meetsBaseline } from '../core/version'
import { watchActivityBackfill } from './http/backfill'
import { watchBalanceChannel } from './http/balance'
import { makeColdReadGate } from './http/cold'
import { watchCreditsChannel } from './http/credits'
import { watchPlanQuotaChannel } from './http/planQuota'
import { watchRelayPricesChannel } from './http/relayPrices'
import { watchDetailChannel } from './http/detail'
import { watchSkillsChannel } from './http/skills'
import { createToolAttribution } from './platform/attribution'
import { probeHarnessRelease } from './platform/harness'
import { watchInboxIdentity } from './platform/step-ids'
import { createActivityUnit } from './projections/activity'
import {
  createDegradedActivity,
  createDegradedHeaders,
  createDegradedTimeline,
} from './projections/degraded'
import { createHeadersUnit } from './projections/headers'
import { createTimelineUnit } from './projections/timeline'
import { Config, resolveBounds } from './settings'

/** Plugin name (equals the package name): used for logs and for attribution self-exclusion. The
 * settings namespace does NOT come from it — it comes from the loader row id `cost-breakdown`. */
export const name = 'dsh-cost-breakdown'

/** Hard dependency: without the registry Cordis keeps this plugin pending. */
export const inject = ['sessionProjections']

/** Re-exported as both a value (the cordis Standard-Schema validator) and a type (the config
 * shape Cordis hands to {@link apply} after validation). */
export { Config }

/**
 * The slice of the projection registry this entry uses.
 *
 * Narrowed by hand (rather than through the harness's merge-extensible projection maps) so that a
 * missing or renamed map augmentation cannot turn this one file into a compile error for every
 * consumer; the definitions still land in the real registry unchanged.
 */
interface ProjectionHostFace {
  register(definition: unknown): (() => void) | void
}

/** Register one projection unit on the plugin's fiber. */
function registerUnit(ctx: Context, definition: unknown): void {
  const projections = ctx.sessionProjections as unknown as ProjectionHostFace | undefined
  projections?.register(definition)
}

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
export function apply(ctx: Context, config: Config): void {
  // 1. Always-on channels: read-only runtime interfaces, valid on both sides of the gate.
  watchBalanceChannel(ctx)
  watchCreditsChannel(ctx)
  watchPlanQuotaChannel(ctx)
  watchRelayPricesChannel(ctx)
  watchSkillsChannel(ctx)

  // 2. Baseline gate. A below-baseline harness never gets the real fold (its log dialect and seam
  // interfaces are outside the compatibility matrix); the degraded units serve all-zero payloads
  // plus the gate record the client renders as an upgrade notice.
  const release = probeHarnessRelease(ctx)
  if (release !== undefined && !meetsBaseline(release)) {
    registerUnit(ctx, createDegradedTimeline(release))
    registerUnit(ctx, createDegradedHeaders())
    registerUnit(ctx, createDegradedActivity())
    return
  }

  // 3. Attribution layers live capture on top of the pinned first-party map; the identity guard
  // protects the persistence boundary.
  const attribution = createToolAttribution(ctx)
  watchInboxIdentity(ctx)

  // 4. One gate for both cold-read paths.
  const coldReads = makeColdReadGate()

  // Bounds are resolved once and captured: a remote config edit takes effect when the loader row
  // remounts, and volatile preference fields never reach fold data.
  const bounds = resolveBounds(config)

  // 5. The detail channel returns the liveness marker the timeline unit's view reads per serve.
  const channel = watchDetailChannel(ctx, bounds, coldReads)
  registerUnit(ctx, createTimelineUnit(config, () => channel.live))
  registerUnit(ctx, createHeadersUnit((toolName: string) => attribution.ownerOf(toolName)))
  registerUnit(ctx, createActivityUnit(bounds.holidays))

  // 6. The prewarm is triggered by the Insights page, never at startup.
  watchActivityBackfill(ctx, coldReads)
}

/**
 * Installation-time type surface: consumers import these wire names from the package entry rather
 * than reaching into the modules that declare them.
 */
export type {
  ActivityLedger,
  BalanceEntry,
  BucketTotals,
  CallLedger,
  CostLedger,
  CreditRateTable,
  FileOp,
  HeaderedTool,
  HeaderEpoch,
  HeaderTimeline,
  LedgerDay,
  LedgerEvent,
  Period,
  PlatformBalance,
  PlanQuota,
  PlanQuotaTable,
  PlanQuotaWindow,
  Preferences,
  RelayPrice,
  RelayPriceTable,
  RequestRow,
  SkillEntry,
  Snapshot,
  SurfaceEntry,
  SystemNode,
  TimelineDetail,
  TimingSegment,
  TimingTotals,
  TurnEntry,
  TurnLedger,
} from '../wire/model'
export type { FoldBounds } from './settings'
