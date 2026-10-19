/**
 * File activity: what the agent touched, grouped by path, with the glyphs and path forms the card renders.
 *
 * The fold already derives the operation log (`core/ops.ts`); this module answers the card's questions about
 * it: which file, what kind, how many operations, how many lines, and — for the row's icon — what sort of thing
 * it is. The one rule that runs through both: a **search pattern is not a path**, so it is never relativised
 * against the workspace and never carries a file glyph.
 */

import type { FileOp } from '../../wire/model'

/** The three operation kinds, plus `image`, which is a read but is counted apart. */
export type FileOpKind = FileOp['kind']

/** How a row's path should be read: a file, a directory, or an image. */
export type FileForm = 'text' | 'dir' | 'image'

/** One path's aggregate. */
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
  /** Set when `path` is a search **pattern** rather than a path: such a row is never relativised. */
  pattern?: true
}

/** One kind's file and operation counts. */
export interface FileKindTotal { files: number; ops: number }

/** The card's dataset: one row per path, plus the totals strip above them. */
export interface FileActivity {
  entries: FileEntry[]
  /** Per-kind file/operation counts, plus the cross-kind line totals. */
  totals: {
    read: FileKindTotal
    write: FileKindTotal
    search: FileKindTotal
    /** Images are reads, counted apart because the card shows them in their own cell. */
    image: FileKindTotal
    added: number
    removed: number
  }
}

/** Classify a path: `read_image` is the only reliable image signal for an extension-less path, and a trailing
 * slash is the fold's directory marker. */
export function formOf(tool: string, path: string): FileForm {
  if (tool === 'read_image' || IMAGE_EXTENSION.test(path)) return 'image'
  if (path.endsWith('/')) return 'dir'
  return 'text'
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i

/** A row's icon: an emoji, or a lettered badge when a language colour is available, plus the i18n key that
 * names its bucket. */
export interface FileGlyph {
  glyph: string
  tip: string
  /** Fill colour for a language badge; only code-file buckets set it. */
  color?: string
  text?: string
}

/** Directory buckets, matched on the last segment. Hidden directories come next, plain folders last. */
const DIRECTORY_BUCKETS: ReadonlyArray<readonly [readonly string[], string, string]> = [
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

/** Languages render as a lettered badge in their own colour, ahead of the emoji buckets. */
const CODE_LANGUAGES: ReadonlyArray<readonly [readonly string[], string, string, string]> = [
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

/** Badge text colour from the fill's luminance: white on dark, near-black on light (never pure black). */
function badgeText(hex: string): string {
  const value = parseInt(hex.slice(1), 16)
  const luminance = (0.299 * ((value >> 16) & 255) + 0.587 * ((value >> 8) & 255) + 0.114 * (value & 255)) / 255
  return luminance < 0.6 ? '#ffffff' : '#1f2328'
}

const EXTENSION_BUCKETS: ReadonlyArray<readonly [readonly string[], string, string]> = [
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

function directoryGlyph(base: string): FileGlyph {
  if (base === '' || base === '.') return { glyph: '🏠', tip: 'files.glyph.root' }
  const name = base.toLowerCase()
  for (const [names, glyph, tip] of DIRECTORY_BUCKETS) {
    if (names.includes(name)) return { glyph, tip }
  }
  if (name.startsWith('.')) return { glyph: '🗄️', tip: 'files.glyph.hidden' }
  return { glyph: '📁', tip: 'files.form.dir' }
}

function fileGlyph(base: string): FileGlyph {
  const name = base.toLowerCase()
  const dot = name.lastIndexOf('.')
  // A leading dot is a dot-file rather than an extension; `.env` is matched by name below.
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  if (name.endsWith('.lock') || LOCK_NAMES.includes(name)) return { glyph: '🔒', tip: 'files.glyph.lock' }
  if (TEST_NAME.test(name)) return { glyph: '🧪', tip: 'files.glyph.tests' }
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return { glyph: '🐳', tip: 'files.glyph.docker' }
  if (MAKE_NAMES.includes(name)) return { glyph: '🛠️', tip: 'files.glyph.scripts' }
  if (name === '.gitignore' || name === '.gitattributes') return { glyph: '🚫', tip: 'files.glyph.ignore' }
  if (name === 'license' || name.startsWith('license.') || name === 'copying') return { glyph: '⚖️', tip: 'files.glyph.license' }
  if (name === '.env' || name.startsWith('.env.')) return { glyph: '⚙️', tip: 'files.glyph.config' }
  if (extension !== '') {
    for (const [extensions, label, color, tip] of CODE_LANGUAGES) {
      if (extensions.includes(extension)) return { glyph: label, tip, color, text: badgeText(color) }
    }
    for (const [extensions, glyph, tip] of EXTENSION_BUCKETS) {
      if (extensions.includes(extension)) return { glyph, tip }
    }
  }
  return { glyph: '📄', tip: 'files.form.text' }
}

/** A row's glyph. The branch is decided by `form` and only the basename is inspected, so
 * `src/utils/test-data.ts` is never mistaken for a test file. */
export function glyphOf(path: string, form: FileForm): FileGlyph {
  if (form === 'image') return { glyph: '🖼', tip: 'files.form.image' }
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return form === 'dir' ? directoryGlyph(base) : fileGlyph(base)
}

const DRIVE_PATH = /^[a-zA-Z]:[\\/]/

/** The absolute form of a real path: an absolute path is returned as-is, a relative one is resolved against
 * the workspace root, and a relative one with no root to resolve against is `undefined`. */
export function absPathOf(path: string, workspace: string | undefined): string | undefined {
  if (path.startsWith('/') || DRIVE_PATH.test(path)) return path
  if (workspace === undefined || workspace === '' || path.startsWith('.')) return undefined
  return `${workspace.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * The row's display path.
 *
 * A path inside the workspace (or already workspace-relative) reads with the `./` prefix that makes its
 * relationship to the root obvious; anything else — an absolute path outside the workspace, a pattern — is
 * printed as it is.
 */
export function displayPathOf(path: string, workspace: string | undefined): string {
  const root = workspace !== undefined && workspace.length > 1 ? workspace.replace(/\/+$/, '') : undefined
  if (root !== undefined) {
    if (path === root) return './'
    if (path.startsWith(`${root}/`)) return `./${path.slice(root.length + 1)}`
  }
  if (path.startsWith('/') || DRIVE_PATH.test(path) || path.startsWith('.')) return path
  return `./${path}`
}

/**
 * Fold the operation log into per-path activity, filtered by scope and newest-first.
 *
 * `before` is an exclusive seq cut. A **nested** Code-Mode operation is scoped by its parent result's seq, so
 * the cut compares against `parent` where there is one: comparing the op's own seq would slice a single step's
 * work in two.
 */
export function aggregateOps(ops: readonly FileOp[], before: number | null): FileActivity {
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
    const key = op.parent ?? op.seq
    if (before !== null && key >= before) continue
    const form = formOf(op.tool, op.path)
    const entry = byPath.get(op.path) ?? {
      path: op.path,
      form,
      reads: 0,
      writes: 0,
      searches: 0,
      added: 0,
      removed: 0,
      errs: 0,
      ops: [],
      ...(op.pattern === true ? { pattern: true as const } : {}),
    }
    entry.ops.push(op)
    if (op.kind === 'read') entry.reads++
    else if (op.kind === 'write') entry.writes++
    else entry.searches++
    entry.added += op.added
    entry.removed += op.removed
    if (op.err) entry.errs++
    byPath.set(op.path, entry)
  }
  for (const entry of byPath.values()) {
    totals.added += entry.added
    totals.removed += entry.removed
    if (entry.form === 'image' && entry.reads > 0) {
      totals.image.files++
      totals.image.ops += entry.reads
    }
    if (entry.reads > 0) {
      totals.read.files++
      totals.read.ops += entry.reads
    }
    if (entry.writes > 0) {
      totals.write.files++
      totals.write.ops += entry.writes
    }
    if (entry.searches > 0) {
      totals.search.files++
      totals.search.ops += entry.searches
    }
  }
  // Newest first: the card's list is a log, and the reader is usually looking at what just happened.
  const entries = [...byPath.values()].sort((left, right) => {
    const leftLatest = left.ops[left.ops.length - 1]?.seq ?? 0
    const rightLatest = right.ops[right.ops.length - 1]?.seq ?? 0
    return rightLatest - leftLatest
  })
  return { entries, totals }
}

/** The tool tally of one step's context: how many times each tool produced a result, for the browser's tool
 * rows. */
export function toolTallyOf(entries: ReadonlyArray<{ cat: string; tool?: string }>): Map<string, number> {
  const tally = new Map<string, number>()
  for (const entry of entries) {
    if (entry.cat !== 'tool' && !(entry.cat === 'skill' && entry.tool !== undefined)) continue
    const name = entry.tool ?? '?'
    tally.set(name, (tally.get(name) ?? 0) + 1)
  }
  return tally
}
