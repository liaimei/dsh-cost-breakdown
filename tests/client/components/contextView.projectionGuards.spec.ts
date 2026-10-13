import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { click, mount, query, queryAll, text, until } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, richTimeline, T0, timeline } from './contextViewHarness'

describe('ContextView — projection guards', () => {
  test('loading screen while useProjection is absent, empty, or the session id is missing', async () => {
    const View = makeView(new TestClientCtx())

    const m1 = await mount(h(View, { sessionId: 'sv-none' }))
    assert.ok(text(m1.container).includes(DICT_EN.loading))
    await m1.unmount()

    const m2 = await mount(h(View, { sessionId: '', useProjection: () => undefined }))
    assert.ok(text(m2.container).includes(DICT_EN.loading))
    await m2.unmount()

    const m3 = await mount(h(View, { useProjection: () => undefined }))
    assert.ok(text(m3.container).includes(DICT_EN.loading))
    await m3.unmount()
  })

  test('a cold read that settles without data surfaces the retryable failure, not a stall', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 500, json: async () => null } as Response))
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-cold-fail', useProjection: () => undefined }))
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure note never surfaced')
    assert.ok(!text(m.container).includes(DICT_EN.loading), 'no spinner remains once failed')
    await act(async () => {
      buttonByText(m.container, DICT_EN['detail.loadFailed']).click()
    })
    await m.unmount()
  })

  test('renders the full tab without a session id (the agent card anchors nothing)', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { useProjection: projectionsFor(timeline()) }))
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    await m.unmount()
  })

  test('a corrupt timeline is sanitized and the whole tab still renders empty-section states', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-garbage',
      useProjection: projectionsFor(timeline(), {}),
    }))
    // Well-formed-but-empty: every section renders its empty state.
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    assert.ok(text(m.container).includes(DICT_EN['trend.empty']))
    assert.ok(text(m.container).includes(DICT_EN['events.empty']))
    assert.ok(text(m.container).includes(DICT_EN['files.empty']))
    assert.ok(m.container.querySelector('.lc-br-cats') !== null)
    // No model/provider: the composition card carries no subtitle.
    const comp = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['overview.title']))
    assert.ok(comp !== undefined && comp.querySelector('.lc-card-sub') === null)
    await m.unmount()
  })

  test('companion projections feed the headline, stats, and browser headers', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-proj',
      useProjection: projectionsFor(timeline({ model: 'm-only' }), {
        contextPressure: { projectedTokens: 100, contextWindow: 128000 },
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 },
        contextBreakdown: { systemTokens: 100, toolsTokens: 200, messageTokens: 900 },
        contextHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12 }] }] },
      }),
    }))
    // Anchored headline: projected 100 of a 128k window.
    assert.ok(text(m.container).includes(DICT_EN['overview.used']))
    // The Token card's center is the chat stats line's whole-session billed
    // total off the official tokenUsage projection (100 + 200 + 0 + 50), and
    // its corner shows the line's own cache-hit rate two decimals deep (200 / 300, truncated).
    const tokensCard = queryAll(m.container, '.lc-head > .lc-col-donut')[0]
    assert.equal(query(tokensCard, '.lc-donut-center b').textContent, '350')
    assert.equal(query(tokensCard, '.lc-card-rate').textContent, 'Cache Hit 66.66%')
    assert.ok(text(m.container).includes('m-only'))
    await m.unmount()
  })
})

describe('ContextView — the sidebar host', () => {
  test('the panel drops the whole context half, keeping the platform spend section', async () => {
    const View = makeView(new TestClientCtx())
    const projections = projectionsFor(richTimeline())

    const tab = await mount(h(View, { useProjection: projections }))
    assert.equal(queryAll(tab.container, '.lc-stats').length, 1, 'the tab keeps the context stats')
    assert.equal(queryAll(tab.container, '.lc-pi-grid').length, 1, 'the tab keeps the plugin info')
    await tab.unmount()

    const panel = await mount(h(View, { host: 'sidebar', useProjection: projections }))
    assert.equal(queryAll(panel.container, '.lc-stats').length, 0, 'the panel drops the context stats')
    assert.equal(queryAll(panel.container, '.lc-pi-grid').length, 0, 'the panel drops the plugin info')
    // The sidebar answers for this session as a whole, in two separate sections — never the
    // analysis surfaces: no composition, no trend, no browser, no events, no files.
    assert.equal(queryAll(panel.container, '.lc-cols-main').length, 0, 'no context half at all')
    assert.equal(queryAll(panel.container, '.lc-col-browser').length, 0)
    assert.equal(queryAll(panel.container, '.lc-ov-heat-card').length, 0)
    // Two sections, tokens first and spend second, each with its own heading.
    assert.deepEqual(
      queryAll(panel.container, '.lc-sect-title').map(el => el.textContent),
      [DICT_EN['tokens.title'], DICT_EN['spend.title']],
    )
    // The token section carries the reused Token card; the spend section the platform card.
    assert.equal(queryAll(panel.container, '.lc-sect')[0].querySelector('.lc-donut') !== null, true,
      'the token section renders the Token card')
    assert.deepEqual(
      queryAll(panel.container, '.lc-pf-card .lc-card-title-text').map(el => el.textContent),
      ['DeepSeek'],
    )
    await panel.unmount()
  })

  test('the tab carries no spend section at all: it speaks for context only', async () => {
    const View = makeView(new TestClientCtx())
    const projections = projectionsFor(richTimeline())

    const m = await mount(h(View, { useProjection: projections }))
    const cols = queryAll(m.container, '.lc-cols-main > .lc-col')
    assert.equal(cols.length, 2, 'one two-column split')
    assert.ok(cols[0].querySelector('.lc-overview-num') !== null, 'composition leads the left column')
    assert.ok(cols[0].querySelector('.lc-trend-ctl') !== null, 'the trend follows in the same column')
    assert.ok(cols[1].querySelector('.lc-br-dna-ctl') !== null, 'the browser owns the right column')
    // No amount may appear on this page: the spend section lives in the right sidebar column
    // and in the statistics page, never here.
    assert.equal(queryAll(m.container, '.lc-sect').length, 0, 'no spend section')
    assert.equal(queryAll(m.container, '.lc-pf-card').length, 0, 'no platform cards')
    assert.equal(queryAll(m.container, '.lc-pd-card').length, 0, 'no detail table')
    assert.equal(queryAll(m.container, '.lc-sc-periods').length, 0, 'no peak/off-peak split')
    await m.unmount()
  })
})

describe('ContextView — baseline gate', () => {
  test('a gated host renders the zeroed cards under the upgrade modal', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-gated',
      useProjection: projectionsFor(timeline({ unsupported: { current: '0.1.1-rc.2', minimum: '0.1.7-rc.2' } })),
    }))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    const card = query(m.container, '.lc-gate-card')
    assert.ok(text(card).includes(DICT_EN['gate.title']))
    assert.ok(text(card).includes('v0.1.1-rc.2'))
    assert.ok(text(card).includes('v0.1.7-rc.2'))
    // The cards keep rendering the fallback's zeroed data behind it.
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN['trend.empty']))
    assert.ok(text(m.container).includes(DICT_EN['events.empty']))
    await click(buttonByText(m.container, DICT_EN['gate.ok']))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    await m.unmount()
  })

  test('a malformed gate record never opens the modal', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-gate-junk',
      useProjection: projectionsFor(timeline({ unsupported: { current: 7 } })),
    }))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    await m.unmount()
  })
})

describe('the platform cards get their own row', () => {
  test('they are not squeezed into the fixed three-column header row', async () => {
    // The regression: platform cards were added as a fourth (and fifth, sixth...) item in
    // the header row, whose three cards each carry `min-width: min(360px, 100%)`. The
    // extras were crushed into a vertical sliver of a column.
    const css = readFileSync(join(process.cwd(), 'src/client/styles/statsCost.css'), 'utf8')
    assert.match(css, /\.lc-platform-row/, 'the row has its own class')
    // And it must give each card a floor, or a narrow container still flattens them.
    assert.match(css, /\.lc-platform-row > \.lc-pf-card\s*\{[^}]*min-width:/, 'with a minimum card width')
    const src = readFileSync(join(process.cwd(), 'src/client/components/contextView.tsx'), 'utf8')
    const header = src.slice(src.indexOf('lc-cols lc-head'), src.indexOf('lc-platform-row'))
    assert.doesNotMatch(header, /<StatsPlatforms/, 'not a member of the header row')
    assert.match(src, /lc-cols lc-platform-row/, 'it lives in a row of its own')
  })

  test('the cards grow with the panel instead of stopping at a fixed width', () => {
    // The regression (seen in a maximized right sidebar): the cards carried a
    // `max-width: min(420px, 100%)`, so a single platform in an 800px-wide panel sat at
    // 420px with half the row left empty — while the Token card directly above it filled
    // the width. Two widths in one column read as a broken layout.
    for (const file of ['src/client/styles/statsCost.css', 'src/client/styles/spend.css']) {
      const css = readFileSync(join(process.cwd(), file), 'utf8')
      // Only the platform-card rules matter; other classes legitimately cap widths.
      // `.lc-pf-card` is also declared as a container in a second, size-only rule — that one
      // carries no width properties, so pick the rule that actually sizes the card.
      const rules = (css.match(/\.lc-(?:platform|ov-platform)-row > \.lc-pf-card\s*\{[^}]*\}/g) ?? [])
        .filter(rule => /(?:^|[\s;{])flex:/.test(rule))
      assert.equal(rules.length, 1, `${file} declares exactly one sizing rule for the platform card`)
      const rule = rules[0]
      assert.doesNotMatch(rule, /max-width/, `${file}: no fixed ceiling, so the card fills the row`)
      assert.match(rule, /flex:\s*1\s+1\s+auto/, `${file}: it still grows`)
      assert.match(rule, /min-width:/, `${file}: and keeps its floor when the panel is narrow`)
    }
  })
})

describe('the per-model rows live inside the platform card', () => {
  test('a card carries its own model rows rather than a second, duplicate table', () => {
    // A standalone detail table repeated exactly what the card already said (platform,
    // model, spend, calls, balance), so the reader saw every figure twice. The per-model
    // rows now sit in the card, where the ring's segments point at them.
    const src = readFileSync(join(process.cwd(), 'src/client/components/statsPlatforms.tsx'), 'utf8')
    assert.match(src, /modelSpendRowsOf/, 'the card derives its own per-model rows')
    assert.match(src, /lc-pf-models/, 'and renders them inside the card')
    // The old standalone table must be gone from the tree, not merely unused.
    assert.equal(readdirSync(join(process.cwd(), 'src/client/components')).includes('platformSpendDetail.tsx'), false,
      'the duplicate table component was deleted')
    assert.equal(readFileSync(join(process.cwd(), 'src/client/styles/spend.css'), 'utf8').includes('lc-pd-table'), false,
      'and its stylesheet rules went with it')
  })
})
