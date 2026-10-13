/**
 * 输入框下方那张展开卡的定位几何。
 *
 * 抽成纯函数是因为这段判据出过一次很难看的 bug：触发条贴在窗口底部时，卡片被
 * 「翻到下方」推出屏幕之外，同时被硬编码的最小高度压成一条几乎不可见的窄带——
 * 点得动、state 也对，就是看不见。纯函数让这种几何能被直接断言。
 */

/** 卡片的最终位置与尺寸。 */
export interface DockAnchor {
  left: number
  top: number
  width: number
  maxHeight: number
}

export interface PlacementInput {
  /** 触发条的视口矩形。 */
  trigger: { top: number; left: number; width: number; bottom: number }
  /** 视口尺寸。 */
  viewport: { width: number; height: number }
  /** 卡片内容的自然高度（`scrollHeight`），已被调用方兜过底。 */
  natural: number
  /** 卡片**实际占用的宽度**，由调用方量出（样式表把宽度交给了内容：`width: max-content`）。
   *  这里只用它做水平夹取，因此量不出时才用 `minWidth` 兜底。 */
  cardWidth: number
  /** 卡片宽度的下限：内容再窄也不该窄过它。 */
  minWidth: number
  /** 视口两侧各留的边距。 */
  gutter: number
  /** 触发条与卡片之间的空隙。 */
  gap: number
  /** 卡片允许被压缩到的最小高度。低于它就不该硬塞——那只会得到一条看不见的窄带。 */
  minHeight: number
}

/** 上方可用高度（触发条顶边到视口顶边）。 */
function roomAbove(input: PlacementInput): number {
  return input.trigger.top - input.gutter
}

/** 下方可用高度（触发条底边到视口底边）。 */
function roomBelow(input: PlacementInput): number {
  return input.viewport.height - input.trigger.bottom - input.gutter
}

/**
 * 算出卡片的位置。
 *
 * 规则（按优先级）：
 * 1. **优先放在上方**，那是这个控件习惯的方向；
 * 2. 上方放不下整体时，若**下方更宽裕**才翻下去——只看「上方放不下」就翻转，
 *    会在触发条贴底时把卡片推到屏幕外（这正是修掉的那个 bug）；
 * 3. 翻转后仍放不下时，**回到空间更大的那一侧**，而不是留在错的一侧；
 * 4. 高度取「自然高度」与「该侧可用高度」的较小值，但**不低于 `minHeight`**：
 *    宁可略略越出边界（内容仍可滚动），也不要压成一条看不清的窄带。
 *
 * 宽度由**内容**决定（样式表给了 `width: max-content`），这里只做两件事：
 * 把量到的宽度夹进视口，并保证不窄于 `minWidth`。卡片水平锚定在触发条左缘，
 * 越界时再往回收。
 */
export function placeDockCard(input: PlacementInput): DockAnchor {
  const above = roomAbove(input)
  const below = roomBelow(input)
  // 上方优先；仅当上方确实放不下、且下方更宽裕时才翻转。
  const flip = above < input.natural && below > above
  const room = flip ? below : above
  const maxHeight = Math.max(input.minHeight, room)
  const top = flip
    ? input.trigger.bottom + input.gap
    : input.trigger.top - Math.min(input.natural, maxHeight) - input.gap
  // 内容量不出宽度（首帧、或样式表还没生效）时退回下限，而不是算出一个 0 宽的卡片。
  const viewportMax = Math.max(input.minWidth, input.viewport.width - input.gutter * 2)
  const width = Math.min(Math.max(input.cardWidth, input.minWidth), viewportMax)
  const left = Math.max(input.gutter, Math.min(input.trigger.left, input.viewport.width - width - input.gutter))
  return { left, top, width, maxHeight }
}

/** 卡片在视口底边之外时用到的最小露头高度：卡片顶部至少留出这么多才算「看得见」。
 *  用来兜住「两侧都放不下」的极端情形——那时至少让卡片可辨认、可滚动。 */
export const DOCK_CARD_MIN_HEIGHT = 160
