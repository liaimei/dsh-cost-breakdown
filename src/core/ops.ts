/**
 * File-operation derivation — the single source of "what did the agent do to files".
 *
 * Input is a settled file-tool call (a `tool/call` plus its `tool/result`); the host fold uses it
 * to build the operation log, and the browser re-derives the same rows when it has to join
 * inline from the conversation window instead of the detail payload.
 *
 * Line counts are read from the call **arguments**, never from the result payload: the result may
 * be truncated, and a truncated read must not be reported as a small change.
 */

import type { FileOp } from '../wire/model'

/** Coverage matches the harness's built-in tools on every supported baseline (`read`,
 * `read_image`, `write`, `edit`, `grep`, `glob`) plus `str_replace_editor`. */

/** Parsed call arguments, or `null` when the raw string is absent, not JSON, or not an object —
 * a truncated oversized bash payload must not break the fold. */
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

const KIND_BY_TOOL: Record<string, FileOp['kind']> = {
  read: 'read',
  read_image: 'read',
  write: 'write',
  edit: 'write',
  grep: 'search',
  glob: 'search',
}

/** Plain tool → kind map (no `str_replace_editor`, whose kind depends on its command). */
export function kindOfTool(tool: string | undefined): FileOp['kind'] | null {
  if (tool === undefined) return null
  return KIND_BY_TOOL[tool] ?? null
}

/** The file purpose of one call: `str_replace_editor` counts as a read only for `view`, every
 * other command as a write (a call with an unknown command already failed and keeps its error). */
export function kindOfCall(tool: string, args: Record<string, unknown> | null): FileOp['kind'] | null {
  if (tool === 'str_replace_editor') {
    return args !== null && args.command === 'view' ? 'read' : 'write'
  }
  return kindOfTool(tool)
}

/** Whether a call's arguments can yield operations. */
export function mayTouchFiles(tool: string): boolean {
  return tool === 'str_replace_editor' || kindOfTool(tool) !== null
}

/** Tools whose raw arguments the fold must keep: the file tools above, plus `run_code` (whose
 * `description` labels the operations its nested dispatches register). */
export function needsRawArgs(tool: string): boolean {
  return mayTouchFiles(tool) || tool === 'run_code'
}

/** The operation's target path; for a path-less search, the pattern itself. */
export function pathOfArgs(tool: string, args: Record<string, unknown> | null): string | null {
  if (args === null) return null
  if (tool === 'grep' || tool === 'glob') {
    const path = args.path
    if (typeof path === 'string' && path !== '') return path
    const pattern = args.pattern
    return typeof pattern === 'string' && pattern !== '' ? pattern : null
  }
  for (const key of ['file_path', 'filePath', 'path']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/** Line count of a text fragment. A trailing newline does not start another line. */
export function lineCount(text: string): number {
  if (text === '') return 0
  let breaks = 0
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') breaks++
  return text.endsWith('\n') ? breaks : breaks + 1
}

function pairOf(added: unknown, removed: unknown): { added: number; removed: number } {
  return {
    added: typeof added === 'string' ? lineCount(added) : 0,
    removed: typeof removed === 'string' ? lineCount(removed) : 0,
  }
}

/** The signed line footprint of one call: `edit` removes the old string and adds the new one,
 * `write` only counts the added content (the previous body is not in the arguments). */
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

/** The exact read window a result's meta reports (`offset` plus the retained `lines`); `null`
 * for foreign or malformed meta. */
function readWindowOf(meta: unknown): { start: number; count: number } | null {
  if (meta === null || typeof meta !== 'object') return null
  const record = meta as { path?: unknown; offset?: unknown; lines?: unknown }
  if (typeof record.path !== 'string' || record.path === '') return null
  if (typeof record.offset !== 'number' || !Number.isFinite(record.offset) || record.offset < 1) return null
  if (!Array.isArray(record.lines) || record.lines.length === 0) return null
  return { start: record.offset, count: record.lines.length }
}

/** Read window fallback from the call's own `limit`, flagged `est` so the UI can say it is an
 * estimate rather than what the tool actually returned. */
function readEstimateOf(args: Record<string, unknown>): { count: number; est: true } | undefined {
  const limit = args.limit
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? { count: Math.floor(limit), est: true }
    : undefined
}

/** Prefer the result's exact window; fall back to the argument estimate (nested dispatches have
 * no meta at all and always take this path). */
function readOf(meta: unknown, args: Record<string, unknown>): FileOp['read'] {
  const window = readWindowOf(meta)
  if (window !== null) return window
  return readEstimateOf(args)
}

/** The searched pattern, with a parenthesised include filter when the call had one. */
function searchDetailOf(args: Record<string, unknown> | null): string | undefined {
  const pattern = args?.pattern
  if (typeof pattern !== 'string' || pattern === '') return undefined
  const include = args?.include
  return typeof include === 'string' && include !== '' ? `${pattern} (${include})` : pattern
}

/** Files a search actually reached, read from the result's display meta (grep groups hits by
 * file, glob lists paths). Only a complete list is attributable: truncated or malformed meta
 * names no file, and the call falls back to its own target. */
function searchFilesOf(meta: unknown): { path: string; hits: number }[] | null {
  if (meta === null || typeof meta !== 'object') return null
  const record = meta as { shape?: unknown; truncated?: unknown; files?: unknown; paths?: unknown }
  if (record.truncated !== false) return null
  const files: { path: string; hits: number }[] = []
  if (record.shape === 'matches' && Array.isArray(record.files)) {
    for (const file of record.files) {
      if (file === null || typeof file !== 'object') continue
      const group = file as { path?: unknown; matches?: unknown }
      if (typeof group.path === 'string' && group.path !== '' && Array.isArray(group.matches)) {
        files.push({ path: group.path, hits: group.matches.length })
      }
    }
  } else if (record.shape === 'paths' && Array.isArray(record.paths)) {
    for (const path of record.paths) {
      if (typeof path === 'string' && path !== '') files.push({ path, hits: 0 })
    }
  }
  return files.length > 0 ? files : null
}

/** Input of one operation assembly, shared by every producer (the host's call/result pairing,
 * nested Code-Mode settlement, and the browser's inline join). */
export interface CallFacts {
  seq: number
  tool: string
  argsRaw?: unknown
  meta?: unknown
  err?: boolean
  time?: number
  gone?: number
  parent?: number
  program?: string
}

/** Assemble the operations of one settled call. */
export function opsOfCall(facts: CallFacts): FileOp[] {
  // Arguments of non-file tools are never parsed; they can be huge shell payloads.
  const args = mayTouchFiles(facts.tool) ? parseCallArgs(facts.argsRaw) : null
  const kind = kindOfCall(facts.tool, args)
  if (kind === null) return []
  // Optional fields are spread only when present: an own property holding `undefined` still
  // serialises, and the client reads presence with `!== undefined`.
  const stamp: FileOp = {
    seq: facts.seq,
    kind,
    tool: facts.tool,
    err: facts.err === true,
    added: 0,
    removed: 0,
    path: '',
    ...(facts.time !== undefined ? { time: facts.time } : {}),
    ...(facts.parent !== undefined ? { parent: facts.parent } : {}),
    ...(facts.program !== undefined ? { program: facts.program } : {}),
  }
  if (kind === 'search') {
    const files = searchFilesOf(facts.meta)
    if (files !== null) {
      const detail = searchDetailOf(args)
      const target = args !== null ? pathOfArgs(facts.tool, args) : null
      const narrowed = args !== null && typeof args.path === 'string' && args.path !== ''
      const targetOps: FileOp[] = target !== null && !files.some(file => file.path === target)
        ? [{
          ...stamp,
          path: target,
          ...(narrowed && detail !== undefined ? { detail } : {}),
          ...(narrowed ? {} : { pattern: true as const }),
        }]
        : []
      return [
        ...targetOps,
        ...files.map(file => ({
          ...stamp,
          path: file.path,
          ...(detail !== undefined ? { detail } : {}),
          ...(file.hits > 0 ? { hits: file.hits } : {}),
        })),
      ]
    }
  }
  if (args === null) return []
  const path = pathOfArgs(facts.tool, args)
  if (path === null) return []
  const { added, removed } = deltaOf(facts.tool, args)
  const narrowed = typeof args.path === 'string' && args.path !== ''
  const detail = kind === 'search' && narrowed ? searchDetailOf(args) : undefined
  const read = kind === 'read' ? readOf(facts.meta, args) : undefined
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
