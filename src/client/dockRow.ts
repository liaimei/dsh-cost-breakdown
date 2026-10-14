/**
 * 输入框下方那一行里，留给插件这条读数的**实际可用宽度**。
 *
 * 抽成纯函数是因为这段判据出过一次很直接的 bug：插件原本拿
 * `parent.clientWidth`（**整行**宽度）去比「完整读数需要多宽」。可它只是这一行里的
 * 一个条目——同行还有官方的用量胶囊与上下文环（官方 `.dock` 是个
 * `display:flex` 的行，插件的槽位 `kind: "list"`，条目本身不带任何 DOM 包裹层，
 * 所以 `trigger.parentElement` 就是那一行）。于是线上「整行约 860px、官方占掉约
 * 260px、真正留给插件约 570px，而读数需要约 600px」这种情形下，判据拿 600 比 860，
 * 答案永远是「够宽」，图标形态因此从不出现——症状就是「怎么都不收缩」。
 *
 * 官方那边是靠 CSS 收缩的（`ui-chat/.../StatsPills.module.css` 的
 * `.root{min-width:0;max-width:100%}` 与 `.label{min-width:0;overflow:hidden;
 * text-overflow:ellipsis}`，整套组件里没有任何 JS 测量）。插件选择的是**退化成图标**
 * 这条更强的降级路径，那它就必须自己把「同行还有谁、间距多少」算进去。
 */

/** 一行里留给某个条目的宽度所需的原始量。全部由调用方量出（jsdom 里为 0）。 */
export interface RowRoomInput {
  /** 整行的 `clientWidth`（含左右内边距；不含边框与滚动条）。量不到时为 0。 */
  rowWidth: number
  /** 整行的左内边距（px）。 */
  paddingLeft: number
  /** 整行的右内边距（px）。 */
  paddingRight: number
  /** 同行**其他**条目各自占用的宽度（官方读数等），不含本条目自己。 */
  siblingWidths: readonly number[]
  /** flex 行里相邻条目之间的间距（`column-gap`，px）。 */
  gap: number
}

/** 把可能读成 `NaN` 的样式值收窄成非负数字。 */
function px(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 本条目实际可用的宽度；行宽量不到（≤0）时返回 `null`。
 *
 * 行宽是 `clientWidth`，它包含内边距，所以内容宽要减掉两侧内边距；再减掉同行其他
 * 条目的宽度与条目之间的间距。`n` 个其他条目意味着这一行共有 `n + 1` 个条目、
 * `n` 个间距。
 *
 * 返回 `null` 而不是 0，是为了让调用方能把「量不到」与「真的没空间」分开：
 * 前者（jsdom、未布局的首帧）应当按「够宽」处理，宁可显示完整读数也不要在异常
 * 环境里退化成图标。
 */
export function roomForEntry(input: RowRoomInput): number | null {
  const row = px(input.rowWidth)
  if (row <= 0) return null
  const content = row - px(input.paddingLeft) - px(input.paddingRight)
  const siblings = input.siblingWidths.reduce((sum, w) => sum + px(w), 0)
  const gaps = px(input.gap) * input.siblingWidths.length
  return Math.max(0, content - siblings - gaps)
}
