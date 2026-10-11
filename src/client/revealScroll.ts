/** 滚动某个元素最近的有效可滚动祖先，使该元素顶到该滚动视口顶部。
 * 与宿主无关：对话标签页滚动的是一个共享容器，而右侧 Sidebar 的滚动容器
 * 随 shell 布局而异。没有祖先可滚动或链路变得不可信时返回 false，绝不抛错。 */

/** 已就位后即幂等且无副作用，调用方因此可以在一次布局
 *  之后重试，而不必担心滚动抖动。 */
export function revealInScrollParent(anchor: Element): boolean {
  try {
    // 到 `document.body` 即止：body 自身的滚动属于页面而非祖先，
    // 动它会滚动调用方并不拥有的外层界面。
    for (let el = anchor.parentElement; el !== null && el !== document.body; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY
      // 要的是**有效**滚动容器，而不只是写了 overflow 样式的盒子：随内容
      // 增长的盒子（外层容器滚动时 Context 标签页自己的 `.lc-root`）报告 auto 却从不移动。
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
        return true
      }
    }
  } catch { /* 定位退化为不作为 */ }
  return false
}
