/**
 * 同一行上官方浮层的让位判据。
 *
 * 背景：插件卡片与官方的上下文浮层（`ContextMeter.module.css` 的 `.panel`）**都在
 * `z-index: 1100`**——同层时后挂载的赢。这不是谁写错，官方自己的两个浮层也是这个规则，
 * 而插件不该把自己的层级抬到官方之上（那会盖住官方界面）。所以唯一的正解是**让位**：
 * 官方浮层开着的时候，插件把卡片收起来。
 *
 * 怎么认出官方浮层：它是 portal 到 `body` 的一个 `div[role="dialog"]`，层级 1100。
 * 不用类名判断——类名是带哈希的（`y0jqnG_panel`），换一次构建就会变。
 */

/** 官方浮层与插件卡片共用的层级。用它把「同层」这个条件也一并核对，
 *  因此将来官方换了层级，判据会跟着失效而不是误判。 */
const OFFICIAL_LAYER = '1100'

/** 官方那一行浮层的选择器：portal 出来的对话框。 */
const DIALOG_SELECTOR = 'body > [role="dialog"]'

/** 只看真实挂载的浮层：`display:none` 或 `visibility:hidden` 的不算。 */
function isShown(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  // 尺寸为 0 的通常是尚未定位的过渡帧（官方在 `position` 未就绪时先隐藏，
  // 那种帧不该让我们误判成「官方开着」而收起自己的卡片）。
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * 此刻是否有官方浮层挂在同一层级上。
 *
 * 只认**同层**的对话框：官方还有其他 `role="dialog"` 的浮层（如设置弹窗），
 * 它们挂在更高的层级上、并且会遮住整个界面，那时插件收不收起来都无所谓，
 * 也就不该据此抖动。
 */
export function officialOverlayOpen(root: ParentNode = document): boolean {
  let nodes: NodeListOf<Element>
  try {
    nodes = root.querySelectorAll(DIALOG_SELECTOR)
  } catch { return false }
  for (const el of Array.from(nodes)) {
    try {
      if (window.getComputedStyle(el).zIndex !== OFFICIAL_LAYER) continue
      if (isShown(el)) return true
    } catch { continue }
  }
  return false
}
