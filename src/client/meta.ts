/** 构建期注入的宏（tsdown.config.ts）；typeof 判断用于兜底没有这些宏的构建产物。 */

declare const __DSH_CTX_VERSION__: string | undefined
declare const __DSH_CTX_REPO__: string | undefined

/** npm 包名：Plugin-info 更新检查所用的注册表路径。locale 命名空间
 *  （index.ts 里的 `NS`）与侧栏 kind 刻意取同一个字符串，但分开声明，
 *  这样本模块保持为不含任何客户端 import 的叶子节点。**不是** Host 设置
 *  命名空间——那是 loader 行 id（index.ts 的 `SETTINGS_NS`）。 */
export const PLUGIN_NAME = 'dsh-cost-breakdown'

/** 构建时打戳的版本；没有该宏的构建产物会报告 `0.0.0-dev`，
 *  而 pluginInfo.tsx 遇到任何 `-dev` 值都会跳过更新检查。 */
export const PLUGIN_VERSION: string =
  typeof __DSH_CTX_VERSION__ === 'string' ? __DSH_CTX_VERSION__ : '0.0.0-dev'

/** Plugin-info 卡片打开的仓库链接（DeepSeek 行与 GitHub 行都用它）。 */
export const PLUGIN_REPO: string =
  typeof __DSH_CTX_REPO__ === 'string' ? __DSH_CTX_REPO__ : 'https://github.com/liaimei/dsh-cost-breakdown'

/** 只有 `owner/repo`：这是 GitHub 行展示的值，而行上的链接
 *  仍保留完整 URL。 */
export const PLUGIN_REPO_SHORT = PLUGIN_REPO.replace(/^https?:\/\/github\.com\//, '')
