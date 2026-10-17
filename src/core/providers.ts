/**
 * Provider seams: the harness's route ids versus the public price registry's vendor ids, and the
 * one decision that decides whether a settlement gets split into peak/off-peak buckets.
 */

import { findOfficialModel } from './clock'

/** Harness route id → public registry vendor id. Unmapped ids pass through unchanged, so a new
 * route is priced under its own name instead of being dropped. */
const VENDOR_BY_ROUTE: Record<string, string> = {
  // Both native DeepSeek routes share one vendor and one period-priced table; `deepseek-account`
  // must resolve too, or the fold cannot split its settlements.
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
  'kimi-coding': 'moonshotai',
  'minimax-cn': 'minimax',
  'zai-coding-cn': 'zhipuai',
}

/** The registry vendor behind a harness route id. */
export function vendorOf(route: string): string {
  return VENDOR_BY_ROUTE[route] ?? route
}

/** Whether a route bills on DeepSeek's own table and period windows. */
export function isDeepSeekRoute(route: string): boolean {
  return vendorOf(route) === 'deepseek'
}

/**
 * Whether a settlement must be split by the Beijing peak/off-peak windows.
 *
 * Decided by **model**, not by route. The official table applies to the models it lists no
 * matter which route carried the request — a proxied DeepSeek model (a reseller or mirror) is
 * still billed by the official windows. Keying this on the route would book every proxied call
 * into the peak bucket without the peak multiplier, which both mis-dates the split and
 * undercharges the peak period by half. Models the table does not list stay in the peak bucket:
 * the split exists for DeepSeek's windows and must not be invented for other vendors.
 */
export function pricedByPeriod(route: string, model: string | undefined): boolean {
  return isDeepSeekRoute(route) || findOfficialModel(model) !== null
}
