/** Chat → Context 跳转中转站：assistant 消息上的操作记录所点回复的请求 seq 并打开
 * Context 视图——能提供服务时是右侧 Sidebar 的标签页，否则是对话标签页——该视图
 * 在投影数据到位后消费这**一次性**焦点。 */

import { asRecord, type ClientCtx } from './services'
import { SIDEBAR_CONTEXT_KIND } from './sidebar'

// 每个 session 一个待处理的 seq，刻意不在这里消费：目标视图会在其
// 投影数据到位时取走它，在那之前记录一直保持待处理才是正确的。
const pendingFocus = new Map<string, number>()

const focusListeners = new Set<() => void>()

/** 记录 `sessionId` 对应的回复请求 seq，并唤醒每个已订阅的视图。 */
export function requestContextFocus(sessionId: string, seq: number): void {
  pendingFocus.set(sessionId, seq)
  for (const listener of focusListeners) listener()
}

/** 每次记录都唤醒所有已订阅视图；监听者只取**自己** session 的条目，
 * 其他 session 的记录继续为各自的视图保持待处理。 */
export function subscribeContextFocus(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => { focusListeners.delete(listener) }
}

/** 视图在数据到位后执行的一次性消费；本 session 没有待处理焦点时为 null，
 *  这也正是过期的跳转不会在之后每次渲染时都被触发的原因。 */
export function takeContextFocus(sessionId: string): number | null {
  const seq = pendingFocus.get(sessionId)
  if (seq === undefined) return null
  pendingFocus.delete(sessionId)
  return seq
}

/** 经由 `ctx.sidebarRight.openTab` 打开 Context 标签页（同一时刻该列会展开）。可选的接缝，
 * 调用时重新校验：服务被裁剪、未注册该标签类型或面孔不可信，都返回 false，
 * 调用方因此保留其「回退到对话标签页」的行为。 */
export function openContextSidebar(ctx: ClientCtx): boolean {
  try {
    const face = asRecord(ctx.get('sidebarRight'))
    if (face === null || typeof face.openTab !== 'function') return false
    // 通过 `.call(face, …)` 调用：该面孔是类实例，其 `openTab` 需要
    // 正确的 `this`，而从未知代理上取下的方法绝不能裸调。
    ;(face.openTab as (kind: string) => void).call(face, SIDEBAR_CONTEXT_KIND)
    return true
  } catch {
    return false
  }
}

/** 通过点击 Context 标签页自己的 `button[role="tab"]` 外观来激活它：harness 只把
 * `openView` 交给**当前激活**的视图条目，因此嵌套的聊天操作调不到它；找不到标签页即报告失败。 */
export function activateContextTab(label: string): boolean {
  const tabs = document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')
  for (const tab of tabs) {
    if (tab.textContent.trim() !== label) continue
    if (tab.getAttribute('aria-selected') !== 'true') tab.click()
    return true
  }
  return false
}
