/**
 * The per-turn spend pill, mounted beside the harness's own "N tok" pill on the reply tail.
 *
 * It reports what **this turn** cost, not what the session has cost so far: the turn ledger is written by
 * the same settlement that writes the session ledger, so the two can never disagree, and attributing by
 * subtraction (cumulative now minus cumulative before) would be wrong for interleaved requests.
 *
 * Money or credits, never both: a credit-billed turn prints the credit count, because adding credits to a
 * currency produces a number that means nothing.
 */

import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { ContextSeatProps, ConversationNode } from '../shell/contracts'
import { conversationNodesOf } from '../shell/contracts'
import type { Translate } from '../i18n/dict'
import type { Currency } from '../data/cost'
import { estimateByBucket, formatCost, formatCredits } from '../data/cost'
import { creditRateOf } from '../../core/credits'
import type { CreditRateTable, Snapshot, TurnEntry } from '../../wire/model'
import { snapshotOf } from '../shell/washers'
import { moneyRates } from '../shell/rateTables'
import { usePriceBook } from './insights/priceBook'

/** The pill's props: the seat plus the translator and locale reader. */
export interface TurnSpendProps extends ContextSeatProps {
  t: Translate
  locale?: () => string
}

/** The pill. Renders nothing when the turn cannot be identified or billed. */
export function TurnSpend(props: TurnSpendProps): ReactElement | null {
  const { t } = props
  const snapshot = typeof props.useProjection === 'function' ? snapshotOf(props.useProjection('contextTimeline')) : null
  const nodes = conversationNodesOf(props)
  const book = usePriceBook()
  if (snapshot === null) return null
  const turn = turnOf(nodes)
  if (turn === null) return null
  const entry = snapshot.turnCost?.[String(turn)]
  if (entry === undefined) return null
  const credits = snapshot.creditRates ?? null
  const locale = props.locale?.() ?? 'en'
  const currency: Currency = locale === 'zh' ? 'cny' : 'usd'
  const amount = amountOf(entry, snapshot, credits, book, currency)
  if (amount === null) return null
  return h('span', {
    className: 'cb-turn-spend',
    title: amount.credits ? t('turnSpend.creditsTip') : t('turnSpend.moneyTip'),
  }, amount.credits
    ? t('turnSpend.credits', { n: formatCredits(amount.value) })
    : formatCost(amount.value, currency))
}

/** The turn a chat node belongs to. The harness records the turn on legacy nodes when it has one; a node
 * without it cannot be attributed, and the pill stays silent rather than guessing. */
function turnOf(nodes: readonly ConversationNode[] | undefined): number | null {
  const node = nodes?.at(-1) as (ConversationNode & { turn?: unknown }) | undefined
  if (node === undefined) return null
  const turn = node.turn
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : null
}

/** What one turn cost, in money or credits. */
function amountOf(
  entry: TurnEntry,
  snapshot: Snapshot,
  credits: CreditRateTable | null,
  book: ReturnType<typeof usePriceBook>,
  currency: Currency,
): { value: number; credits: boolean } | null {
  // A credit-billed turn reports credits: relative consumption, because the platform documents its
  // multiplier as display-only.
  if (credits !== null) {
    let total = 0
    let any = false
    for (const [provider, models] of Object.entries(entry.requests)) {
      for (const [model, calls] of Object.entries(models)) {
        const rate = creditRateOf(credits, provider, model)
        if (rate === null) continue
        total += rate * (typeof calls === 'number' ? calls : 0)
        any = true
      }
    }
    if (any) return { value: total, credits: true }
  }
  const priced = estimateByBucket(entry.usage, book, moneyRates())
  if (!priced.any) return null
  return { value: priced.total, credits: false }
}

/** Re-exported so the entry's registration and the pill agree on the action id. */
export const TURN_SPEND_ID = 'turn-spend'
