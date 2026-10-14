// 平台卡片组（src/client/components/statsPlatforms.tsx）：每个平台一张卡。
//
// 拆成多张而不是塞进一张，是因为各平台的账单单位不同——DeepSeek 按人民币 token
// 计价，积分平台按次扣积分。放进一张卡就得给总额，而那个总额是把两种货币相加。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { createElement as h } from 'react'
import { makeStatsPlatforms, platformDisplayName } from '../../../src/client/components/statsPlatforms'
import { Donut } from '../../../src/client/components/donut'
import { makeKit, mount, queryAll, text } from '../helpers/kit'
import type { PlatformSpend } from '../../../src/client/platformSpend'

const kitZh = makeKit('zh')
const kitEn = makeKit('en')

const ROWS: PlatformSpend[] = [
  {
    provider: 'workbuddy', unit: 'credits', value: 120.78, calls: 1098,
    models: ['glm-5.3', 'deepseek-v4.1-flash'],
    byModel: { 'glm-5.3': 90, 'deepseek-v4.1-flash': 30.78 },
    callsByModel: { 'glm-5.3': 900, 'deepseek-v4.1-flash': 198 },
  },
  {
    provider: 'workbuddy-ai', unit: 'credits', value: 0, calls: 465,
    models: ['deepseek-v4.1-flash'], byModel: { 'deepseek-v4.1-flash': 0 }, callsByModel: { 'deepseek-v4.1-flash': 465 },
  },
  {
    provider: 'deepseek-account', unit: 'money', currency: 'CNY', value: 28, calls: 612,
    models: ['deepseek-v4.1-flash'], byModel: { 'deepseek-v4.1-flash': 28 }, callsByModel: { 'deepseek-v4.1-flash': 612 },
  },
]

describe('each platform gets its own card', () => {
  test('three platforms make three cards, never one combined figure', async () => {
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, { rows: ROWS, currency: 'cny' } as never))
    try {
      const cards = queryAll(m.container, '.lc-pf-card')
      assert.equal(cards.length, 3, 'one card per platform')
      assert.deepEqual(cards.map(c => c.getAttribute('data-unit')), ['credits', 'credits', 'money'])
    } finally { await m.unmount() }
  })

  test('a credit card shows credits, its call count and its models', async () => {
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, { rows: [ROWS[0]], currency: 'cny' } as never))
    try {
      const card = queryAll(m.container, '.lc-pf-card')[0]
      assert.match(text(card), /120\.78/, 'the credit figure')
      assert.match(text(card), /积分/, 'labelled as credits')
      assert.match(text(card), /1\.1k/, 'and how many calls it took')
      // Models now appear as the donut's legend rows, like the cost card's buckets.
      const legend = queryAll(card, '.lc-sl-label').map(el => el.textContent)
      assert.deepEqual(legend, ['glm-5.3', 'deepseek-v4.1-flash'], 'one legend row per model')
    } finally { await m.unmount() }
  })

  test('a zero balance is stated, not hidden', async () => {
    // The international edition really reports x0.00 for this model (free), so a zero
    // card is a true reading and must be shown rather than dropped as "empty".
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, { rows: [ROWS[1]], currency: 'cny' } as never))
    try {
      assert.match(text(queryAll(m.container, '.lc-pf-card')[0]), /^workbuddy-ai/)
      assert.match(text(queryAll(m.container, '.lc-pf-card')[0]), /0/)
    } finally { await m.unmount() }
  })

  test('DeepSeek is named, and priced in CNY', async () => {
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, { rows: [ROWS[2]], currency: 'cny' } as never))
    try {
      const card = queryAll(m.container, '.lc-pf-card')[0]
      assert.match(text(card), /DeepSeek/, 'not the raw route key')
      // `value` is USD on the wire and converted for display, so ¥28 needs 28/0.15.
      assert.match(text(card), /¥186\.67/, 'priced in CNY, two decimals above one unit')
    } finally { await m.unmount() }
  })

  test('a balance is shown only on the platform it belongs to', async () => {
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, {
      rows: ROWS, currency: 'cny',
      balances: { workbuddy: { text: '6387 积分' }, 'deepseek-account': { text: '¥38.12' } },
    } as never))
    try {
      const cards = queryAll(m.container, '.lc-pf-card')
      // The card prints the "剩余" label itself, so the value carries only the figure
      // and its unit — never a second copy of the label.
      assert.match(text(cards[0]), /剩余\s*6387 积分/, 'the credit balance on the credit card')
      assert.doesNotMatch(text(cards[1]), /6387/, 'and NOT on the other credit platform')
      assert.match(text(cards[2]), /¥38\.12/, 'the account balance on DeepSeek')
    } finally { await m.unmount() }
  })

  test('no balance means no balance line, never a placeholder', async () => {
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, { rows: ROWS, currency: 'cny' } as never))
    try {
      assert.equal(queryAll(m.container, '.lc-pf-balance').length, 0, 'nothing shown without a figure')
    } finally { await m.unmount() }
  })

  test('nothing to show renders nothing at all', async () => {
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, { rows: [], currency: 'cny' } as never))
    try {
      assert.equal(text(m.container), '', 'no empty cards')
    } finally { await m.unmount() }
  })

  test('the donut splits by each model, and the ring matches the headline', async () => {
    // Same contract as the cost card: the segments and the right-hand figure come from
    // one source, so a reader can trust that the parts add up to the whole.
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const split = {
      ...ROWS[0],
      models: ['a', 'b'],
      byModel: { a: 3, b: 1 },
      callsByModel: { a: 3, b: 1 },
    }
    const m = await mount(h(Cards as never, { rows: [split], currency: 'cny' } as never))
    try {
      const card = queryAll(m.container, '.lc-pf-card')[0]
      assert.equal(queryAll(card, '.lc-sl-row').length, 2, 'one legend row per model')
      assert.deepEqual(queryAll(card, '.lc-sl-pct').map(el => el.textContent), ['75.0%', '25.0%'])
    } finally { await m.unmount() }
  })

  test('each card carries its own per-model rows, so no second table is needed', async () => {
    // The standalone detail table this used to sit above repeated the card's own figures
    // verbatim (platform, model, spend, calls, balance), so every number appeared twice.
    // The per-model rows now live in the card, where the ring's segments point at them.
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, { rows: [ROWS[0]], currency: 'cny' } as never))
    try {
      const card = queryAll(m.container, '.lc-pf-card')[0]
      const rows = queryAll(card, '.lc-pf-models tbody tr').map(tr => ({
        model: tr.querySelector('.lc-pf-model-name')?.textContent ?? '',
        spend: tr.querySelector('.lc-pf-model-spend')?.textContent ?? '',
        calls: tr.querySelector('.lc-pf-model-calls')?.textContent ?? '',
      }))
      // Ordered by spend, biggest first: glm-5.3 (90) before deepseek-v4.1-flash (30.78).
      assert.deepEqual(rows.map(r => r.model), ['glm-5.3', 'deepseek-v4.1-flash'])
      assert.deepEqual(rows.map(r => r.spend), ['90', '30.78'])
      assert.deepEqual(rows.map(r => r.calls), ['900', '198'])
    } finally { await m.unmount() }
  })

  test('the table names its columns, so the two figures never read as one number', async () => {
    // 消费 and 调用 are both right-aligned numbers; with no header and no gap between
    // the columns they ran together ("198.111.8k", "0109").
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const m = await mount(h(Cards as never, { rows: [ROWS[0]], currency: 'cny' } as never))
    try {
      const head = queryAll(m.container, '.lc-pf-card .lc-pf-models thead th')
      assert.deepEqual(head.map(th => th.textContent), ['模型', '消费', '调用'])
      // And each body row still carries exactly its own three cells.
      const first = queryAll(m.container, '.lc-pf-card .lc-pf-models tbody tr')[0]
      assert.deepEqual(
        [...first.children].map(td => td.getAttribute('class')),
        ['lc-pf-model-name', 'lc-pf-model-spend', 'lc-pf-model-calls'],
      )
    } finally { await m.unmount() }
  })

  test('the columns are separated by a padding rule the cell rule cannot override', async () => {
    // The gap lived on `.lc-pf-model-spend { padding-left }` (0,1,0), which the
    // `.lc-pf-models td { padding: 3px 0 }` cell rule (0,1,1) short-handed away —
    // so the columns had no gap at all. The gap now rides a selector at least as
    // specific as the cell rule.
    const css = readFileSync(join(process.cwd(), 'src/client/styles/spend.css'), 'utf8')
    const cell = /\.lc-pf-models td\s*\{([^}]*)\}/.exec(css)
    assert.ok(cell !== null, 'the cell rule exists')
    assert.match(cell[1], /padding:/, 'and sets the vertical padding')
    // No bare `.lc-pf-model-spend { ... padding-left ... }` left behind.
    const bare = /(^|\n)\.lc-pf-model-spend\s*\{/.exec(css)
    assert.equal(bare, null, 'the spend gap is not declared on the losing bare selector')
    const scoped = /\.lc-pf-models td\.lc-pf-model-spend\s*\{([^}]*)\}/.exec(css)
    assert.ok(scoped !== null, 'it is declared scoped to the cell')
    assert.match(scoped[1], /padding-left:\s*(?!0\b)\d/, 'with a real gap')
  })

  test('a model with no rate is labelled, never shown as a zero spend', async () => {
    // "No rate configured" and "these calls were free" are different claims; a 0 would
    // silently make the second one.
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const unrated = {
      ...ROWS[0],
      models: ['glm-5.3', 'mystery-model'],
      byModel: { 'glm-5.3': 90 },
      callsByModel: { 'glm-5.3': 900, 'mystery-model': 5 },
    }
    const m = await mount(h(Cards as never, { rows: [unrated], currency: 'cny' } as never))
    try {
      const rows = queryAll(m.container, '.lc-pf-models tbody tr')
      assert.equal(rows.length, 2)
      const last = rows[1]
      assert.ok((last.textContent ?? '').includes('未配置费率'), 'the reason is stated')
      assert.ok(last.className.includes('lc-pf-model-unpriced'), 'and the row is dimmed')
      assert.ok((last.textContent ?? '').includes('5'), 'the calls are still reported')
    } finally { await m.unmount() }
  })
})

describe('platformDisplayName', () => {
  test('the official route reads as the product name in both locales', () => {
    assert.equal(platformDisplayName('deepseek-account', kitZh.t), 'DeepSeek')
    assert.equal(platformDisplayName('deepseek-official', kitEn.t), 'DeepSeek')
  })

  test('anything else keeps its own name verbatim', () => {
    // A platform key is a factual identifier, not a label to be prettified.
    assert.equal(platformDisplayName('workbuddy-ai', kitZh.t), 'workbuddy-ai')
  })
})

describe('platform cards are not stretched to a common height', () => {
  const css = readFileSync(join(process.cwd(), 'src/client/styles/statsCost.css'), 'utf8')

  test('the row aligns cards to their own content height', () => {
    // The cards hold different amounts of content: a platform with no spend has no
    // donut to draw, and one with no readable balance has one row fewer. Stretching
    // them to a common height left a large blank region inside the short card — which
    // is exactly what a zero-spend platform card looked like.
    const row = /\.lc-platform-row\s*\{([^}]*)\}/.exec(css)
    assert.ok(row !== null, 'the platform row rule exists')
    assert.match(row[1], /align-items:\s*flex-start/, 'each card keeps its own height')
    assert.doesNotMatch(row[1], /align-items:\s*stretch/, 'not stretched to the tallest sibling')
  })

  test('every platform card still reports its balance', async () => {
    // The card in question showed a balance; the complaint about it was positional.
    // Pin that a zero-spend platform still carries its own remaining figure.
    const Cards = makeStatsPlatforms(kitZh, Donut)
    const zero = { ...ROWS[0], provider: 'workbuddy-ai', value: 0, byModel: { 'glm-5.3': 0 } }
    const m = await mount(h(Cards as never, {
      rows: [zero],
      currency: 'cny',
      balances: { 'workbuddy-ai': { text: '350' } },
    } as never))
    try {
      const body = text(queryAll(m.container, '.lc-pf-card')[0])
      assert.match(body, /350/, 'the balance is on the card')
      assert.match(body, /475|1\.1k/, 'alongside its call count')
    } finally { await m.unmount() }
  })
})
