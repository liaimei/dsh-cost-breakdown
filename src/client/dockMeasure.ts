/** /context 模态框的停靠内缩量：固定背板覆盖的是 frame 的中列，而不是整个视口。
 * frame 行内的网格模板（`<sidebar>px <centre> <rightbar>`）是唯一的宿主播点，其
 * 末尾的 px 轨道是右侧面板的上界而非解出的宽度（网格会先压缩中列），
 * 因此要截断到中列下限让出的空间；无法测量时内缩量退化为 0。 */

/** 模态框背板的水平内缩量：两侧各留出多少 px，使遮罩
 *  只覆盖 frame 的中列，外加遮罩相对定位所依据的 frame 元素
 *  （未找到网格祖先时为 `null`——遮罩此时铺满整个视口）。 */
export interface DockMeasure {
  left: number
  right: number
  frame: HTMLElement | null
}

const LEADING_PX_TRACK = /^(\d+(?:\.\d+)?)px/
// 中列轨道声明的下限（`minmax(0, 1fr)`、`minmax(400px, 1fr)`——写法随 shell 布局而异，只读取其中的数字）。
const CENTRE_MIN_TRACK = /^\s*minmax\(\s*([\d.]+)(?:px)?\s*,/
const TRAILING_PX_TRACK = /(\d+(?:\.\d+)?)px\)?$/

/** 从 `start`（模态框自身的节点）向上走到第一个带行内
 *  `gridTemplateColumns` 的祖先并读取其轨道。每次打开都重新测量、从不缓存：
 *  frame 使用行内样式，其轨道随 shell 布局和行宽变化。 */
export function measureDock(start: HTMLElement | null): DockMeasure {
  try {
    for (let el = start?.parentElement ?? null; el !== null; el = el.parentElement) {
      const template = el.style.gridTemplateColumns
      // 只认行内模板：样式表规则计算出的轨道会匹配到
      // 每一个网格，因此要靠宿主自己的 style 属性来认出 frame。
      if (template === '') continue
      const trimmed = template.trim()
      const lead = LEADING_PX_TRACK.exec(trimmed)
      if (lead === null) return { left: 0, right: 0, frame: null }
      const trail = TRAILING_PX_TRACK.exec(trimmed)
      // 只有开头一条轨道的模板会同时命中两个锚点：不存在右侧面板轨道可供内缩。
      if (trail === null || trail.index === 0) return { left: Number(lead[1]), right: 0, frame: el }
      const centreMin = CENTRE_MIN_TRACK.exec(trimmed.slice(lead[0].length))
      const bound = Number(trail[1])
      // 读不到 `minmax(...)` 下限，意味着中列合法地可以塌缩到 0，
      // 此时整个上界都适用；否则右内缩量让位于中列下限。
      const centreFloor = centreMin === null ? 0 : Number(centreMin[1])
      return {
        left: Number(lead[1]),
        right: Math.min(bound, Math.max(0, window.innerWidth - Number(lead[1]) - centreFloor)),
        frame: el,
      }
    }
  } catch { /* 链路上出现恶意节点时退化为铺满视口的遮罩 */ }
  return { left: 0, right: 0, frame: null }
}
