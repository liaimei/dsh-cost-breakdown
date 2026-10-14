/**
 * 输入框下方那一行里，留给插件这条读数的**实际可用宽度**。
 *
 * 这一行是官方 `.dock`（`display:flex; justify-content:center; gap:12px`），
 * 里面并排着官方的用量胶囊、上下文环，以及插件这条读数。插件的槽位是
 * `kind: "list"`，条目本身不带任何 DOM 包裹层，所以 `trigger.parentElement` 就是那一行。
 *
 * 抽成纯函数是因为这段判据连续出过两次 bug，两次都只在「比的是哪个宽度」上出错：
 *
 * 1. 最初拿 `parent.clientWidth`（**整行**宽度）去比读数需要的宽度。插件只是这一行里的
 *    一个条目，于是「整行 860px、官方占掉约 260px、留给插件约 570px、读数需要约 600px」
 *    的情形下拿 600 比 860，答案永远是「够宽」——图标形态从不出现。
 * 2. 改成减掉兄弟条目之后，减的却是兄弟**被压扁后**的实测宽度。官方那两个读数胶囊是
 *    **可压缩**的（`min-width:0` + `text-overflow:ellipsis`），而插件这条是 `flex:none`
 *    不肯缩：空间不够时亏空全摊给官方读数，它们被截成「4 ...」「46....」，于是兄弟实测
 *    宽度跟着变小，算出的「留给插件」反而变大。这形成一个正反馈——**插件越不缩，官方越
 *    被挤，判据越说「够宽」**——正是线上「官方只剩图标、插件却完整」的成因。
 *
 * 正确做法是拿兄弟**需要的**宽度（自然宽度）来算：它不随挤压变化，因此不会自激，
 * 也才是「这一行要装下所有人」的真实开销。调用方负责提供自然宽度。
 */

/** 一行里留给某个条目的宽度所需的原始量。全部由调用方量出（jsdom 里为 0）。 */
export interface RowRoomInput {
  /** 整行的 `clientWidth`（含左右内边距；不含边框与滚动条）。量不到时为 0。 */
  rowWidth: number
  /** 整行的左内边距（px）。 */
  paddingLeft: number
  /** 整行的右内边距（px）。 */
  paddingRight: number
  /** 同行**其他**条目各自**需要**的宽度（自然宽度，见 {@link naturalWidthOf}），
   *  不含本条目自己。必须用「需要」而不是「当前占用」：可压缩的兄弟被压扁后，
   *  占用值会变小，判据就会反向自激。 */
  siblingWidths: readonly number[]
  /** flex 行里相邻条目之间的间距（`column-gap`，px）。 */
  gap: number
}

/** 把可能读成 `NaN` 的样式值收窄成非负数字。 */
function px(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 一个条目**需要**的宽度：当前盒宽 + 它自己（或其被 `overflow:hidden` 的子孙）正在
 * 藏起来的那部分内容。
 *
 * 「隐藏量 + 可见量」不随 flex 分配变化，因此这个数是稳定的；这正是判据需要的不变量。
 * 只累计**真的在裁剪**的节点（`scrollWidth > clientWidth`），父节点只是把裁剪继续传递
 * 时不会重复计数。
 *
 * 传入 `null`（元素不存在）时按 0 处理。
 */
export function naturalWidthOf(el: Element | null): number {
  if (el === null) return 0
  let width = 0
  try {
    width = el.getBoundingClientRect().width
    // `el` 自己也要看：条目本身可能就是那个裁剪者。
    for (const node of [el, ...el.querySelectorAll('*')]) {
      const hidden = node.scrollWidth - node.clientWidth
      if (hidden > 0) width += hidden
    }
  } catch {
    // 恶意节点（取属性即抛错）时据实退回 0：少算一个兄弟总比整行判据崩掉好。
    return 0
  }
  return width
}

/**
 * 本条目实际可用的宽度；行宽量不到（≤0）时返回 `null`。
 *
 * 行宽是 `clientWidth`，它包含内边距，所以内容宽要减掉两侧内边距；再减掉同行其他
 * 条目**需要的**宽度与条目之间的间距。`n` 个其他条目意味着这一行共有 `n + 1` 个
 * 条目、`n` 个间距。
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
