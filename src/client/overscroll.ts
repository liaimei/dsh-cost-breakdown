/** 阻止水平滚动容器的过滚动触发浏览器历史导航（触控板
 * 左右滑动前进/后退）。`overscroll-behavior-x: contain` 对 Chromium 与 Firefox 有效，
 * 但 WebKit 即便设置了它仍会导航（bug 240183），因此在 WebKit 上取消 wheel 是唯一手段。 */

/** 取消滚动容器消费不了、且以水平为主的 wheel 手势，浏览器便不会
 *  把它们读成历史滑动。该监听器必须是非 passive 的，因此不能挂在 React 的 passive wheel 座位上。 */
export function containHorizontalOverscroll(el: HTMLElement): () => void {
  const onWheel = (e: WheelEvent): void => {
    // 斜向手势归属主导轴；取消它会连带吃掉用户想要的
    // 纵向滚动。
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const atStart = e.deltaX < 0 && el.scrollLeft <= 0
    // 1px 容差：设备像素小数带来的滚动偏移会恰好差一点到不了精确末端。
    const atEnd = e.deltaX > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
    // 只在边界处生效：滚动中段的 wheel 事件由滚动容器自己消费。
    if (atStart || atEnd) e.preventDefault()
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  // 移除必须匹配监听器的同一性，因此沿用「带选项 vs 不带选项」这组配套写法。
  return () => { el.removeEventListener('wheel', onWheel) }
}
