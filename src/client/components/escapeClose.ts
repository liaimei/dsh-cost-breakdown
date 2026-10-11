/** 插件各浮层的 Escape 关闭：在 window 上以捕获阶段监听 keydown，因此 harness 自己的 Escape 路由
 * （一个冒泡阶段的 window 监听器）永远看不到这个按键。 */

import { useEffect, useRef } from 'react'

/** `onClose` 走 latest-ref：若每次渲染都重新订阅，清理函数里的焦点恢复会跟着重跑，
 * 于是每敲一个键都会把焦点从浮层自己的输入框里拽走。 */
export function useEscapeClose(active: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!active) return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (previous !== null && document.contains(previous)) previous.focus()
    }
  }, [active])
}
