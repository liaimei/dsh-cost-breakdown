/**
 * 基线闸门背后的运行时 harness 版本探测（host/index.ts）。
 *
 * 探测从不为了拿版本去 import harness 包；
 * 它按顺序从两个锚点经 Node 解析读取 manifest：
 *
 * 1. 本模块自身的 ESM 解析，解析 Host 这一半在运行时 import 的库包：
 * 正是进程解析这些 import 的那条管线，
 * 因此重定向插件 import 的宿主 shell 也会以同样方式重定向探测。
 * 落在这个包自己目录树里的见证属于插件的依赖闭包、而非 harness，
 * 一律丢弃。 2. harness home 的 `profiles/node_modules` 镜像（通过 app-boot 的 `dshHomePath` service），
 * 它指向最近一次修复它的安装。
 *
 * `@deepseek-ai/dsh` CLI 包「只」通过 home 锚点探测：
 * 插件从不 import 它。任何失败都退化成`undefined`，
 * 而闸门把未知版本视为「满足要求」——探测失手绝不能让正常运行的部署失效。
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** 与 harness 发布同步升版本的库包。 */
const LIBRARY_PROBE_PACKAGES = ['@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session'] as const

/** 运行期锚点的探测顺序：先探 Host 那一半在运行时 import 的包
 * （host/fold.ts 会 import 它，所以只要本插件在运行它就必须能解析），然后才是它的同级包。 */
const RUNNING_PROBE_PACKAGES = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection'] as const

/** home 锚点的探测顺序：先试 `@deepseek-ai/dsh` CLI，因为它最直接地携带发布版本，
 * 再回落到那些库包。 */
const HOME_PROBE_PACKAGES = ['@deepseek-ai/dsh', ...LIBRARY_PROBE_PACKAGES] as const

/**
 * 本包的根目录；落在它下面的运行期锚点见证属于插件自己的依赖闭包，
 * 而不是 harness。
 *
 * 通过包自身的 `./package.json` 自引用来定位，
 * 因此无论源码树还是打包安装，得到的都是包根。
 * 无法自解析的 loader 回落到本模块自己的目录：守卫覆盖面小一些，
 * 但同样不会把插件自己的 `node_modules` 误认成 harness。
 */
function ownPackageRoot(): string {
  try {
    return dirname(fileURLToPath(import.meta.resolve('dsh-cost-breakdown/package.json')))
  } catch {
    /* v8 ignore next -- 连自己包已发布的子路径都解析不了的 loader 不在测试套件的覆盖范围内；
       这个回落保留了唯一的探测路径（探
       测无果时无论哪条路都按放行处理）。*/
    return dirname(fileURLToPath(import.meta.url))
  }
}
const PLUGIN_ROOT = ownPackageRoot()

type Resolve = (specifier: string) => string
type ResolveUrl = (specifier: string) => string

/** manifest 里的版本；名称不匹配就拒绝，
 * 树中别处被提升的同名包因此无法替本包作答。 */
function versionOfManifest(manifestPath: string, expectedName?: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as { name?: unknown; version?: unknown }
    if (expectedName !== undefined && record.name !== expectedName) return undefined
    return typeof record.version === 'string' && record.version !== '' ? record.version : undefined
  } catch {
    return undefined
  }
}

function versionViaManifest(resolve: Resolve, packageName: string): string | undefined {
  try {
    return versionOfManifest(resolve(packageName + '/package.json'))
  } catch {
    // export map 没有发布该子路径（或者这个包根本不存在）。
    return undefined
  }
}

/** 通过包的入口点探测，再向上找到所属 manifest：
 * 打包成可执行文件的代理带着真实版本，却只导出入口桩，
 * 而 Node 的 exports 关卡又不放行直接访问 `./package.json` 子路径。 */
function versionViaEntry(resolve: Resolve, packageName: string): string | undefined {
  let dir: string
  try {
    dir = dirname(resolve(packageName))
  } catch {
    return undefined
  }
  for (;;) {
    const version = versionOfManifest(join(dir, 'package.json'), packageName)
    if (version !== undefined) return version
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 读取第一个能作答的包的 manifest，优先走直接子路径；只有在当前锚点上找不到的包
 * 才会落到下一个。 */
function probeAnchor(resolve: Resolve, packageNames: readonly string[]): string | undefined {
  for (const packageName of packageNames) {
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

/** `candidate` 是否位于 `root` 的目录树内。以 `..` 开头的相对路径表示逃逸，
 * 跨盘符时 `relative()` 会返回绝对路径，同样按逃逸拒绝。 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/** 运行期模块树给出的答案；不可信时返回 undefined：落在插件自己闭包里的见证是插件自身的依赖，
 * 而可信见证若读不出 manifest，同样不算答案。 */
function probeRunningTree(resolve: Resolve, pluginRoot: string): string | undefined {
  for (const packageName of RUNNING_PROBE_PACKAGES) {
    let witness: string
    try {
      witness = resolve(packageName)
    } catch {
      // 当前锚点上没有；下一个包仍可能作答。
      continue
    }
    if (isInside(pluginRoot, witness)) continue
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

/** 运行期锚点，即 Node 对本包自身的解析。 */
function resolveRunningModule(specifier: string): string {
  return import.meta.resolve(specifier)
}

/** 本进程实际生效的 harness 版本；没有锚点能作答时返回 undefined。闸门把 undefined 视为满足要求，
 * 因此探测失败只能保持沉默，不能乱猜。 */
export function detectHarnessVersion(
  ctx: Context,
  resolveUrl: ResolveUrl = resolveRunningModule,
  pluginRoot: string = PLUGIN_ROOT,
): string | undefined {
  // 非 file: 的 URL（非同寻常的 loader）在磁盘上没有 manifest，因此由 home 锚点作答。
  const running = probeRunningTree((specifier) => {
    const url = resolveUrl(specifier)
    if (!url.startsWith('file:')) throw new Error(`dsh-cost-breakdown: non-file module URL for ${specifier}`)
    return fileURLToPath(url)
  }, pluginRoot)
  if (running !== undefined) return running
  try {
    // app-boot 的 home 解析器；service 缺失或敌意时探测无果。
    const homePath = ctx.get('dshHomePath') as unknown
    if (typeof homePath === 'function') {
      const req = createRequire((homePath as (...segments: string[]) => string)('profiles', 'dsh-cost-breakdown-version-probe.cjs'))
      const home = probeAnchor(specifier => req.resolve(specifier), HOME_PROBE_PACKAGES)
      if (home !== undefined) return home
    }
  } catch { /* nothing answered; the gate fails open */ }
  return undefined
}
