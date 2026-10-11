/// <reference types="node" />
/**
 * 在 toolSources.ts 的静态补救之上叠加的实时「工具 → 插件」归因。
 *
 * session 日志把工具记成普通的 `ToolSchema` 条目，注册它的插件因此不在里面。
 * 本模块盯的是「运行时」注册：每次通过 context 读取 service 属性时，cordis 都会触发 `internal/get` waterfall，
 * 并把「发起读取的」context 放在第一个参数，
 * 于是 `reader.fiber.name`就能指认那个即将调用 `register()` 的插件。
 *
 * - 处理器只记下这个 fiber「名称」——一个标量，绝不保留 reader context，
 * 否则会把调用方的整个 agent 钉住到 dispose 之后——并包装 tools service 的 `register`来捕获 reader。cordis 每次读取都发一个新的 traced proxy，
 * 因此先把 proxy 剥到其稳定实例；重载时还会把上一个化身的包装剥回原始函数，
 * 包装因此永不叠加；卸载时每个包装都会被撤销。
 * - reader 槽位缺失、名为 root，
 * 或就是本插件自己（本地链接会回落到 root 名）时，
 * 被包装的 `register` 改为从调用栈解析调用方：取本包之外的第一帧，
 * 再映射到最近的 package.json `name`。
 * - `ownerOf(name)` 优先用名称推出的 `mcp:<server>` 标签，
 * 其次实时记录，再次固定映射；
 * 对早于本 hook 启动的工具打上 `UNKNOWN_TOOL_SOURCE`——它们的插件无从得知，而留空会被读成「没有插件」。
 *
 * 尽力而为：读取与 `register()` 之间隔了一个 `await` 时，
 * 可能被另一个插件的读取覆盖；栈回落也需要一个能解析到的 package.json。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { UNKNOWN_TOOL_SOURCE } from '../shared/types'
import { mcpSourceOf, pinnedSourceOf } from './toolSources'

/** headers 单元消费的归因接口：为某个工具名给出可选的插件标签。 */
export interface ToolAttribution {
  ownerOf(name: string): string | undefined
}

const selfUrl = normalize(fileURLToPath(import.meta.url))

/** 供下面向上遍历使用的「目录 → 包名」缓存。 */
const packageCache = new Map<string, string | undefined>()

/**
 * 某个模块文件尽力而为的包名：最近的带 `name` 的 `package.json`。
 * 向上遍历有次数上限（深到足以覆盖任何现实的 `node_modules` 嵌套，浅到损坏路径也无法空转），
 * 且访问过的每个目录无论结果如何都会入缓存。
 * @param file - 模块文件的绝对路径。
 */
export function packageNameFrom(file: string): string | undefined {
  let dir = dirname(file)
  for (let depth = 0; depth < 12; depth++) {
    const cached = packageCache.get(dir)
    if (cached !== undefined) return cached
    const packageFile = join(dir, 'package.json')
    if (existsSync(packageFile)) {
      try {
        const name = (JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: unknown }).name
        if (typeof name === 'string' && name) {
          packageCache.set(dir, name)
          return name
        }
      } catch {
        // package.json 格式错误或读不出来——继续向上走。
      }
    }
    const parent = dirname(dir)
    packageCache.set(dir, undefined)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

const FRAME_POSITION = /:\d+:\d+$/

/** cordis 在其 traced proxy 上注册（`Symbol.for`）的符号；读它会得到被包装的目标。 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * 把 cordis 每次读取新建的 traced proxy（dsh 的 ToolRuntime 每次 `ctx.tools` 读取都会发一个）
 * 剥到它所包装的实例，让按身份索引的簿记看到同一个稳定对象。
 * @param tools - context 读取所交出的值。
 */
function rawInstanceOf(tools: unknown): unknown {
  const raw = (tools as { [key: symbol]: unknown } | undefined | null)?.[CORDIS_ORIGINAL]
  return raw ?? tools
}

const selfPackage = packageNameFrom(selfUrl)

/**
 * 从调用栈解析注册方所在的包：本包之外第一帧的包名，
 * `file://` 与裸路径两种形式都支持。
 * @param stack - `Error().stack`；不想要回落时传 undefined。
 */
export function callerPackageFrom(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  for (const raw of stack.split('\n').slice(1)) {
    let line = raw.trim()
    if (!line.startsWith('at ')) continue
    line = line.slice(3)
    if (line.startsWith('async ')) line = line.slice(6)
    line = line.replace(/\)\s*$/, '')
    const position = FRAME_POSITION.exec(line)
    if (!position) continue
    let target = line.slice(0, -position[0].length)
    if (target.includes('(')) {
      target = target.slice(target.lastIndexOf('(') + 1)
    }
    if (target.startsWith('file://')) {
      try {
        target = normalize(fileURLToPath(target))
      } catch {
        continue
      }
    } else if (!/^[A-Za-z]:[\\/]/.test(target) && !target.startsWith('/') && !target.startsWith('\\\\')) {
      continue
    } else {
      target = normalize(target)
    }
    if (target === selfUrl) continue
    const name = packageNameFrom(target)
    if (name !== undefined && name !== selfPackage) return name
  }
  return undefined
}

interface ToolServiceLike {
  layers?: {
    global?: {
      tools?: {
        entries?: () => Iterable<[string, unknown]>
      }
    }
  }
}

/**
 * 在 cordis app context 上装好实时归因 hook；它随调用方 fiber 的寿命存在，
 * 并随插件一起 dispose。
 * @param ctx - dsh-cost-breakdown 插件运行所在的 context；它自己的 fiber 名会被排除。
 */
export function createToolAttribution(ctx: Context): ToolAttribution {
  const live = new Map<string, string>()
  const wrapped = new WeakSet()
  const self = ctx.fiber.name
  // 只记 reader 的 fiber「名称」：保留 context 会把它的整个 agent 钉住到 dispose 之后。
  let lastReader: string | undefined
  // 本化身打过补丁的每个实例各自的还原闭包（由卸载 effect 执行）。
  const patched: (() => void)[] = []

  const wrapInstance = (tools: unknown) => {
    if (!tools || typeof tools !== 'object' || wrapped.has(tools)) return
    const register = (tools as { register?: unknown }).register
    if (typeof register !== 'function') return
    wrapped.add(tools)
    // 重载会在一个仍处于包装状态的实例上重新装 hook：剥掉上一个化身的包装，
    // 包装因此不会层层叠加。
    const original = (register as { attributedOriginal?: unknown }).attributedOriginal ?? register
    if (typeof original !== 'function') return
    const instance = tools as { register: (this: unknown, definition?: { name?: unknown }) => unknown }
    const wrappedRegister = function (this: unknown, definition?: { name?: unknown }) {
      const toolName = definition?.name
      let owner = lastReader
      if (!owner || owner === 'root' || owner === self) {
        owner = callerPackageFrom(new Error().stack)
      }
      const dispose = (original as (this: unknown, definition?: unknown) => unknown).call(this, definition)
      if (typeof toolName === 'string' && owner && owner !== 'root' && owner !== self && owner !== selfPackage) {
        live.set(toolName, owner)
        if (typeof dispose === 'function') {
          return () => {
            try {
              return (dispose as () => unknown)()
            } finally {
              live.delete(toolName)
            }
          }
        }
      }
      return dispose
    }
    ;(wrappedRegister as { attributedOriginal?: unknown }).attributedOriginal = original
    instance.register = wrappedRegister
    patched.push(() => {
      if (instance.register === wrappedRegister) instance.register = original as typeof instance.register
    })
  }

  ctx.on('internal/get', (reader, name, _error, next) => {
    if (name !== 'tools') return next() as unknown
    const tools = next() as unknown
    // 补丁打在稳定实例上，但返回调用方自己的 proxy：它的 this 绑定带着读取方 context
    // 的作用域注册语义。
    lastReader = reader.fiber.name
    wrapInstance(rawInstanceOf(tools))
    return tools
  })

  // 卸载会剥掉本化身装上的每个包装；闭包若发现已是更新化身的包装就不动手——
  // 还原归那个化身负责。
  ctx.effect(() => () => {
    for (const restore of patched.splice(0)) restore()
  }, 'tools.register attribution')

  // 本插件启动前就提供的实例照样会被包装，以捕获之后的注册；
  // 它已经持有的工具是在 hook 能观察之前注册的，其来源无从得知，启动快照因此把它们标成
  // UNKNOWN_TOOL_SOURCE，而不是留空。
  const toolsService = rawInstanceOf(ctx.get('tools', false)) as ToolServiceLike | undefined
  wrapInstance(toolsService)
  const boot = new Set<string>()
  try {
    const toolEntries = toolsService?.layers?.global?.tools
    // 按方法调用：`entries()` 会读 `this.data`，必须保留接收者；形态一旦出乎意料，
    // 启动快照就留空（归因绝不能把启动搞坏）。
    if (toolEntries !== undefined && typeof toolEntries.entries === 'function') {
      for (const [name] of toolEntries.entries()) boot.add(name)
    }
  } catch {
    // tools service 内部结构不受支持——退化为没有启动快照。
  }

  return {
    ownerOf: name =>
      mcpSourceOf(name) ?? live.get(name) ?? pinnedSourceOf(name)
        ?? (boot.has(name) ? UNKNOWN_TOOL_SOURCE : undefined),
  }
}
