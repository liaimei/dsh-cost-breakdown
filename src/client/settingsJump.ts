/** 尽力跳到 Plugins 主面板上本插件的偏好设置：先点面板的侧栏
 * 条目，再轮询 bundle 卡片的打开控件。每一步都保持静默，绝不把异常抛进
 * 调用方的渲染；对不上的 shell 会把整个跳转退化为空操作。 */

/** 随附 Plugins 在两种 locale 下的标签——主面板条目的 aria-label。 */
const PLUGIN_LABELS = new Set(['Plugins', '插件'])

/** bundle 卡片随附的列表标识（与 locale 无关）。 */
const PACKAGE_KEY = 'dsh-cost-breakdown'

/** 100ms 一跳共 40 跳：足够该页面的包加载完成。 */
const POLL_TICKS = 40

function buttonsOf(doc: Document): HTMLButtonElement[] {
  return [...doc.querySelectorAll<HTMLButtonElement>('button')]
}

function findPanelEntry(doc: Document): HTMLButtonElement | undefined {
  return buttonsOf(doc).find(b => PLUGIN_LABELS.has(b.getAttribute('aria-label') ?? ''))
}

/** bundle 卡片的打开控件：卡片内唯一不是启用开关的按钮
 * （primitives 的开关带 `role="switch"`）；标题按钮自己的 aria-label 是本地化的。 */
function findCardOpenControl(doc: Document): HTMLButtonElement | undefined {
  const card = doc.querySelector(`[data-plugin-package="${PACKAGE_KEY}"]`)
  if (card === null) return undefined
  const open = [...card.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.getAttribute('role') !== 'switch')
  return open.length === 1 ? open[0] : undefined
}

/** `doc` 与 `schedule` 是接缝，使该跳转无需真实 shell 也能测试；生产
 *  调用方两个都不传。绝不抛错、也绝不 await：任何失败都把用户留在
 *  卡片列表上，从那里仍可手动进入设置。 */
export function openPluginSettings(
  doc: Document = document,
  schedule: (run: () => void, ms: number) => void = (run, ms) => { window.setTimeout(run, ms) },
): void {
  try {
    const panel = findPanelEntry(doc)
    // 这个 shell 里没有 Plugins 条目：无处可点，跳转因此是一次静默的空操作。
    if (panel === undefined) return
    panel.click()
    const poll = (left: number): void => {
      try {
        const open = findCardOpenControl(doc)
        if (open !== undefined) {
          open.click()
          return
        }
      } catch { /* 卡片不可信：留在卡片列表上 */ }
      // 有次数上限：卡片的 bundle 可能永远加载不出来，而无上限的轮询会比页面活得还久。
      if (left > 0) schedule(() => { poll(left - 1) }, 100)
    }
    // 初次延时让面板自身的路由切换先提交，再做第一次探测。
    schedule(() => { poll(POLL_TICKS) }, 200)
  } catch { /* 设置界面与预期不符 */ }
}
