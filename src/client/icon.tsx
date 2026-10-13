/** 插件徽标：从包根目录的 `icon.svg`（即 package.json 的 `icon` 交给 Host 的那个文件）
 * 打包进来的三段式仪表盘，而不是从 harness primitives 读取，插件的身份因此自成一体。
 * 各处身份座位沿用仪表盘固定的配色；只有侧栏的面板列表座位选择 `mono`，
 * 把同一份图形改用周围文字色着色。 */

import sheetMarkup from '../../icon.svg?raw'
import type { ReactElement } from 'react'
import type { Translate } from './i18n'

const SHEET_MARKUP = sheetMarkup
  .slice(sheetMarkup.indexOf('>') + 1, sheetMarkup.lastIndexOf('</svg>'))
  .trim()
  .replace(/>\s+</g, '><')

/** `mono` 座位的标记：把**同一份**图形中每个字面色都换成 `currentColor`，
 * 从而由 harness 的行配色来绘制。仪表盘是描边绘制的，因此这种改色
 * （而不是会侵蚀填充的遮罩，那适合实心字形）才让插件只需**一份**图形。 */
const MONO_MARKUP = SHEET_MARKUP
  .replace(/stroke="#[0-9A-Fa-f]{6}"/g, 'stroke="currentColor"')
  .replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="currentColor"')

/** 徽标的 props，与引导胶囊传给它的 harness `IconProps` 匹配。 */
export interface ContextIconProps {
  size?: number
  className?: string
  /** 侧栏面板列表座位：用周围文字色，而不是固定配色。 */
  mono?: boolean
}

/** 每处注册都把它用作 JSX 类型，因此必须保持为普通组件：
 *  host 的 slot 渲染器只带 `IconProps` 挂载它，而 `mono` 是可选加入的。 */
export function ContextIcon({ size = 20, className, mono = false }: ContextIconProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      dangerouslySetInnerHTML={{ __html: mono ? MONO_MARKUP : SHEET_MARKUP }}
    />
  )
}

/** 侧栏面板列表的字形：`mono` 形式的徽标，从而由 shell 拥有那一行的悬停/激活配色
 *  像随附行一样绘制它；该行的标签与选中态归 shell 管，因此宿主 `active` 不会被读取。 */
export function InsightPanelIcon({ size = 18 }: { size?: number }): ReactElement {
  return <ContextIcon size={size} mono />
}

/** 标签芯片的标题座位：标签前的徽标，通过插件自己绑定的翻译函数读取，
 *  使芯片跟随 locale——而不用标签信息 hook，后者遇到尚未提交的标签记录可能抛错。
 *  `key` 由调用方给出：对话区那页与右侧栏那一列各讲一件事，因此各有各的名字。
 *  标签尾部的间隙（`.lc-title-label`）让激活芯片的淡出效果不压到末尾几个字形上。 */
export function makeContextTabTitle(t: Translate, key = 'tab'): () => ReactElement {
  return function ContextTabTitle(): ReactElement {
    return (
      <>
        <ContextIcon size={16} className="lc-title-icon" />
        <span className="lc-title-label">{t(key)}</span>
      </>
    )
  }
}
