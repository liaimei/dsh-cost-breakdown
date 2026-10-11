/** 打开 Context 视图并定位到这条回复所在轮次的助手消息操作，注册在 harness 的
 * `conversation.chat.assistant-actions` 槽位上。匹配的助手节点的 seq 是在**渲染期**从 `useChat`
 * 节点槽位读出来的：那个槽位是真正的 React hook，若等到点击时再读会触发 dispatcher 保护，跳转便会
 * 丢掉定位。seq 解析不出来时仍然打开视图，只是不带定位；message id 不是字符串则什么都不渲染。 */

import { type ReactElement } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientCtx, ConversationNodeLike, UseChatLike } from '../services'
import { conversationNodesOf } from '../services'
import { activateContextTab, openContextSidebar, requestContextFocus } from '../viewFocus'
import type { ViewKit } from '../viewkit'

/** 该槽位的 props；`useChat` 本身就是带 hook 的槽位，必须在渲染期调用。
 *  两个 id 都是 `unknown`，因为槽位的载荷不可信。 */
export interface ContextJumpProps {
  messageId?: unknown
  sessionId?: unknown
  useChat?: UseChatLike
}

/** 节点属于不可信输入：每个元素都被单独隔离，所以某个一取属性就抛异常的恶意对象会被跳过。 */
function seqOfMessageId(nodes: readonly ConversationNodeLike[] | undefined, messageId: string): number | null {
  for (const node of nodes ?? []) {
    try {
      if (node.kind !== 'assistant' || node.messageId !== messageId) continue
      return typeof node.seq === 'number' && Number.isFinite(node.seq) ? node.seq : null
    } catch {
      continue
    }
  }
  return null
}

/** 与已发布的各行图标同属 16px 线性图标家族。 */
function JumpIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="fill-none" aria-hidden="true">
      <rect x="2" y="3" width="12" height="2" rx="1" className="fill-current" />
      <rect x="2" y="7" width="8.5" height="2" rx="1" className="fill-current" />
      <rect x="2" y="11" width="5.5" height="2" rx="1" className="fill-current" />
    </svg>
  )
}

/** 绑定 `ctx`（用于激活侧边栏）与 `kit`，返回这个助手操作按钮。message id 缺失时渲染 null
 *  而不是一个点不动的控件；节点 seq 解析不出来时仍然打开 Context 视图，
 *  只是没有定位。 */
export function makeContextJumpButton(ctx: ClientCtx, kit: ViewKit): (props: ContextJumpProps) => ReactElement | null {
  const { t } = kit
  return function ContextJump(props: ContextJumpProps): ReactElement | null {
    // 先无条件读出来，下面那个提前 return 才能保住 hook 顺序。
    const nodes = conversationNodesOf(props)
    const messageId = props.messageId
    if (typeof messageId !== 'string' || messageId === '') return null
    const seq = seqOfMessageId(nodes, messageId)
    const jump = (): void => {
      const sessionId = props.sessionId
      if (seq !== null && typeof sessionId === 'string' && sessionId !== '') {
        requestContextFocus(sessionId, seq)
      }
      // 侧边栏会展开在对话之上，让被点击的那条回复留在视野里；没有这个标签页时就只是单纯激活。
      if (!openContextSidebar(ctx)) activateContextTab(t('tab'))
    }
    return (
      <Tooltip label={t('jump.title')} side="bottom">
        <button type="button" className="lc-jump hover:bg-(--dsw-alias-interactive-bg-hover) hover:text-(--dsw-alias-label-secondary)" aria-label={t('jump.title')} onClick={jump}>
          <JumpIcon />
        </button>
      </Tooltip>
    )
  }
}
