/**
 * Dictionary completeness.
 *
 * Every `t('key')` a component can reach must have both a Chinese and an English entry. A missing key renders
 * as the raw key on screen — `ov.skills.sort.last` in the middle of a toolbar — which is exactly the class of
 * bug a type-checked codebase still ships, because the key is a template string.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n/dict'

const root = join(import.meta.dirname, '..', '..')
const uiRoot = join(root, 'src', 'client')

/** Every source file under `src/client`. */
function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Static `t('…')` keys, plus the `t(\`…${…}\`)` families used with a closed set of suffixes. */
function usedKeys(): Set<string> {
  const keys = new Set<string>()
  for (const file of sources(uiRoot)) {
    const source = readFileSync(file, 'utf8')
    // A trailing dot means the literal is a *prefix* being concatenated (`t('cat.' + stage)`), not a key.
    for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9_-][a-zA-Z0-9_.-]*)'/g)) {
      if (!match[1].endsWith('.')) keys.add(match[1])
    }

  }
  return keys
}

describe('the dictionary', () => {
  it('carries the same keys in both languages', () => {
    const zh = Object.keys(DICT_ZH)
    const en = Object.keys(DICT_EN)
    expect(zh.filter(key => !en.includes(key))).toEqual([])
    expect(en.filter(key => !zh.includes(key))).toEqual([])
  })

  it('defines every key a component looks up', () => {
    const missing: string[] = []
    for (const key of usedKeys()) {
      if (!(key in DICT_ZH)) missing.push(key)
      if (!(key in DICT_EN)) missing.push(`${key} (en)`)
    }
    expect(missing.sort()).toEqual([])
  })

  it('resolves every suffix of the dynamic families actually used', () => {
    // The families whose suffix set is closed and known. A new suffix means a label on screen.
    const families: Record<string, readonly string[]> = {
      'kind.': ['inject', 'compaction', 'prune', 'model', 'mode'],
      'cat.': ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'],
      'form.': ['context', 'catalog', 'snapshot', 'notice', 'relay', 'recall', 'instructions'],
      'ov.skills.sort.': ['loads', 'recent', 'last', 'path'],
    }
    const missing: string[] = []
    for (const [prefix, suffixes] of Object.entries(families)) {
      for (const suffix of suffixes) {
        const key = prefix + suffix
        if (!(key in DICT_ZH)) missing.push(`zh:${key}`)
        if (!(key in DICT_EN)) missing.push(`en:${key}`)
      }
    }
    expect(missing.sort()).toEqual([])
  })
})
