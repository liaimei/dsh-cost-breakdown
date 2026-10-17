/**
 * Host-half entry point.
 *
 * `package.json#main` and the loader row both point at `lib/index.js`, and that artifact is built
 * from this file — so this module exists purely to keep the package's shape frozen. The frozen
 * `main` path must not move just because the implementation was restructured into `./plugin`.
 */

export { name, inject, Config, apply } from './plugin'
export type {
  ActivityLedger, BalanceEntry, BucketTotals, CallLedger, CostLedger, FileOp, HeaderEpoch,
  HeaderTimeline, HeaderedTool, LedgerDay, LedgerEvent, Period, PlatformBalance, Preferences,
  RequestRow, SkillEntry, Snapshot, SurfaceEntry, SystemNode, TimelineDetail, TimingSegment,
  TimingTotals, TurnEntry, TurnLedger,
} from '../wire/model'
export type { FoldBounds } from './settings'
