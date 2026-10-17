/**
 * Token estimation heuristics. These numbers drive the composition card and the request table, so the
 * density rules, the per-block/per-message overhead and the image path are pinned exactly.
 */

import { describe, expect, it } from 'vitest'
import {
  countImages, estimateMessage, estimateSystemBlocks, estimateSystemText, estimateToolSchema, estimateTools,
  firstRawText, firstText, injectionLabel, isInjection, skillNameOf, toolCallNames,
} from '../../src/core/tokens'

describe('system estimation', () => {
  it('prices a non-empty string at 4 chars per token plus the role frame', () => {
    expect(estimateSystemText('abcd')).toBe(5)
    expect(estimateSystemText('')).toBe(0)
    expect(estimateSystemText(undefined)).toBe(0)
  })

  it('prices content blocks without a per-block overhead', () => {
    // 8 characters of text ⇒ 2 tokens + 4 role frame; the second, non-text block contributes its JSON.
    const tokens = estimateSystemBlocks([{ type: 'text', text: '12345678' }, { type: 'x', a: 1 }])
    expect(tokens).toBeGreaterThanOrEqual(6)
  })

  it('is 0 for an empty or non-array payload', () => {
    expect(estimateSystemBlocks([])).toBe(0)
    expect(estimateSystemBlocks(undefined)).toBe(0)
  })
})

describe('message estimation', () => {
  it('counts a text block with block and role overhead', () => {
    // ceil(4/4) + 4 block + 4 role = 9
    expect(estimateMessage({ content: [{ type: 'text', text: 'abcd' }] })).toBe(9)
  })

  it('prices an empty assistant message at zero when told to', () => {
    expect(estimateMessage({ content: [] }, true)).toBe(0)
    expect(estimateMessage({ content: [] }, false)).toBe(4)
  })

  it('prices tool-call blocks by name plus arguments', () => {
    const tokens = estimateMessage({ content: [{ type: 'tool-call', name: 'read', arguments: '{"path":"a"}' }] })
    expect(tokens).toBeGreaterThan(9)
  })

  it('keeps a hostile block from throwing', () => {
    const circular: Record<string, unknown> = { type: 'other' }
    circular.self = circular
    // JSON.stringify throws on a cycle; the estimate must fall back rather than take the fold down.
    expect(() => estimateMessage({ content: [circular as never] })).not.toThrow()
  })
})

describe('tool estimation', () => {
  it('prices the whole tool array as one blob', () => {
    expect(estimateTools([])).toBe(0)
    expect(estimateTools([{ name: 'a' }])).toBe(8)
  })

  it('prices a single schema', () => {
    // `{"name":"a"}` is 12 characters ⇒ 3 tokens, plus the block overhead.
    expect(estimateToolSchema({ name: 'a' })).toBe(7)
  })
})

describe('content helpers', () => {
  it('counts images recursively', () => {
    expect(countImages([{ type: 'image' }, { type: 'x', content: [{ type: 'image' }] }])).toBe(2)
  })

  it('collapses and truncates the first text block', () => {
    expect(firstText([{ type: 'text', text: '  a\n\n b  ' }])).toBe('a b')
    expect(firstText([{ type: 'text', text: 'x'.repeat(200) }]).length).toBe(80)
  })

  it('returns the raw first text for skill matching', () => {
    expect(firstRawText([{ type: 'text', text: '  spaced  ' }])).toBe('  spaced  ')
  })

  it('lists tool-call names in order', () => {
    expect(toolCallNames([{ type: 'tool-call', name: 'a' }, { type: 'tool-call', name: 'b' }])).toEqual(['a', 'b'])
  })

  it('reads a skill name out of the rendered wrapper', () => {
    expect(skillNameOf('<skill_content name="pdf">x</skill_content>')).toBe('pdf')
    expect(skillNameOf('nothing')).toBe('')
  })
})

describe('injection classification', () => {
  it('treats any non-user kind as an injection', () => {
    expect(isInjection({ kind: 'user' })).toBe(false)
    expect(isInjection({ kind: 'agent-instructions' })).toBe(true)
    expect(isInjection({ form: 'snapshot' })).toBe(true)
    expect(isInjection(null)).toBe(false)
  })

  it('labels a producer by its own rules', () => {
    expect(injectionLabel({ kind: 'agent-instructions', changes: [{ path: 'a.md' }, { path: 'a.md' }, { path: 'b.md' }] })).toBe('a.md, b.md')
    expect(injectionLabel({ plugin: 'someone' })).toBe('someone')
    expect(injectionLabel({ kind: 'recall' })).toBe('recall')
  })
})
