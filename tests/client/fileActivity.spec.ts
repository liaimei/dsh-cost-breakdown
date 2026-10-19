/**
 * File activity: path forms, glyph buckets, absolute/display paths, and the per-path fold.
 *
 * The rules pinned here are the ones a reader would notice: a search pattern is not a path (so it is never
 * relativised and never carries a file glyph), a language file gets its own coloured badge, and a nested
 * Code-Mode operation is scoped by its parent's seq so a single step's work is not sliced in two.
 */

import { describe, expect, it } from 'vitest'
import {
  absPathOf, aggregateOps, displayPathOf, formOf, glyphOf, toolTallyOf,
} from '../../src/client/data/fileActivity'
import type { FileOp } from '../../src/wire/model'

/** One operation record. */
function op(overrides: Partial<FileOp> & Pick<FileOp, 'seq' | 'path' | 'kind'>): FileOp {
  return { tool: 'read', err: false, added: 0, removed: 0, ...overrides }
}

describe('formOf', () => {
  it('classifies by tool, extension and trailing slash', () => {
    expect(formOf('read_image', 'no-extension')).toBe('image')
    expect(formOf('read', '/a/b.png')).toBe('image')
    expect(formOf('read', '/a/dir/')).toBe('dir')
    expect(formOf('read', '/a/b.ts')).toBe('text')
  })
})

describe('glyphOf', () => {
  it('gives a language file its own coloured badge', () => {
    const glyph = glyphOf('/a/b.ts', 'text')
    expect(glyph.glyph).toBe('TS')
    expect(glyph.color).toBe('#3178c6')
    // White on a dark fill.
    expect(glyph.text).toBe('#ffffff')
  })

  it('matches on the basename only', () => {
    // The `tests` *directory* must not turn an ordinary file into a test file ...
    expect(glyphOf('src/tests/helpers.ts', 'text').tip).toBe('files.glyph.lang.ts')
    // ... while a test marker in the basename does bucket it.
    expect(glyphOf('src/helpers.test.ts', 'text').tip).toBe('files.glyph.tests')
  })

  it('buckets directories, dot-directories and images', () => {
    expect(glyphOf('node_modules/', 'dir').tip).toBe('files.glyph.deps')
    expect(glyphOf('.git/', 'dir').tip).toBe('files.glyph.hidden')
    expect(glyphOf('x.png', 'image').glyph).toBe('🖼')
    expect(glyphOf('x.lock', 'text').glyph).toBe('🔒')
    expect(glyphOf('Dockerfile', 'text').glyph).toBe('🐳')
  })
})

describe('path forms', () => {
  it('resolves a relative path against the workspace and leaves absolute ones alone', () => {
    expect(absPathOf('src/a.ts', '/w')).toBe('/w/src/a.ts')
    expect(absPathOf('/abs/a.ts', '/w')).toBe('/abs/a.ts')
    expect(absPathOf('src/a.ts', undefined)).toBeUndefined()
    // A dotted relative path is relative to the process, not the workspace: it cannot be resolved.
    expect(absPathOf('./a.ts', '/w')).toBeUndefined()
  })

  it('displays workspace paths with the ./ prefix and leaves others verbatim', () => {
    expect(displayPathOf('/w/src/a.ts', '/w')).toBe('./src/a.ts')
    expect(displayPathOf('/w', '/w')).toBe('./')
    expect(displayPathOf('/etc/passwd', '/w')).toBe('/etc/passwd')
    expect(displayPathOf('src/a.ts', undefined)).toBe('./src/a.ts')
  })
})

describe('aggregateOps', () => {
  it('groups by path and counts each kind', () => {
    const activity = aggregateOps([
      op({ seq: 1, path: '/a.ts', kind: 'read', tool: 'read' }),
      op({ seq: 2, path: '/a.ts', kind: 'write', tool: 'edit', added: 3, removed: 1 }),
      op({ seq: 3, path: 'needle', kind: 'search', tool: 'grep', pattern: true }),
    ], null)
    const file = activity.entries.find(entry => entry.path === '/a.ts')
    expect(file).toMatchObject({ reads: 1, writes: 1, added: 3, removed: 1 })
    expect(activity.totals.added).toBe(3)
    // The pattern row keeps its marker so the card never relativises it.
    expect(activity.entries.find(entry => entry.path === 'needle')?.pattern).toBe(true)
  })

  it('cuts at `before`, scoping a nested op by its parent', () => {
    // The cut at 6 keeps everything before it. The nested op at seq 9 belongs to step 5, so it is inside the
    // cut even though its own seq is later — the point of scoping by `parent`.
    const activity = aggregateOps([
      op({ seq: 1, path: '/a.ts', kind: 'read' }),
      op({ seq: 5, path: '/b.ts', kind: 'write' }),
      // A nested dispatch: its own seq is later, but it belongs to the step of its parent.
      op({ seq: 9, path: '/c.ts', kind: 'read', parent: 5 }),
    ], 6)
    expect(activity.entries.map(entry => entry.path)).toEqual(['/c.ts', '/b.ts', '/a.ts'])
  })

  it('drops a nested op whose parent is past the cut', () => {
    const activity = aggregateOps([
      op({ seq: 1, path: '/a.ts', kind: 'read' }),
      op({ seq: 9, path: '/c.ts', kind: 'read', parent: 8 }),
    ], 6)
    expect(activity.entries.map(entry => entry.path)).toEqual(['/a.ts'])
  })

  it('counts images apart from reads', () => {
    const activity = aggregateOps([op({ seq: 1, path: 'x.png', kind: 'read', tool: 'read_image' })], null)
    expect(activity.totals.image.files).toBe(1)
    expect(activity.totals.read.files).toBe(1)
  })

  it('orders rows newest first by default fold', () => {
    const activity = aggregateOps([
      op({ seq: 1, path: '/old.ts', kind: 'read' }),
      op({ seq: 9, path: '/new.ts', kind: 'read' }),
    ], null)
    expect(activity.entries.map(entry => entry.path)).toEqual(['/new.ts', '/old.ts'])
  })
})

describe('toolTallyOf', () => {
  it('counts tool results, including skill-tool nodes', () => {
    const tally = toolTallyOf([
      { cat: 'tool', tool: 'read' },
      { cat: 'tool', tool: 'read' },
      { cat: 'skill', tool: 'skill' },
      { cat: 'assistant' },
    ])
    expect([...tally.entries()]).toEqual([['read', 2], ['skill', 1]])
  })
})
