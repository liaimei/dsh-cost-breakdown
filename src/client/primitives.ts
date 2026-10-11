/** 从 ui-primitives 平台模块按名导入，并做防御式解析：导出缺失或改名
 * 会让 Context 标签页里渲染出 React error #130，因此每个图标都按名字
 * 经过一次有界读取来解析，并退化为「什么都不渲染」的兜底。 */

import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** 每个解析出的图标所取的形态；`IconProps` 属于平台，因此兜底组件
 *  不必知道它有哪些 size/className 字段也必须满足它。 */
export type IconComponent = (props: IconProps) => ReactElement | null

const ns = primitives as unknown as Record<string, unknown>

/** 按导出名解析一个图标；缺失、非组件或恶意命名空间的读取都渲染空内容。 */
export function resolveIcon(name: string, source: Record<string, unknown> = ns): IconComponent {
  try {
    const found = source[name]
    if (typeof found === 'function') return found as IconComponent
  } catch { /* 走下面的兜底 */ }
  return () => null
}

// 下面九个座位在模块加载时**只解析一次**，因此导出改名只损失对应
// 字形；用 `resolveIcon` 而不是直接 import，正是为了避免坏的 element 类型
// （React error #130）拖垮整个 Context 标签页的渲染。

/** timeline 事件列表中的模型切换事件标记（events.tsx）。 */
export const IconBranch = resolveIcon('IconBranchOutlineRegular')
/** timeline 事件列表中的注入上下文事件标记（events.tsx）。 */
export const IconPlus = resolveIcon('IconPlusOutlineRegular')
/** 技能卡片复制控件上的「已复制」对勾（overviewSkills.tsx）。 */
export const IconCheck = resolveIcon('IconCheckOutlineRegular')
/** 复制技能路径 / 富文本原始正文。 */
export const IconCopy = resolveIcon('IconCopyOutlineRegular')
/** 关闭富文本查找栏（richText.tsx）。 */
export const IconClose = resolveIcon('IconCloseOutlineRegular')
/** 「Preferences」行/面板入口，用于打开插件自己的设置卡片。 */
export const IconSettings = resolveIcon('IconSettingsOutlineMedium')
/** 日期范围下拉框与查找栏的向下跳转控件。 */
export const IconChevronDown = resolveIcon('IconChevronDownOutlineMedium')
/** 查找栏的「上一个匹配」跳转。 */
export const IconChevronUp = resolveIcon('IconChevronUpOutlineMedium')
/** 查找栏的查询入口。 */
export const IconSearch = resolveIcon('IconSearchOutlineRegular')
