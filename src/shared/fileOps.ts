/**
 * 文件操作解析器——「agent 对文件做了什么」的唯一推导来源，
 * 输入是一次已结算的文件工具调用： host fold 依据持久工具生命周期登
 * 记操作日志，client 的内联生成回落分支则从对话窗口关联中重新推导。
 *
 * 工具覆盖范围在每个受支持的基线上（0.1.7-rc.2+）
 * 都与 harness 内置工具一致： read / read_image / write / edit（tool-fs）、grep / glob（tool-fs-search），
 * 外加`str_replace_editor`。
 * 行数增减是从调用 ARGUMENTS 读出的估算值，绝不用结果 payload。
 */

import type { FileOpRecord } from './types'

/** 解析后的调用参数；原始字符串缺失、不是 JSON 或不是 JSON 对象时返回 null——
 * 被截断的超大 bash payload 不能让整个 fold 中断。 */
export function parseCallArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

const KIND_BY_TOOL: Record<string, FileOpRecord['kind']> = {
  read: 'read',
  read_image: 'read',
  write: 'write',
  edit: 'write',
  grep: 'search',
  glob: 'search',
}

/** 朴素的工具到类别映射，不含 `str_replace_editor` 那种依赖 command 的分支（见 {@link kindOfCall}）。 */
export function kindOfTool(tool: string | undefined): FileOpRecord['kind'] | null {
  if (tool === undefined) return null
  return KIND_BY_TOOL[tool] ?? null
}

/** 一次已执行调用的文件用途：`str_replace_editor` 只在 `view` 时算读，其余 command 一律算写
 * （未知 command 的调用已失败，保留其错误标记）。 */
export function kindOfCall(tool: string, args: Record<string, unknown> | null): FileOpRecord['kind'] | null {
  if (tool === 'str_replace_editor') return args !== null && args.command === 'view' ? 'read' : 'write'
  return kindOfTool(tool)
}

/** 该调用的参数是否可能产生操作——{@link opsOfCall} 据此提前返回。 */
export function opBearingTool(tool: string): boolean {
  return tool === 'str_replace_editor' || kindOfTool(tool) !== null
}

/** 会产生操作的工具，外加 `run_code`——后者的 `description` 用来为其内层派发登记的操作打标签。 */
export function rawArgsNeeded(tool: string): boolean {
  return opBearingTool(tool) || tool === 'run_code'
}

/** 操作的目标路径；对无路径的搜索而言就是被搜索的 pattern 本身（全工作区搜索词）。 */
export function pathOfArgs(tool: string, args: Record<string, unknown> | null): string | null {
  if (args === null) return null
  if (tool === 'grep' || tool === 'glob') {
    const p = args.path
    if (typeof p === 'string' && p !== '') return p
    const pattern = args.pattern
    return typeof pattern === 'string' && pattern !== '' ? pattern : null
  }
  for (const k of ['file_path', 'filePath', 'path']) {
    const v = args[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/** 参数字符串的行数；末尾换行不再另起一行。 */
export function linesOf(s: string): number {
  if (s === '') return 0
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++
  return s.endsWith('\n') ? n : n + 1
}

/** 一次编辑两个字符串各自的行数；缺的一侧（write 没有前身）按 0 计。 */
function pairOf(added: unknown, removed: unknown): { added: number; removed: number } {
  return {
    added: typeof added === 'string' ? linesOf(added) : 0,
    removed: typeof removed === 'string' ? linesOf(removed) : 0,
  }
}

/** 一次调用带符号的行数足迹：edit 去掉旧串、加上新串；write 只计新增内容——
 * 原有正文从参数里看不出来。 */
function deltaOf(tool: string, args: Record<string, unknown>): { added: number; removed: number } {
  if (tool === 'edit') return pairOf(args.new_string, args.old_string)
  if (tool === 'write') return pairOf(args.content, undefined)
  if (tool === 'str_replace_editor') {
    if (args.command === 'str_replace') return pairOf(args.new_str, args.old_str)
    if (args.command === 'insert') return pairOf(args.new_str, undefined)
    if (args.command === 'create') return pairOf(args.file_text, undefined)
  }
  return { added: 0, removed: 0 }
}

/** read 结果 meta 报告的确切窗口（`offset` 加上保留下来的 `lines` 数组）；meta 外来或畸形时返回 null。 */
function readWindowOf(meta: unknown): { start: number; count: number } | null {
  if (meta === null || typeof meta !== 'object') return null
  const m = meta as { path?: unknown; offset?: unknown; lines?: unknown }
  if (typeof m.path !== 'string' || m.path === '') return null
  if (typeof m.offset !== 'number' || !Number.isFinite(m.offset) || m.offset < 1) return null
  if (!Array.isArray(m.lines) || m.lines.length === 0) return null
  return { start: m.offset, count: m.lines.length }
}

/** 从调用自身的 `limit` 参数回落的读取窗口，标记 `est`，让 UI 能说明这是估算值、
 * 而非结果实际返回的内容。 */
function readEstimateOf(args: Record<string, unknown>): { count: number; est: true } | undefined {
  const limit = args.limit
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? { count: Math.floor(limit), est: true }
    : undefined
}

/** 优先用结果的精确窗口；拿不到就回落到参数估算，仅派发产生的操作总是走这条，
 * 因为派发本身不带 meta。 */
function readOf(meta: unknown, args: Record<string, unknown>): { start: number; count: number } | { count: number; est: true } | undefined {
  const win = readWindowOf(meta)
  if (win !== null) return { start: win.start, count: win.count }
  return readEstimateOf(args)
}

/** 搜索的 pattern；若调用带了 include 过滤，则以括号附在其后。 */
function searchDetailOf(args: Record<string, unknown> | null): string | undefined {
  const pattern = args?.pattern
  if (typeof pattern !== 'string' || pattern === '') return undefined
  const include = args?.include
  return typeof include === 'string' && include !== '' ? `${pattern} (${include})` : pattern
}

/** 搜索结果确实触达的文件，从结果的展示 meta 读出（grep 按文件归组命中行，glob 列出路径）。
 * 只有完整列表才具备归因力——被截断或畸形的 meta 不点名任何文件，
 * 该调用回落到自身目标。 */
function searchFilesOf(meta: unknown): { path: string; hits: number }[] | null {
  if (meta === null || typeof meta !== 'object') return null
  const m = meta as { shape?: unknown; truncated?: unknown; files?: unknown; paths?: unknown }
  if (m.truncated !== false) return null
  const files: { path: string; hits: number }[] = []
  if (m.shape === 'matches' && Array.isArray(m.files)) {
    for (const f of m.files) {
      if (f === null || typeof f !== 'object') continue
      const group = f as { path?: unknown; matches?: unknown }
      if (typeof group.path === 'string' && group.path !== '' && Array.isArray(group.matches)) {
        files.push({ path: group.path, hits: group.matches.length })
      }
    }
  } else if (m.shape === 'paths' && Array.isArray(m.paths)) {
    for (const p of m.paths) {
      if (typeof p === 'string' && p !== '') files.push({ path: p, hits: 0 })
    }
  }
  return files.length > 0 ? files : null
}

/** 单次调用的操作装配，各生产者统一走这里（host 的 call/result 配对、
 * 嵌套 Code-Mode 结算、 client 的内联关联）。派发不带 meta，
 * 其读取窗口与按文件归因因此退化为仅凭参数的形式。 */
export function opsOfCall(input: {
  seq: number
  tool: string
  argsRaw?: unknown
  meta?: unknown
  err?: boolean
  time?: number
  gone?: number
  parent?: number
  program?: string
}): FileOpRecord[] {
  // 不产生操作的调用参数从不解析——它们可能是很大的 bash/pwsh payload。
  const args = opBearingTool(input.tool) ? parseCallArgs(input.argsRaw) : null
  const kind = kindOfCall(input.tool, args)
  if (kind === null) return []
  // 可选字段只在有值时展开：值为 `undefined` 的自有属性仍会被序列化到 wire 上，
  // 从而破坏 client 的 `!== undefined` 存在性判断。
  const stamp: FileOpRecord = {
    seq: input.seq,
    kind,
    tool: input.tool,
    err: input.err === true,
    added: 0,
    removed: 0,
    path: '',
    ...(input.time !== undefined ? { time: input.time } : {}),
    ...(input.gone !== undefined ? { gone: input.gone } : {}),
    ...(input.parent !== undefined ? { parent: input.parent } : {}),
    ...(input.program !== undefined ? { program: input.program } : {}),
  }
  // 带完整命中文件 meta 的搜索按真实文件逐条登记；调用自身的目标也单独成行
  // （「搜了什么」和「命中了什么」都算），唯一的例外是退化的单文件搜索——
  // 它的目标就是那个唯一命中文件。
  if (kind === 'search') {
    const files = searchFilesOf(input.meta)
    if (files !== null) {
      const detail = searchDetailOf(args)
      const target = args !== null ? pathOfArgs(input.tool, args) : null
      const narrowed = args !== null && typeof args.path === 'string' && args.path !== ''
      const targetOps: FileOpRecord[] = target !== null && !files.some(f => f.path === target)
        ? [{
          ...stamp,
          path: target,
          ...(narrowed && detail !== undefined ? { detail } : {}),
          ...(narrowed ? {} : { pattern: true as const }),
        }]
        : []
      return [
        ...targetOps,
        ...files.map(f => ({
          ...stamp,
          path: f.path,
          ...(detail !== undefined ? { detail } : {}),
          ...(f.hits > 0 ? { hits: f.hits } : {}),
        })),
      ]
    }
  }
  if (args === null) return []
  const path = pathOfArgs(input.tool, args)
  if (path === null) return []
  const { added, removed } = deltaOf(input.tool, args)
  const narrowed = typeof args.path === 'string' && args.path !== ''
  const detail = kind === 'search' && narrowed ? searchDetailOf(args) : undefined
  const read = kind === 'read' ? readOf(input.meta, args) : undefined
  return [{
    ...stamp,
    path,
    added,
    removed,
    ...(detail !== undefined ? { detail } : {}),
    ...(read !== undefined ? { read } : {}),
    ...(kind === 'search' && !narrowed ? { pattern: true as const } : {}),
  }]
}
