/** 浏览器 bundle 的 CJS 闭包所用的运行时全局量，为严格类型检查而声明。 */

// 客户端 bundle 以 CJS 形式发布（index.ts 里的 `module.exports` 就是插件入口），
// 由浏览器构建在运行时提供——因此这里用 `declare` 而不是 import。
declare function require(id: string): unknown
declare let module: { exports: Record<string, unknown> }
declare let exports: Record<string, unknown>

// 样式表通道（见 tsdown.config.ts）：副作用式全局样式表、?inline 文本、CSS Modules 映射表。
/** 副作用样式表：只为层叠而 import（index.ts 固定了 import 顺序），从不取用其中的值。 */
declare module '*.css'
/** CSS Modules：类名每次构建都会哈希，因此键以字符串形式查找。 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.svg?raw' {
  const markup: string
  export default markup
}
