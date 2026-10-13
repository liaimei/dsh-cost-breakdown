// The Statistics panel's billed-TOKEN card (src/client/components/overviewBilled.tsx), rendered with real
// React: the donut centered on the range's provider-reported billed total, split by the four buckets the
// platform actually bills. Money has its own section (platform cards + detail table) — this card must never
// grow a cost figure, because token and amount are different quantities.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Donut } from '../../../src/client/components/donut'
import { makeOverviewBilled } from '../../../src/client/components/overviewBilled'
import type { BilledTotals } from '../../../src/client/overview'
import { makeKit, hover, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const Billed = makeOverviewBilled(kit, Donut)
const BilledZh = makeOverviewBilled(kitZh, Donut)

/** 500 cache read, 1000 uncached, 250 output, priced across both periods in USD. */
const BILLED: BilledTotals = {
  cacheRead: 500,
  uncached: 1000,
  cacheWrite: 0,
  output: 250,
  total: 1750,
  cost: { peak: 0.3, off: 0.1, any: true },
  // 该范围里各平台的消费；这个 fixture 只有按 token 计费的量，因此没有平台行。
  platforms: [],
}

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
  }
}

describe('OverviewBilled', () => {
  test('the ring splits the billed total by the platform buckets, all figures exact (no ≈)', async () => {
    const m = await mount(h(Billed, { billed: BILLED }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '1.8k')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
    // Zero buckets drop out; the remaining three keep their billed order.
    assert.deepEqual(queryAll(m.container, '.lc-sl-label').map(el => el.textContent), [
      'Cache input', 'Uncached input', 'Output',
    ])
    assert.deepEqual(rowOf(m.container, 0), { pct: '28.6%', label: 'Cache input', count: '500' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '57.1%', label: 'Uncached input', count: '1.0k' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '14.3%', label: 'Output', count: '250' })
    await m.unmount()
  })

  test('no money ever appears, even when the range is fully priced', async () => {
    // The fixture carries a peak/off split; this card must ignore it entirely and
    // render tokens only — the split belongs to the platform spend section.
    const m = await mount(h(Billed, { billed: BILLED }))
    assert.equal(queryAll(m.container, '.lc-ov-billed-period').length, 0)
    assert.equal(text(m.container).includes('$'), false)
    assert.equal(text(m.container).includes('¥'), false)
    await m.unmount()
  })

  test('the zh locale localizes the card without pricing anything', async () => {
    const m = await mount(h(BilledZh, { billed: BILLED }))
    assert.ok(text(m.container).includes('计费 Token'))
    assert.equal(text(m.container).includes('费用'), false)
    assert.equal(queryAll(m.container, '.lc-ov-billed-period').length, 0)
    await m.unmount()
  })

  test('nothing billed renders the empty note: no ring', async () => {
    for (const billed of [null, { ...BILLED, total: 0, cacheRead: 0, uncached: 0, output: 0 }]) {
      const m = await mount(h(Billed, { billed }))
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      assert.ok(text(m.container).includes('No billed tokens in this range'))
      await m.unmount()
    }
  })

  test('a billed range that priced nothing keeps its buckets', async () => {
    // The buckets are metered even when no rate applied (an unpriced model).
    const unpriced: BilledTotals = { ...BILLED, cost: { peak: 0, off: 0, any: false }, platforms: [] }
    const m = await mount(h(Billed, { billed: unpriced }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 3)
    await m.unmount()
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(Billed, { billed: BILLED }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[1])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[1]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(rows[1].className.includes('lc-sl-row-on'))
    await unhover(rows[1])
    assert.ok(!rows[1].className.includes('lc-sl-row-on'))
    await m.unmount()
  })
})
