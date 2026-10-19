/**
 * Style-contract checks.
 *
 * A rewrite is most likely to break the CSS quietly: a component renders a class the sheets never define, and
 * the surface looks unstyled with no error anywhere. These tests read the component sources and the sheets and
 * fail when a class is used but never declared — and when a colour token is referenced but never defined.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const uiDirs = ['context', 'insights', 'dock'].map(dir => join(root, 'src', 'client', 'ui', dir))
const styleDir = join(root, 'src', 'client', 'styles')

/** Every stylesheet's text, concatenated. */
function sheets(): string {
  return readdirSync(styleDir)
    .filter(file => file.endsWith('.css'))
    .map(file => readFileSync(join(styleDir, file), 'utf8'))
    .join('\n')
}

/** Every `cb-` class a component renders, from both the object form and the template form. */
function usedClasses(): Set<string> {
  const classes = new Set<string>()
  for (const dir of uiDirs) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.tsx') && !file.endsWith('.ts')) continue
      const source = readFileSync(join(dir, file), 'utf8')
      // Object form: className: 'cb-a cb-b'
      for (const match of source.matchAll(/className:\s*[`'"]([^`'"]+)/g)) collect(match[1])
      // Template form: className={`cb-a${cond ? ' cb-b' : ''}`}
      for (const match of source.matchAll(/className=\{`([^`]+)`\}/g)) collect(match[1])
    }
  }
  return classes

  /** Split a class list and keep the `cb-` names that are not template fragments or literal expressions. */
  function collect(list: string): void {
    for (const raw of list.split(/[\s$]/)) {
      const name = raw.trim()
      if (!name.startsWith('cb-') || name.includes('{') || name.endsWith("'") || name.length < 4) continue
      classes.add(name)
    }
  }
}

describe('the style sheets cover what the components render', () => {
  it('defines every cb- class a surface uses', () => {
    const css = sheets()
    // The palette tokens are consumed as `var(--cb-ctx-*)` and never as class names; they are checked by the
    // token test below instead.
    const tokens = /^cb-(ctx|ov)-(indigo|blue|teal|green|amber|orange|purple|pink|violet|slate)$/
    const missing = [...usedClasses()]
      .filter(name => !tokens.test(name))
      .filter(name => !css.includes(`.${name}`))
      .sort()
    expect(missing).toEqual([])
  })

  it('defines the colour tokens the sheets reference', () => {
    const css = sheets()
    // Both alias families are declared in base.css; a reference without a definition draws an invalid colour.
    for (const token of ['cb-ctx-indigo', 'cb-ctx-blue', 'cb-ctx-teal', 'cb-ctx-green', 'cb-ctx-amber',
      'cb-ctx-orange', 'cb-ctx-purple', 'cb-ctx-pink', 'cb-ctx-violet', 'cb-ctx-slate',
      'cb-ov-indigo', 'cb-ov-blue', 'cb-ov-teal', 'cb-ov-green', 'cb-ov-amber', 'cb-ov-orange',
      'cb-ov-purple', 'cb-ov-pink', 'cb-ov-violet', 'cb-ov-slate']) {
      expect(css, `--${token} is referenced but never declared`).toContain(`--${token}:`)
    }
  })

  it('loads every sheet from the bundle entry', () => {
    const entry = readFileSync(join(root, 'src', 'client', 'index.ts'), 'utf8')
    for (const file of readdirSync(styleDir).filter(name => name.endsWith('.css'))) {
      expect(entry, `${file} is never imported`).toContain(file)
    }
  })
})

describe('classes assembled at runtime', () => {
  it('defines every heatmap level class the component can emit', () => {
    // The component builds `cb-ov-heat-<level>` from a number, so no static scan can see the names. They were
    // missing once and every active day rendered as the idle grey.
    const css = sheets()
    for (const level of [0, 1, 2, 3, 4]) {
      expect(css, `heat level ${level}`).toContain(`.cb-ov-heat-${level} `)
    }
  })

  it('defines the event kind classes the chips and rows overwrite', () => {
    const css = sheets()
    for (const kind of ['inject', 'compaction', 'prune', 'model', 'mode']) {
      expect(css, `kind ${kind}`).toContain(`.cb-kind-${kind}`)
    }
  })
})
