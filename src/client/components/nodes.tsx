/** 上下文浏览器的「节点转文本」映射：每个 `SurfaceNode` 出一行，
 *  优先用它携带的最具体的事实，而不是退回它的类别。 */

import type { SurfaceNode } from '../../shared/types'
import type { ViewKit } from '../viewkit'

/**
 * 绑定一次翻译器，返回逐节点的取文案函数。分支顺序是有承载作用的：
 * 一个节点可能同时带名字和正文，而 `skill` / `calls` 的优先级高于
 * `text`，所以一次工具调用的行显示的是它的调用清单，
 *而不是模型的前言。 */
export function makeNodeText(kit: ViewKit): (n: SurfaceNode) => string {
  const { t } = kit
  return function nodeText(n: SurfaceNode): string {
    if (n.cat === 'tool') {
      return t('node.toolResult') + (n.tool ? ' ← ' + n.tool : '') + (n.err ? ' ⚠' : '')
    }
    if (n.skill) return 'Skill: ' + n.skill
    if (n.calls) return t('node.calls') + n.calls.join(', ')
    if (n.text) return n.form === 'snapshot' ? t('node.snapshot') + n.text : n.text
    if (n.cat === 'assistant') return t('node.empty')
    if (n.cat === 'inject' || n.cat === 'skill') return t('form.' + (n.form || 'context'))
    return t('node.nonText')
  }
}
