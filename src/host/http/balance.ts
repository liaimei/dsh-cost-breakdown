/// <reference types="node" />
/**
 * `POST /api/dsh-cost-breakdown/balance` — the DeepSeek platform balance row.
 *
 * Two routes are tried in order, account login first (it needs no key and is the account that is
 * actually billed) and the API-key provider second. A failure of either is a typed `null`, never
 * a thrown error and never a stale number: the client distinguishes "nothing to show" from
 * "transport failed" by `value === null`.
 *
 * The route is armed lazily on `connection`, so load order is irrelevant and a harness without
 * the fetch registry simply never gets the route.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PlatformBalance } from '../../wire/model'
import { readAccountBalance, readApiKeyBalance, resolveDeepSeekFacts } from '../platform/account'
import { type ConnectionFace, registerPostRoute, replyValue, routePath } from './router'

/** The balance route, inside the authenticated `/api` fence. */
export const BALANCE_ROUTE = routePath('balance')

/**
 * Resolve the balance: the account login first, the API key second.
 *
 * @returns the latest readable balance, or `null` when neither route can answer.
 */
export async function readPlatformBalance(ctx: Context): Promise<PlatformBalance | null> {
  const account = await readAccountBalance(ctx)
  if (account !== null) return account
  const facts = await resolveDeepSeekFacts(ctx)
  return facts !== null ? readApiKeyBalance(facts) : null
}

/** Arm the balance route as soon as `connection` is provided. */
export function watchBalanceChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (): Promise<Response> => replyValue(await readPlatformBalance(ctx))
    registerPostRoute(
      c,
      c.get('connection') as ConnectionFace | undefined,
      BALANCE_ROUTE,
      handler,
      'dsh-cost-breakdown: balance route',
    )
  })
}
