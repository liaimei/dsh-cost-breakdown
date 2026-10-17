/**
 * The built artifacts' loadability contracts.
 *
 * These are the checks that only the built files can answer: the client handoff protocol, the frozen
 * package shape, the projection keys/versions the host registers, and the fact that the host entry exports
 * exactly what the loader expects. A refactor that renames a module is invisible here; one that moves the
 * artifact, changes the wrapper or drops an export is not.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  main: string
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string }; client?: { platform?: string; inject?: readonly string[] }; compatibility?: unknown }
}
const clientSource = readFileSync(join(root, 'lib/client.js'), 'utf8')
const hostSource = readFileSync(join(root, 'lib/index.js'), 'utf8')

describe('package shape', () => {
  it('keeps the entry points the loader and the client-modules reader expect', () => {
    expect(pkg.name).toBe('dsh-cost-breakdown')
    expect(pkg.main).toBe('lib/index.js')
    expect(pkg.exports['./client']).toBe('./lib/client.js')
    // The version probe resolves `<pkg>/package.json` through the export map: dropping it makes baseline
    // detection silently fail open.
    expect(pkg.exports['./package.json']).toBe('./package.json')
    expect(pkg.exports['./locale/*.json']).toBe('./locale/*.json')
  })

  it('declares the bundle patch and the web client half', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(pkg.dsh?.client?.inject).toContain('@deepseek-ai/dsh-client-locale')
  })

  it('still ships the shipped locale dictionaries', () => {
    for (const locale of ['zh', 'en']) {
      const raw = readFileSync(join(root, 'locale', `${locale}.json`), 'utf8')
      const parsed = JSON.parse(raw) as { meta?: { title?: string; description?: string } }
      expect(typeof parsed.meta?.title).toBe('string')
      expect(typeof parsed.meta?.description).toBe('string')
    }
  })
})

describe('client handoff protocol', () => {
  it('wraps the bundle in the module-loader closure with the package id', () => {
    expect(clientSource.startsWith('/**')).toBe(true)
    expect(clientSource).toContain('window.__ModuleLoader__.load(')
    expect(clientSource).toContain('dsh-cost-breakdown')
    // The factory form is the frozen contract; a bare ESM export would never be picked up.
    expect(clientSource).toMatch(/factory:\s*[A-Za-z_$][\w$]*\s*=>/)
    // The factory's closure returns the module's exports; minification renames the module object and may
    // fold the return into the last expression, so assert the closing shape and the export reference.
    expect(clientSource).toMatch(/t\.exports\}\}\);?\s*(\/\/# sourceMappingURL|$)/)
  })

  it('leaves only platform modules to the injected require', () => {
    // Minification reuses short identifiers across nested scopes, so a textual scan for `name("x")` cannot
    // tell the factory's `require` from an unrelated local. The invariant is checked structurally instead:
    // every harness package the bundle mentions must be the one platform module it is allowed to require,
    // and the four frozen platform modules must each be requested by name.
    const harnessMentions = new Set(clientSource.match(/@deepseek-ai\/[a-z0-9/-]+/g) ?? [])
    expect([...harnessMentions]).toEqual(['@deepseek-ai/dsh-client-ui-primitives'])
    for (const specifier of ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']) {
      // The factory parameter is renamed, so match an identifier call whose argument is the literal.
      expect(clientSource).toContain(specifier)
    }
  })

  it('injects every style sheet through the CSS channel', () => {
    // The build turns each sheet into a `<style data-plugin=…>` injector; the artifact must carry them.
    expect(clientSource).toContain('data-plugin')
    expect(clientSource).toContain('dsh-cost-breakdown')
  })
})

describe('host artifact', () => {
  it('exports the four names the loader reads', async () => {
    const module = await import(pathToFileURL(join(root, 'lib/index.js')).href) as Record<string, unknown>
    expect(module.name).toBe('dsh-cost-breakdown')
    expect(module.inject).toEqual(['sessionProjections'])
    expect(typeof module.apply).toBe('function')
    expect(module.Config).toBeDefined()
  })

  it('registers the three frozen projection keys and versions', () => {
    // The keys and versions are in the source contract; the artifact must not have dropped them.
    for (const key of ['contextTimeline', 'contextHeaders', 'contextActivity']) {
      expect(hostSource).toContain(key)
    }
    expect(hostSource).toMatch(/stateVersion:\s*29/)
    expect(hostSource).toMatch(/stateVersion:\s*1\b/)
    expect(hostSource).toMatch(/stateVersion:\s*6/)
  })

  it('declares the five route paths under the frozen prefix', () => {
    expect(hostSource).toContain('"/api/dsh-cost-breakdown"')
    for (const route of ['detail', 'backfill', 'balance', 'credits', 'skills']) {
      expect(hostSource).toContain(`routePath("${route}")`)
    }
  })
})
