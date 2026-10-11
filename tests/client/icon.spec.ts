// The plugin emblem (src/client/icon.tsx): the bundled three-segment gauge behind the right-Sidebar tab
// type's glyph and chip-title seats, and the sidebar panel-list glyph. Bundled rather than read off the
// harness primitives, so these specs render the real component; the same artwork ships as the package-root
// icon.svg, pinned in lockstep by a spec here.

import { readFile } from 'node:fs/promises'
import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ContextIcon, makeContextTabTitle } from '../../src/client/icon'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'
import { makeKit, mount, query, queryAll, text } from './helpers/kit'

describe('ContextIcon', () => {
  test('draws the colourful gauge at the requested edge', async () => {
    const m = await mount(h(ContextIcon, { size: 16, className: 'lc-title-icon' }))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '16')
    assert.equal(svg.getAttribute('height'), '16')
    assert.equal(svg.getAttribute('viewBox'), '0 0 1024 1024')
    assert.equal(svg.getAttribute('class'), 'lc-title-icon')
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    // The three gauge segments keep their own fixed palette: green (cache hit),
    // amber (cache miss), red (peak).
    const segments = queryAll<SVGPathElement>(m.container, 'path')
    assert.equal(segments.length, 3, 'one arc per cost band')
    assert.deepEqual(segments.map(p => p.getAttribute('stroke')), ['#00C950', '#FE9A00', '#FB2C36'])
    assert.ok(segments.every(p => p.getAttribute('fill') === 'none'), 'the arcs are strokes, not fills')
    await m.unmount()
  })

  test('defaults to a size and can drop the class', async () => {
    const m = await mount(h(ContextIcon, {}))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '20')
    assert.equal(svg.getAttribute('height'), '20')
    assert.equal(svg.getAttribute('class'), null)
    await m.unmount()
  })

  test('the mono seat inks the gauge in the current colour', async () => {
    const m = await mount(h(ContextIcon, { mono: true }))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.innerHTML.match(/(?:fill|stroke)="#[0-9A-Fa-f]{6}"/g), null, 'no palette colour survives')
    // The plugin ships ONE artwork: the same shapes, recoloured to currentColor.
    const segments = queryAll<SVGPathElement>(m.container, 'path')
    assert.equal(segments.length, 3)
    assert.ok(segments.every(p => p.getAttribute('stroke') === 'currentColor'))
    // The needle and hub follow the same recolour, so the whole glyph reads as one ink.
    assert.equal(query<SVGLineElement>(m.container, 'line').getAttribute('stroke'), 'currentColor')
    assert.ok(queryAll<SVGCircleElement>(m.container, 'circle').every(c => c.getAttribute('fill') === 'currentColor'))
    await m.unmount()
  })

  test('the package-root icon.svg stays in lockstep with the component', async () => {
    // The static file is what the Host's package-meta reader serves to the
    // Plugins page (package.json `icon`), so a component edit that skips the
    // file — or a manual file edit that skips the component — fails here.
    const raw = await readFile('icon.svg', 'utf8')
    const svgArcs = [...raw.matchAll(/<path d="([^"]+)" fill="none" stroke="([^"]+)" stroke-width="140"/g)]
      .map(([, d, stroke]) => ({ d, stroke }))
    const m = await mount(h(ContextIcon, {}))
    const componentArcs = queryAll<SVGPathElement>(m.container, 'path').map(p => ({
      d: p.getAttribute('d'),
      stroke: p.getAttribute('stroke'),
    }))
    await m.unmount()
    assert.equal(svgArcs.length, 3, 'the file carries the three gauge arcs')
    assert.deepEqual(svgArcs, componentArcs)
    assert.match(raw, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1024 1024" role="img" aria-label="[^"]+">/)
  })
})

describe('makeContextTabTitle — the chip-title seat', () => {
  test('renders the emblem beside the plugin label in the active locale', async () => {
    const { t } = makeKit()
    const Title = makeContextTabTitle(t)
    const m = await mount(h(Title))
    assert.equal(query<SVGSVGElement>(m.container, 'svg').getAttribute('width'), '16')
    const label = query<HTMLSpanElement>(m.container, '.lc-title-label')
    assert.equal(text(label), DICT_EN['tab'])
    await m.unmount()
  })

  test('follows the bound translate at render (zh label)', async () => {
    const Title = makeContextTabTitle(makeKit('zh').t)
    const m = await mount(h(Title))
    assert.equal(text(m.container), DICT_ZH['tab'])
    await m.unmount()
  })
})
