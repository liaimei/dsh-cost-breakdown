/**
 * 文件活动——agent 究竟对文件**做了什么**。op 日志这一代的 host 折叠
 * 在整个日志上为每次执行的文件操作导出一条记录
 * （shared/fileOps.ts），因此本模块只做过滤与聚合；较旧的 host
 * 不提供 `fileOps`，旧路径则改由已服务的节点结合对话窗口
 * （受窗口限制）重新推导出这些操作。
 *
 * `before` 是排他的 seq 上界（下一条请求的 seq）。
 */

import type { FileOpRecord, RequestRecord, SurfaceNode } from '../shared/types'
import { opsOfCall, parseCallArgs } from '../shared/fileOps'
// harness 中可在浏览器安全使用的文件地址层，由客户端 bundle 内联：
// 生成的地址就是预览所声明的 `dsh-resource://file/…` 拼写。
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { ConversationNodeLike } from './services'

/** 共享记录类型的别名：卡片是 `shared/fileOps.ts` 折叠输出的消费方之一，
 *  组件 import 用的就是这个名字。 */
export type FileOp = FileOpRecord

/** 折叠记账的三种操作类别；卡片按类别统计的总数以它为键。 */
export type FileOpKind = FileOpRecord['kind']

/** 路径的渲染形态：图片缩略、目录行或文本文件行。 */
export type FileForm = 'text' | 'image' | 'dir'

/** 一行聚合结果。三个计数器是各类别的操作次数，而 `added`/`removed`
 *  是行数增减，因此这一行既能显示体量也能显示改动幅度；`ops` 按最新在前保存。 */
export interface FileEntry {
  path: string
  form: FileForm
  reads: number
  writes: number
  searches: number
  added: number
  removed: number
  errs: number
  ops: FileOp[]
  /** 当 `path` 是无路径搜索的**模式**而非文件路径时置位——展示时不得把它相对化。 */
  pattern?: true
}

/** 某一类别的文件数与操作数，外加一个**横跨**三种操作类别的 `image`
 *  桶（图片是被读取的，但单独计数）。 */
export interface FileKindTotal { files: number; ops: number }

/** 卡片的完整数据集：每个路径一行，以及其上方那条总计条。 */
export interface FileActivity {
  entries: FileEntry[]
  totals: Record<FileOpKind | 'image', FileKindTotal> & { added: number; removed: number }
}

/** 先按**工具**给路径分类：对没有扩展名的路径，`read_image` 是唯一可靠的
 *  图片信号；结尾的斜杠是折叠的目录标记。 */
export function formOf(tool: string, path: string): FileForm {
  if (tool === 'read_image' || IMAGE_EXT.test(path)) return 'image'
  if (path.endsWith('/')) return 'dir'
  return 'text'
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

/** 单行的图标：emoji，或设置了 `color` 时的字母徽章，外加指明其分桶的 i18n 键。 */
export interface FileGlyph {
  glyph: string
  tip: string
  /** 语言徽章的填充色；只出现在代码文件分桶上。 */
  color?: string
  text?: string
}

/** 按路径末段匹配的目录分桶；然后是隐藏目录，最后是普通文件夹。 */
const DIR_BUCKETS: (readonly [readonly string[], string, string])[] = [
  [['test', 'tests', '__tests__', 'spec', 'specs', 'e2e'], '🧪', 'files.glyph.tests'],
  [['doc', 'docs', 'documentation'], '📚', 'files.glyph.docs'],
  [['node_modules', 'vendor', 'third_party', 'third-party', 'packages'], '📦', 'files.glyph.deps'],
  [['dist', 'build', 'out', 'target', 'release', 'debug', 'coverage', 'artifacts'], '🏗️', 'files.glyph.build'],
  [['scripts', 'tools', 'bin'], '🛠️', 'files.glyph.scripts'],
  [['config', 'configs', 'settings', '.config'], '⚙️', 'files.glyph.config'],
  [['assets', 'static', 'public', 'images', 'fonts', 'icons', 'media'], '🎨', 'files.glyph.assets'],
]

const LOCK_NAMES = ['package-lock.json', 'pnpm-lock.yaml', 'npm-shrinkwrap.json']
const MAKE_NAMES = ['makefile', 'justfile', 'cmakelists.txt']
const TEST_NAME = /(^|[^a-z0-9])test([^a-z0-9]|$)|\.test\./

/** 语言文件渲染为带该语言配色的字母徽章，优先于 emoji 分桶。 */
const CODE_LANGS: (readonly [readonly string[], string, string, string])[] = [
  [['tsx'], 'TSX', '#3178c6', 'files.glyph.lang.ts'],
  [['ts'], 'TS', '#3178c6', 'files.glyph.lang.ts'],
  [['js', 'jsx', 'mjs', 'cjs'], 'JS', '#f7df1e', 'files.glyph.lang.js'],
  [['py', 'pyi', 'pyw'], 'PY', '#3572a5', 'files.glyph.python'],
  [['ipynb'], 'NB', '#da5b0b', 'files.glyph.notebook'],
  [['go'], 'GO', '#00add8', 'files.glyph.lang.go'],
  [['rs'], 'RS', '#dea584', 'files.glyph.lang.rust'],
  [['java'], 'JV', '#b07219', 'files.glyph.lang.java'],
  [['kt', 'kts'], 'KT', '#a97bff', 'files.glyph.lang.kotlin'],
  [['rb'], 'RB', '#701516', 'files.glyph.lang.ruby'],
  [['php'], 'PHP', '#4f5d95', 'files.glyph.lang.php'],
  [['c', 'h'], 'C', '#555555', 'files.glyph.lang.c'],
  [['cpp', 'cc', 'cxx', 'hpp'], 'C++', '#f34b7d', 'files.glyph.lang.cpp'],
  [['cs'], 'C#', '#178600', 'files.glyph.lang.csharp'],
  [['scala'], 'SC', '#c22d40', 'files.glyph.lang.scala'],
  [['lua'], 'LUA', '#000080', 'files.glyph.lang.lua'],
  [['dart'], 'DA', '#00b4ab', 'files.glyph.lang.dart'],
  [['swift'], 'SW', '#f05138', 'files.glyph.lang.swift'],
  [['vue'], 'VUE', '#41b883', 'files.glyph.lang.vue'],
  [['svelte'], 'SV', '#ff3e00', 'files.glyph.lang.svelte'],
  [['sh', 'bash', 'zsh', 'fish', 'ps1'], 'SH', '#89e051', 'files.glyph.shell'],
  [['html', 'htm', 'xhtml'], 'HT', '#e34c26', 'files.glyph.lang.html'],
  [['css', 'scss', 'sass', 'less', 'styl'], 'CSS', '#563d7c', 'files.glyph.style'],
  [['sql'], 'SQL', '#e38c00', 'files.glyph.database'],
]

/** 按填充色亮度决定徽章文字：深色底用白色，浅色底用近黑（绝不用纯黑）。 */
function badgeTextColor(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const luminance = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return luminance < 0.6 ? '#ffffff' : '#1f2328'
}

const EXT_BUCKETS: (readonly [readonly string[], string, string])[] = [
  [['yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env'], '⚙️', 'files.glyph.config'],
  [['json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'xml'], '🧾', 'files.glyph.data'],
  [['md', 'mdx', 'markdown', 'rst', 'adoc', 'org'], '📝', 'files.glyph.markdown'],
  [['log'], '📜', 'files.glyph.log'],
  [['csv', 'tsv', 'xls', 'xlsx', 'ods'], '📊', 'files.glyph.sheet'],
  [['pdf', 'doc', 'docx', 'odt', 'rtf'], '📕', 'files.glyph.document'],
  [['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar'], '🗜️', 'files.glyph.archive'],
  [['ttf', 'otf', 'woff', 'woff2', 'eot'], '🔤', 'files.glyph.font'],
  [['mp4', 'mov', 'mkv', 'webm', 'mp3', 'wav', 'flac', 'ogg'], '🎬', 'files.glyph.media'],
]

function dirGlyph(base: string): FileGlyph {
  if (base === '' || base === '.') return { glyph: '🏠', tip: 'files.glyph.root' }
  const name = base.toLowerCase()
  for (const [names, glyph, tip] of DIR_BUCKETS) {
    if (names.includes(name)) return { glyph, tip }
  }
  if (name.startsWith('.')) return { glyph: '🗄️', tip: 'files.glyph.hidden' }
  return { glyph: '📁', tip: 'files.form.dir' }
}

function fileGlyph(base: string): FileGlyph {
  const name = base.toLowerCase()
  const dot = name.lastIndexOf('.')
  // 位置 0 的点是点文件而非扩展名——下面的 `.env` 是按名字判断的。
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  if (name.endsWith('.lock') || LOCK_NAMES.includes(name)) return { glyph: '🔒', tip: 'files.glyph.lock' }
  if (TEST_NAME.test(name)) return { glyph: '🧪', tip: 'files.glyph.tests' }
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return { glyph: '🐳', tip: 'files.glyph.docker' }
  if (MAKE_NAMES.includes(name)) return { glyph: '🛠️', tip: 'files.glyph.scripts' }
  if (name === '.gitignore' || name === '.gitattributes') return { glyph: '🚫', tip: 'files.glyph.ignore' }
  if (name === 'license' || name.startsWith('license.') || name === 'copying') return { glyph: '⚖️', tip: 'files.glyph.license' }
  if (name === '.env' || name.startsWith('.env.')) return { glyph: '⚙️', tip: 'files.glyph.config' }
  if (ext !== '') {
    for (const [exts, label, color, tip] of CODE_LANGS) {
      if (exts.includes(ext)) return { glyph: label, tip, color, text: badgeTextColor(color) }
    }
    for (const [exts, glyph, tip] of EXT_BUCKETS) {
      if (exts.includes(ext)) return { glyph, tip }
    }
  }
  return { glyph: '📄', tip: 'files.form.text' }
}

/** 某个路径的行图标。分支由 `form` 决定，且只看 basename
 *  （绝不看中间目录），因此 `src/utils/test-data.ts` 不会被误判成测试文件。 */
export function glyphOf(path: string, form: FileForm): FileGlyph {
  if (form === 'image') return { glyph: '🖼', tip: 'files.form.image' }
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return form === 'dir' ? dirGlyph(base) : fileGlyph(base)
}

const DRIVE_PATH = /^[a-zA-Z]:[\\/]/

/** 真实文件路径的绝对形式：本身就是绝对路径时原样返回；
 * 相对路径基于工作区根解析；相对路径没有可解析的根时返回 undefined。 */
export function absPathOf(path: string, workspace: string | undefined): string | undefined {
  if (path.startsWith('/') || DRIVE_PATH.test(path)) return path
  if (workspace === undefined || workspace === '' || path.startsWith('.')) return undefined
  return workspace.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '')
}

/** 按 session 限定的 `dsh-resource://file/…` 预览地址，由 harness
 * 自己的 `fileAddressFor` 构建，因此通往同一文件的每条路径都会落到同一个
 * 标签页。搜索模式、目录、缺失的 session 或被编码器拒绝的路径返回 undefined。 */
export function previewAddressOf(
  path: string,
  form: FileForm,
  pattern: boolean | undefined,
  sessionId: string | undefined,
  workspace: string | undefined,
): string | undefined {
  if (pattern === true || form === 'dir' || sessionId === undefined || sessionId === '') return undefined
  try {
    return fileAddressFor(sessionId, workspace, path)
  } catch {
    // 不可信日志路径里的孤立代理项会导致 URI 编码失败：不可预览，但绝不让渲染抛错。
    return undefined
  }
}

/** 该行的展示路径：位于工作区内（或本就是工作区相对路径）
 * 的缩成以 './' 开头的相对路径；其他形式原样保留。 */
export function displayPathOf(path: string, workspace: string | undefined): string {
  const root = workspace !== undefined && workspace.length > 1 ? workspace.replace(/\/+$/, '') : undefined
  if (root !== undefined) {
    if (path === root) return './'
    if (path.startsWith(root + '/')) return './' + path.slice(root.length + 1)
  }
  if (path.startsWith('/') || DRIVE_PATH.test(path) || path.startsWith('.')) return path
  return './' + path
}

/** 把 op 记录折叠成按文件的活动：按作用域过滤、按路径聚合、操作最新在前。 */
function aggregateOps(ops: readonly FileOp[], before: number | null): FileActivity {
  const totals: FileActivity['totals'] = {
    read: { files: 0, ops: 0 },
    write: { files: 0, ops: 0 },
    search: { files: 0, ops: 0 },
    image: { files: 0, ops: 0 },
    added: 0,
    removed: 0,
  }
  const byPath = new Map<string, FileEntry>()
  for (const op of ops) {
    // 嵌套 op 的作用域键是其父结果的 seq，因此那里 `before` 是按**父**的
    // seq 切割：拿 op 自己的 seq 比较会把单步之内的工作切碎。
    const key = op.parent ?? op.seq
    if (before !== null && key >= before) continue
    totals[op.kind].ops++
    let entry = byPath.get(op.path)
    if (entry === undefined) {
      entry = {
        path: op.path,
        form: formOf(op.tool, op.path),
        reads: 0,
        writes: 0,
        searches: 0,
        added: 0,
        removed: 0,
        errs: 0,
        ops: [],
        ...(op.pattern === true ? { pattern: true as const } : {}),
      }
      byPath.set(op.path, entry)
    }
    if (op.kind === 'read') entry.reads++
    else if (op.kind === 'write') entry.writes++
    else entry.searches++
    entry.added += op.added
    entry.removed += op.removed
    if (op.err) entry.errs++
    entry.ops.push(op)
  }
  const entries = [...byPath.values()]
  for (const e of entries) {
    // 每行最新在前：展开的详情把最近一次操作列在最上面，
    // 与折叠自身的 seq 顺序一致，尽管 op 到达时是最旧在前。
    e.ops.sort((a, b) => b.seq - a.seq)
    if (e.reads > 0) totals.read.files++
    if (e.writes > 0) totals.write.files++
    if (e.searches > 0) totals.search.files++
    if (e.form === 'image') {
      totals.image.files++
      totals.image.ops += e.ops.length
    }
    totals.added += e.added
    totals.removed += e.removed
  }
  // 各行按最新一次操作排序，卡片因此读起来像一份新旧排行；`ops`
  // 保证非空，因为每个条目都是靠 push 进它才创建的。
  entries.sort((a, b) => b.ops[0].seq - a.ops[0].seq)
  return { entries, totals }
}

/** op 日志这一代对卡片的读取：用折叠导出的记录，`gone` 在渲染时从 detail 的归档中连接进来。
 */
export function activityOfOps(ops: readonly FileOpRecord[], archive: readonly SurfaceNode[], before: number | null): FileActivity {
  const goneBySeq = new Map<number, number>()
  // op 记录里没有 `gone`：host 折叠的记录不带驱逐时刻，因此它按 op 的
  // **作用域** seq（嵌套 op 即父结果）从归档节点连接进来。
  for (const n of archive) if (n.gone !== undefined) goneBySeq.set(n.seq, n.gone)
  const joined = ops.map((op) => {
    const gone = goneBySeq.get(op.parent ?? op.seq)
    // 自己已记录 `gone` 的 op 优先：它来自一次知情的折叠。
    return gone !== undefined && op.gone === undefined ? { ...op, gone } : op
  })
  return aggregateOps(joined, before)
}

interface SubCall {
  name: string
  argsRaw: string
  seq: number
  time?: number
  err: boolean
  subCalls?: readonly unknown[]
}

/** 把节点 `subCalls` 树中的某个块收窄成一次已敲定的嵌套调用；仍在运行或格式错误的块丢弃。 */
function subCallOf(block: unknown): SubCall | null {
  const b = block as Record<string, unknown>
  if (b.kind !== 'tool-result') return null
  if (b.call === null || typeof b.call !== 'object') return null
  const call = b.call as { name?: unknown; argsRaw?: unknown }
  if (typeof call.name !== 'string' || typeof call.argsRaw !== 'string') return null
  if (typeof b.seq !== 'number' || !Number.isFinite(b.seq)) return null
  return {
    name: call.name,
    argsRaw: call.argsRaw,
    seq: b.seq,
    ...(typeof b.time === 'number' ? { time: b.time } : {}),
    ...(b.isError === true ? { err: true } : { err: false }),
    ...(Array.isArray(b.subCalls) ? { subCalls: b.subCalls } : {}),
  }
}

/** run_code 调用中由模型撰写的描述——嵌套操作的「为什么」。 */
function programOf(conv: ConversationNodeLike | undefined): string | undefined {
  const description = parseCallArgs(conv?.call?.argsRaw)?.description
  return typeof description === 'string' && description !== '' ? description : undefined
}

/** 嵌套 Code-Mode 树的深度护栏：SDK 绑定排除了 `run_code` 自身，因此真实树只有一层深。 */
const SUBCALL_MAX_DEPTH = 8

/** 旧路径的嵌套遍历：每个已敲定且参数能解析出文件目标的子派发
 * 记一次操作，并挂在父 run_code 结果上。`seen`
 * 保存已访问的块，畸形的环状连接因此无法造成死循环。 */
function foldSubCalls(
  blocks: readonly unknown[],
  parent: SurfaceNode,
  program: string | undefined,
  ops: FileOp[],
  seen: Set<object>,
  depth: number,
): void {
  if (depth > SUBCALL_MAX_DEPTH) return
  for (const block of blocks) {
    // `seen` 是每个顶层节点一份（由调用方创建），既覆盖环，也覆盖重复
    // 块——否则重跑的折叠会把同一个块记两次。
    if (block === null || typeof block !== 'object' || seen.has(block)) continue
    seen.add(block)
    const sub = subCallOf(block)
    if (sub !== null) {
      ops.push(...opsOfCall({
        seq: sub.seq,
        tool: sub.name,
        argsRaw: sub.argsRaw,
        err: sub.err,
        ...(sub.time !== undefined ? { time: sub.time } : {}),
        ...(parent.gone !== undefined ? { gone: parent.gone } : {}),
        parent: parent.seq,
        ...(program !== undefined ? { program } : {}),
      }))
      if (sub.subCalls !== undefined) foldSubCalls(sub.subCalls, parent, program, ops, seen, depth + 1)
    }
  }
}

/** 内联生成方式从已服务节点结合对话窗口（受窗口限制）的推导。
 * 折叠某个节点时抛出的任何异常都只丢掉该节点，遍历继续。 */
export function activityOf(
  nodes: SurfaceNode[],
  convOf: (seq: number) => ConversationNodeLike | undefined,
  before: number | null,
): FileActivity {
  const ops: FileOp[] = []
  for (const n of nodes) {
    if (n.cat !== 'tool') continue
    if (before !== null && n.seq >= before) continue
    const tool = n.tool
    if (tool === undefined) continue
    try {
      const conv = convOf(n.seq)
      ops.push(...opsOfCall({
        seq: n.seq,
        tool,
        argsRaw: conv?.call?.argsRaw,
        meta: conv?.meta,
        err: n.err === true || conv?.isError === true,
        ...(n.time !== undefined ? { time: n.time } : {}),
        ...(n.gone !== undefined ? { gone: n.gone } : {}),
      }))
      // 嵌套的 Code-Mode 调用（PTC）：一次已敲定的子派发记一次操作。
      const subCalls = conv?.subCalls
      if (subCalls !== undefined && subCalls.length > 0) {
        foldSubCalls(subCalls, n, programOf(conv), ops, new Set<object>(), 1)
      }
    } catch {
      // 这个兜底存在，是为了让畸形的连接数据永远无关紧要。
    }
  }
  return aggregateOps(ops, null)
}

/** 其 surface **展示**了某个 op 结果节点的浏览器步骤：在该结果仍存活时其后派发的第一条请求。 */
export function locateStepOf(requests: RequestRecord[], seq: number, gone: number | undefined): number | 'live' | null {
  for (const r of requests) {
    if (r.seq > seq && (gone === undefined || gone > r.seq)) return r.seq
  }
  return gone === undefined ? 'live' : null
}
