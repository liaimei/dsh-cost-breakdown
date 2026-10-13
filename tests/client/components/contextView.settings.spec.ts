import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { createContextSettings } from '../../../src/client/settings'
import type { SettingsScopeLike } from '../../../src/client/settings'
import type { UseChatLike } from '../../../src/client/services'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, TestLocale } from '../helpers/harness'
import { resetRateTables, setRateTables } from '../../../src/client/rateTables'
import { click, flush, mount, query, queryAll, silenceWindowErrors, text } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, richTimeline, T0, timeline } from './contextViewHarness'

describe('ContextView — locale and settings', () => {
  beforeEach(() => {
    resetModelPrices()
    setModelPricesLoader(() => Promise.resolve({
      deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
    }))
  })

  afterEach(() => {
    resetModelPrices()
    resetRateTables()
  })

  test('the spend section bills each platform in its own currency, whatever the locale', async () => {
    // The conversation tab carries no money at all now; the spend section lives in the
    // right sidebar column, and renders each platform's OWN billing currency rather
    // than following the UI locale.
    const deepseek = timeline({
      provider: 'deepseek-official',
      cost: { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 } } } },
      calls: { 'deepseek-official': { 'deepseek-v4-flash': 1 } },
    })
    const m1 = await mount(h(makeView(new TestClientCtx()), {
      sessionId: 'sv-usd',
      host: 'sidebar' as const,
      useProjection: projectionsFor(deepseek),
    }))
    await flush()
    // 1M uncached at the doubled peak ($0.30) — CNY is the official platform's own currency.
    assert.ok(text(m1.container).includes('¥'), 'the official platform is billed in CNY')
    await m1.unmount()

    // A third-party platform bills in USD, and stays in dollars even under the zh locale.
    // A declared per-1M-token rate is what makes this route priceable at all.
    setRateTables({ money: { 'zai-coding-cn:glm-5.3-flash': { input: 0.075, output: 0.25, cacheRead: 0.015 } } })
    const other = timeline({
      provider: 'zai-coding-cn',
      cost: { 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 } } } },
      calls: { 'zai-coding-cn': { 'glm-5.3-flash': 1 } },
    })
    const ctxZh = new TestClientCtx({ services: { locale: new TestLocale('zh') } })
    const m2 = await mount(h(makeView(ctxZh), {
      sessionId: 'sv-cny',
      host: 'sidebar' as const,
      useProjection: projectionsFor(other),
    }))
    await flush()
    // The sidebar has two sections now (token, then spend); the money lives in the one
    // carrying the platform cards.
    const spend = queryAll(m2.container, '.lc-sect').find(s => s.querySelector('.lc-pf-card') !== null)
    assert.ok(spend !== undefined, 'the spend section renders')
    assert.ok(text(spend).includes('$'), 'a USD platform does not become RMB under a zh UI')
    assert.ok(!text(spend).includes('¥'), 'and it never borrows the official platform\u2019s currency')
    await m2.unmount()

    const ctxBare = new TestClientCtx({ services: { locale: {} } })
    const m3 = await mount(h(makeView(ctxBare), {
      sessionId: 'sv-bare',
      host: 'sidebar' as const,
      useProjection: projectionsFor(deepseek),
    }))
    await flush()
    assert.ok(text(m3.container).includes('¥'))
    await m3.unmount()
  })

  test('the conversation tab never shows an amount, whatever the session used', async () => {
    // The tab answers for the context only: money lives in the sidebar column and on the
    // statistics page, so a session that spent money must still show none of it here.
    const priced = timeline({
      provider: 'deepseek-official',
      cost: { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1000000, output: 0, cacheRead: 0, cacheWrite: 0 } } } },
      calls: { 'deepseek-official': { 'deepseek-v4-flash': 1 } },
    })
    const m = await mount(h(makeView(new TestClientCtx()), {
      sessionId: 'sv-tab',
      useProjection: projectionsFor(priced),
    }))
    await flush()
    assert.ok(!text(m.container).includes('¥'), 'no CNY figure on the context page')
    assert.ok(!text(m.container).includes('$'), 'no USD figure either')
    await m.unmount()
  })

  test('mount-time granularity/trend/file-sort defaults come from the bound settings scope', async () => {
    const settings = createContextSettings()
    const scope: SettingsScopeLike = {
      getSnapshot: () => ({
        status: 'ready',
        writable: true,
        value: { defaultGranularity: 'turn', defaultTrendMode: 'delta', defaultFileSort: 'path', defaultDurationCurve: 'hide' },
      }),
      subscribe: () => () => {},
      set: async () => {},
    }
    const detach = settings.attach(scope)
    const View = makeView(new TestClientCtx(), settings)
    // Two file reads (the 2-op path sorts AFTER the 1-op one under 'count' but BEFORE it under 'path').
    const m = await mount(h(View, {
      sessionId: 'sv-settings',
      useProjection: projectionsFor(richTimeline({
        nodes: [
          ...richTimeline().nodes,
          { seq: 7, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 6000 },
          { seq: 8, cat: 'tool', tokens: 30, tool: 'read', text: 'a', time: T0 + 7000 },
          { seq: 9, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 8000 },
        ],
      })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [
        { kind: 'tool', seq: 7, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
        { kind: 'tool', seq: 8, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/a.ts' }) } },
        { kind: 'tool', seq: 9, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
      ] } })) as UseChatLike,
    }))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.delta']).className.includes('lc-gran-on'))
    // The 'hide' curve preference mounts the Duration toggle off (the schema default mounts it on).
    assert.ok(!buttonByText(m.container, DICT_EN['trend.duration']).className.includes('lc-gran-on'))
    // Turn aggregation applies at mount: two bars (turn 1 aggregate + turn-less).
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.deepEqual(queryAll(m.container, '.lc-fa-row').map(r => r.title), ['/a.ts', '/z.ts'])
    await m.unmount()
    detach()
  })
})

describe('ContextView — error boundary', () => {
  test('a render failure degrades to the error card and Retry recovers', async () => {
    // React 18 dev replays the failed render through a fake DOM event (loud
    // stderr via jsdom/vitest) and logs the boundary message to console —
    // both silenced so the deliberate throw stays inside this test.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const silenceErrors = silenceWindowErrors()
    try {
      const real = createContextSettings()
      // Flag-driven (not call-counted): React 18 dev replays a failed unit of
      // work and retries an errored concurrent pass synchronously, so the
      // failure must persist until the boundary catches, then clear for Retry.
      let fail = true
      const flaky = {
        ...real,
        defaultGranularity: (): 'step' | 'turn' => {
          if (fail) throw new Error('boom-settings')
          return real.defaultGranularity()
        },
      }
      const View = makeView(new TestClientCtx(), flaky)
      const m = await mount(h(View, {
        sessionId: 'sv-err',
        useProjection: projectionsFor(richTimeline()),
      }))
      assert.ok(text(m.container).includes(DICT_EN.error))
      assert.ok(text(m.container).includes('boom-settings'))

      fail = false
      await click(query(m.container, '.lc-error-retry'))
      assert.ok(text(m.container).includes(DICT_EN['overview.title']))
      assert.ok(!text(m.container).includes(DICT_EN.error))
      await m.unmount()
    } finally {
      silenceErrors()
    }
  })
})
