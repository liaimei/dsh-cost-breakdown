/** 每一轮回复后面的消费读数，注册在 harness 的 `conversation.chat.assistant-actions`
 *  槽位上——与官方的「用量 N tok」胶囊同一行。
 *
 *  它读的是 host 折出的**每轮**账本（`contextTimeline.turnCost`）：按 (provider, model)
 *  归因到这一轮自己的请求上。因此「按平台动态显示」是数据决定的，不是猜的：
 *  积分制平台显示积分，按 token 计价的平台显示金额并区分峰谷。
 *
 *  turn 号不是槽位 props 给的：先从 `useChat` 的节点里按 messageId 找到那条回复的 seq，
 *  再在 host 的请求记录里找 seq 不超过它的最后一条，那条的 `turn` 就是本轮。
 *  任何一步解析不出来就不渲染——宁可没有读数，也不把别人的轮次算到这一条上。 */

import { type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationNodeLike, SessionStandardProps } from '../services'
import { conversationNodesOf } from '../services'
import type { ContextTimeline, RequestRecord, TurnCostEntry } from '../../shared/types'
import { useModelPrices } from '../modelPrices'
import { toCurrency, type CostCurrency } from '../cost'
import { fmt } from '../format'
import type { TurnSpend } from '../turnSpend'
import { turnSpendOf } from '../turnSpend'
import type { ViewKit } from '../viewkit'

/** 该槽位的 props；messageId 是不可信输入。 */
export interface TurnSpendProps extends SessionStandardProps {
  messageId?: unknown
}

/** 按 messageId 找那条回复的 seq；节点属于不可信输入，逐个隔离。 */
function seqOfMessageId(nodes: readonly ConversationNodeLike[] | undefined, messageId: string): number | null {
  for (const node of nodes ?? []) {
    try {
      if (node.kind !== 'assistant' || node.messageId !== messageId) continue
      return typeof node.seq === 'number' && Number.isFinite(node.seq) ? node.seq : null
    } catch { continue }
  }
  return null
}

/** 回复的 seq → 本轮 turn：取 seq 不超过它的最后一条请求。
 *  一个 turn 里可能有多个 step，取最后一条即落在本轮内。 */
function turnOfSeq(requests: readonly RequestRecord[], seq: number): number | null {
  let best: number | null = null
  let bestSeq = Number.NEGATIVE_INFINITY
  for (const req of requests) {
    if (typeof req.turn !== 'number' || !Number.isFinite(req.turn)) continue
    if (req.seq > seq || req.seq <= bestSeq) continue
    bestSeq = req.seq
    best = req.turn
  }
  return best
}

/** 积分按平台习惯去尾零：小于 1 保留三位，否则两位。 */
function fmtCredits(value: number): string {
  if (value === 0) return '0'
  const digits = Math.abs(value) < 1 ? 3 : 2
  return value.toFixed(digits).replace(/\.?0+$/, '')
}

/** 悬停说明：这一轮按什么算的。用户看得出数字的来源，也看得出它是估算。 */
function tipOf(spend: TurnSpend, t: ViewKit['t']): string {
  return spend.unit === 'credits' ? t('turnSpend.creditsTip') : t('turnSpend.moneyTip')
}

/** 绑定 `kit` 与「当前显示货币」的读取器，返回这个每轮读数。 */
export function makeTurnSpend(
  kit: ViewKit,
  currency: () => CostCurrency,
): (props: TurnSpendProps) => ReactElement | null {
  const { t } = kit
  return function TurnSpendView(props: TurnSpendProps): ReactElement | null {
    // 无条件调用 hook，下面的提前 return 才能保住 hook 顺序。
    const { book } = useModelPrices()
    const timeline = typeof props.useProjection === 'function'
      ? props.useProjection('contextTimeline') as ContextTimeline | null
      : null
    const messageId = props.messageId
    if (typeof messageId !== 'string' || messageId === '') return null
    const seq = seqOfMessageId(conversationNodesOf(props), messageId)
    if (seq === null) return null
    const turn = turnOfSeq(timeline?.requests ?? [], seq)
    if (turn === null) return null
    const entry: TurnCostEntry | undefined = timeline?.turnCost?.[String(turn)]
    const spend = turnSpendOf(entry, book, null, null)
    if (spend === null) return null
    const text = spend.unit === 'credits'
      ? t('turnSpend.credits', { n: fmtCredits(spend.value) })
      : t('turnSpend.money', { n: fmt(toCurrency(spend.value, currency())) })
    return (
      <Tooltip label={tipOf(spend, t)} side="bottom">
        <span className="lc-turn-spend" data-unit={spend.unit}>{text}</span>
      </Tooltip>
    )
  }
}
