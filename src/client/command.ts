/** `/context` 作为插件自己的 '/' 触发源运行，而不是 host 命令：不派发任何东西、
 * 不写任何 session 日志记录、不产生任何模型可见内容。两条路径都回答 `'handled'`、
 * 打开模态框，并把 token 留给关闭路径。 */

import { ContextIcon } from './icon'
import { modalStoreOf, setPendingConsume } from './modalStore'
import type { ClientCtx, InputTriggersFace } from './services'
import type { ViewKit } from './viewkit'

const COMMAND = 'context'
const LINE = '/' + COMMAND

/** `kit` 提供菜单文案；模态框本身经由 `modalStoreOf` 打开，
 *  因此该命令从不触碰 host。每个 fiber 注册一次，并掌管自己的清理函数。 */
export function registerContextCommand(ctx: ClientCtx, kit: ViewKit): void {
  // 等待**服务**而不是模块到达顺序：dsh 用更细的模块组装客户端，
  // `inputTriggers` 可能尚未提供；没有它的 harness 永远不会触发该回调。
  ctx.inject(['inputTriggers'], (ictx) => {
    const inputTriggers = (ictx as ClientCtx).get('inputTriggers') as InputTriggersFace | undefined
    if (inputTriggers === undefined || typeof inputTriggers.registerSource !== 'function') return
    ictx.effect(() => inputTriggers.registerSource({
      trigger: '/',
      name: COMMAND,
      order: 1,
      candidates: (_session, req) => {
        // 该触发源只对**位于输入开头**的 token 发声；否则 `/context`
        // 会在句子中间被当作斜杠命令推荐出来。
        if (req.position !== 'leading') return Promise.resolve([])
        // 查询为空即裸 `/`——全部推荐；否则按前缀匹配 `context`。
        const query = req.query.trim().toLowerCase()
        if (query !== '' && !COMMAND.startsWith(query)) return Promise.resolve([])
        // 带分组的候选项会替换菜单的来源标题行，否则那一行会渲染
        // 原始来源名（`context` 并不是 harness 的 `slash.menu` 中的键）。
        return Promise.resolve([{
          name: COMMAND,
          label: kit.t('cmd.label'),
          icon: ContextIcon,
          section: kit.t('cmd.section'),
          description: kit.t('cmd.desc'),
        }])
      },
      onPick: (pick) => {
        // span 守卫在 store 翻转**之前**就已暂存：遮罩层的首帧
        // 会读取它，若通知先于它发生则什么都消费不到。
        setPendingConsume(pick.session.sessionId, { kind: 'span', span: pick.span })
        modalStoreOf(pick.session.sessionId).set(true)
        return 'handled'
      },
      matchEnter: (session, line) => {
        // 只做精确匹配：`/contextual` 不是本命令，返回 undefined
        // 可让输入外壳把该行当作普通 prompt 派发。
        if (line !== LINE) return Promise.resolve(undefined)
        setPendingConsume(session.sessionId, { kind: 'bare-token', token: LINE })
        modalStoreOf(session.sessionId).set(true)
        return Promise.resolve<'handled'>('handled')
      },
    }), 'dsh-cost-breakdown: /context command')
  })
}
