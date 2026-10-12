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
import type { ContextTimeline, TurnCostEntry } from '../../shared/types'
import { useModelPrices } from '../modelPrices'
import { formatCost, toCurrency, type CostCurrency } from '../cost'
import type { ThirdPartyRates } from '../../shared/thirdPartyRates'
import type { CreditRates, TurnSpend } from '../turnSpend'
import { fmtCredits, turnSpendOf } from '../turnSpend'
import type { ViewKit } from '../viewkit'

/** 该槽位的 props；messageId 是不可信输入。 */
export interface TurnSpendProps extends SessionStandardProps {
  messageId?: unknown
}

/** 按 messageId 找出那条回复所属的 turn。
 *
 *  turn 号就在聊天节点**顶层**的 `turn` 字段上（官方 `finalNode` 构造节点时写的是
 *  `{ kind: "assistant", seq, messageId, turn, step, ... }`）。此前我读的是
 *  `node.location.turn.turn`——那是**渲染层**的位置对象，`useChat` 给出的 legacy 切片里
 *  根本没有 `location`，所以恒为 undefined，读数永远不显示。
 *
 *  节点属于不可信输入：既可能缺字段，也可能是恶意对象，因此逐层自证后再借用。 */
function turnOfMessageId(nodes: readonly ConversationNodeLike[] | undefined, messageId: string): number | null {
  for (const node of nodes ?? []) {
    try {
      if (node.kind !== 'assistant' || node.messageId !== messageId) continue
      const turn = (node as { turn?: unknown }).turn
      if (typeof turn === 'number' && Number.isFinite(turn)) return turn
      // 兼容：某些形态把轮次放在 location 上（`location.turn.turn`）。
      const location = (node as { location?: unknown }).location
      if (location === null || typeof location !== 'object') return null
      const loc = location as { kind?: unknown; turn?: unknown }
      if (loc.kind !== 'turn' && loc.kind !== 'step') return null
      const nested = loc.turn !== null && typeof loc.turn === 'object'
        ? (loc.turn as { turn?: unknown }).turn
        : undefined
      return typeof nested === 'number' && Number.isFinite(nested) ? nested : null
    } catch { continue }
  }
  return null
}

/** 悬停说明：这一轮按什么算的。用户看得出数字的来源，也看得出它是估算。 */
function tipOf(spend: TurnSpend, t: ViewKit['t']): string {
  return spend.unit === 'credits' ? t('turnSpend.creditsTip') : t('turnSpend.moneyTip')
}

/** 绑定 `kit` 与「当前显示货币」的读取器，返回这个每轮读数。
 *
 *  `rates` 与 `credits` 由注册处传入（见 client/index.ts）：前者是用户声明的每百万
 *  token 费率，后者是按次积分费率。它们必须是**运行时可变的读取器**而不是值——
 *  设置在会话中途可改，传值会把第一帧的快照永久冻住。 */
export function makeTurnSpend(
  kit: ViewKit,
  currency: () => CostCurrency,
  rates: () => ThirdPartyRates | null,
  credits: () => CreditRates | null,
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
    const turn = turnOfMessageId(conversationNodesOf(props), messageId)
    if (turn === null) return null
    const entry: TurnCostEntry | undefined = timeline?.turnCost?.[String(turn)]
    // 积分费率优先取**平台自己声明的**那份（host 读平台目录后随投影下发）；
    // 用户在设置里声明的表作为覆盖——用户知道自己的套餐，插件不知道。
    const spend = turnSpendOf(entry, book, rates(), credits() ?? timeline?.creditRates ?? null)
    if (spend === null) return null
    // 金额必须走 `formatCost`：`fmt` 是 token 计数的格式（千以下取整），
    // 用它会把不到五分的单轮金额显示成 `0`——这正是此前实际渲染出的内容。
    // 货币符号由 `formatCost` 给出，字典因此只放一个纯数字占位。
    const text = spend.unit === 'credits'
      ? t('turnSpend.credits', { n: fmtCredits(spend.value) })
      : formatCost(toCurrency(spend.value, currency()), currency())
    return (
      <Tooltip label={tipOf(spend, t)} side="bottom">
        <span className="lc-turn-spend" data-unit={spend.unit}>{text}</span>
      </Tooltip>
    )
  }
}
