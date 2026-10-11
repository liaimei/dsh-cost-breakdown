/**
 * Context Insights 页面的悬停提示：以页面根节点上的事件委托驱动一个 portal 到 <body> 的固定气泡。
 *
 * 页面就是那个 `lc-ov` 查询容器，它内联尺寸上的 containment 使页面成为
 * 固定定位后代的包含块：气泡若留在树内，会从自己的锚点旁跑开一个侧边栏的宽度。
 *
 * 锚点携带 `data-lc-tip`（提示文本）与可选的 `data-lc-tip-side`（默认 'top'，可选 'bottom'）。
 *
 * @module dsh-cost-breakdown/client/components/hoverTip
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

/** 气泡占用的 id，也是锚点 `aria-describedby` 指向的目标；同一时刻只有一个气泡
 *  是活的，所以一个固定 id 就够了。 */
const TIP_ID = 'lc-hovertip-bubble'

/** 锚点到气泡的距离，以及气泡被夹在其中的视口边距，单位 px。 */
const GAP = 6
const VIEWPORT_MARGIN = 8

/** 气泡打开时读取的锚点及其事实；`rect` 在打开那一刻就冻结，
 *  因为布局 effect 依据它定位，而不是去重读一个正在移动的锚点。 */
interface ActiveTip {
  anchor: Element
  label: string
  side: 'top' | 'bottom'
  rect: { left: number; top: number; width: number; height: number; bottom: number }
}

/** 一次解析出的气泡位置；与它对应的 tip 成对存放，
 *  这样一份过期的测量结果无法给更新的 tip 定位。 */
interface Measured {
  tip: ActiveTip
  left: number
  top: number
}

function anchorOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? target.closest('[data-lc-tip]') : null
}

/** 取值时读目标的 `label` 与 `side`；side 默认 'top'，锚点只有显式声明
 *  才会让气泡落在下方。没有 label 的锚点返回 null，气泡关闭。 */
function tipOf(anchor: Element): ActiveTip | null {
  const label = anchor.getAttribute('data-lc-tip')
  if (label === null || label === '') return null
  const r = anchor.getBoundingClientRect()
  return {
    anchor,
    label,
    side: anchor.getAttribute('data-lc-tip-side') === 'bottom' ? 'bottom' : 'top',
    rect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom },
  }
}

/** 页面铺满整棵子树的那块区域：在这里委托，意味着锚点只需一个属性，
 *  重新渲染出来的行也不必自带监听器。 */
export interface HoverTipZone {
  zoneProps: {
    onMouseOver: (ev: React.MouseEvent) => void
    onMouseOut: (ev: React.MouseEvent) => void
    onFocusCapture: (ev: React.FocusEvent) => void
    onBlurCapture: (ev: React.FocusEvent) => void
    onScrollCapture: (ev: React.UIEvent) => void
  }
  bubble: ReactElement | null
}

/** 气泡在布局 effect 测量出位置之前一直渲染为不可见，因此绝不会在未测量的位置闪一下。 */
export function useHoverTip(): HoverTipZone {
  const [tip, setTip] = useState<ActiveTip | null>(null)
  const [measured, setMeasured] = useState<Measured | null>(null)
  const bubbleRef = useRef<HTMLDivElement | null>(null)

  const show = useCallback((anchor: Element): void => {
    setTip((current) => {
      // 同一个锚点（在其自身子树内移动）：保留 tip 并重新测量。
      if (current?.anchor === anchor) return current
      current?.anchor.removeAttribute('aria-describedby')
      const next = tipOf(anchor)
      if (next === null) return null
      anchor.setAttribute('aria-describedby', TIP_ID)
      return next
    })
  }, [])

  const hide = useCallback((): void => {
    setTip((current) => {
      current?.anchor.removeAttribute('aria-describedby')
      return null
    })
  }, [])

  // 切换锚点从不隐藏：从 A 移到 B 会跳过隐藏，因为 B 的 mouseover 会重新锚定。
  const onMouseOver = useCallback((ev: React.MouseEvent): void => {
    const anchor = anchorOf(ev.target)
    if (anchor !== null) show(anchor)
  }, [show])
  const onMouseOut = useCallback((ev: React.MouseEvent): void => {
    if (anchorOf(ev.target) !== null && anchorOf(ev.relatedTarget) === null) hide()
  }, [hide])
  const onFocusCapture = useCallback((ev: React.FocusEvent): void => {
    const anchor = anchorOf(ev.target)
    if (anchor !== null) show(anchor)
  }, [show])
  const onBlurCapture = useCallback((ev: React.FocusEvent): void => {
    if (anchorOf(ev.target) !== null && anchorOf(ev.relatedTarget) === null) hide()
  }, [hide])
  const onScrollCapture = useCallback((): void => { hide() }, [hide])

  // 视口尺寸变化会移动每一个锚点：收回气泡，而不是让它悬空在原处。
  useEffect(() => {
    if (tip === null) return undefined
    const retract = (): void => { hide() }
    window.addEventListener('resize', retract)
    return () => { window.removeEventListener('resize', retract) }
  }, [tip, hide])

  // 每个显示中的 tip 只测量一次（以 tip 身份为 key，所以同锚点内的 mousemove 不会反复隐藏）。
  useLayoutEffect(() => {
    if (tip === null || measured?.tip === tip) return
    const el = bubbleRef.current
    /* 无法到达：portal 在布局 effect 运行之前就已经提交了它的 ref。 */
    if (el === null) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    const { rect } = tip
    const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - VIEWPORT_MARGIN))
    let top = tip.side === 'top' ? rect.top - h - GAP : rect.bottom + GAP
    if (tip.side === 'top' && top < VIEWPORT_MARGIN) top = rect.bottom + GAP
    else if (tip.side === 'bottom' && top + h > window.innerHeight - VIEWPORT_MARGIN) top = rect.top - h - GAP
    setMeasured({ tip, left, top: Math.max(VIEWPORT_MARGIN, top) })
  }, [tip, measured])

  const shown = measured !== null && measured.tip === tip ? measured : null
  return {
    zoneProps: { onMouseOver, onMouseOut, onFocusCapture, onBlurCapture, onScrollCapture },
    bubble: tip === null ? null : createPortal(
      <div
        ref={bubbleRef}
        id={TIP_ID}
        role="tooltip"
        className="lc-tip lc-hovertip"
        style={shown === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: shown.left, top: shown.top, opacity: 1 }}
      >{tip.label}</div>,
      document.body,
    ),
  }
}
