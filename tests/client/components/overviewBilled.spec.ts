// The Statistics panel's CONCRETE billed-usage card (src/client/components/overviewBilled.tsx) rendered with
// real React: the donut centered on the range's provider-reported billed total, split by the four buckets the
// platform actually bills, with the peak/off-peak cost split underneath.

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
    const m = await mount(h(Billed, { billed: BILLED, currency: 'usd' }))
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

  test('the peak/off-peak cost split sits under the ring with its shares', async () => {
    const m = await mount(h(Billed, { billed: BILLED, currency: 'usd' }))
    const periods = queryAll(m.container, '.lc-ov-billed-period')
    assert.equal(periods.length, 2)
    const read = (el: Element): { label: string; cost: string; pct: string } => ({
      label: el.querySelector('i')?.nextSibling?.textContent?.trim() ?? '',
      cost: el.querySelector('b')?.textContent ?? '',
      pct: el.querySelector('em')?.textContent ?? '',
    })
    assert.deepEqual(read(periods[0]), { label: 'Peak', cost: '$0.30', pct: '75.0%' })
    assert.deepEqual(read(periods[1]), { label: 'Off-peak', cost: '$0.10', pct: '25.0%' })
    await m.unmount()
  })

  test('the zh locale prices the split in CNY with localized labels', async () => {
    const m = await mount(h(BilledZh, { billed: BILLED, currency: 'cny' }))
    assert.ok(text(m.container).includes('计费 Token'))
    const periods = queryAll(m.container, '.lc-ov-billed-period')
    // 0.3 USD / 0.15 = ¥2.00; 0.1 / 0.15 = ¥0.67.
    assert.equal(query(periods[0], 'b').textContent, '¥2.00')
    assert.equal(query(periods[0], 'em').textContent, '75.0%')
    assert.equal(query(periods[1], 'b').textContent, '¥0.67')
    assert.equal(query(periods[1], 'em').textContent, '25.0%')
    assert.ok(text(periods[0]).startsWith('峰'))
    await m.unmount()
  })

  test('nothing billed renders the empty note: no ring and no period split', async () => {
    for (const billed of [null, { ...BILLED, total: 0, cacheRead: 0, uncached: 0, output: 0 }]) {
      const m = await mount(h(Billed, { billed, currency: 'usd' }))
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      assert.equal(queryAll(m.container, '.lc-ov-billed-period').length, 0)
      assert.ok(text(m.container).includes('No billed tokens in this range'))
      await m.unmount()
    }
  })

  test('a billed range that priced nothing keeps its buckets and drops the split', async () => {
    // The buckets are metered even when no rate applied (an unpriced model).
    const unpriced: BilledTotals = { ...BILLED, cost: { peak: 0, off: 0, any: false } }
    const m = await mount(h(Billed, { billed: unpriced, currency: 'usd' }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 3)
    assert.equal(queryAll(m.container, '.lc-ov-billed-period').length, 0)
    await m.unmount()
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(Billed, { billed: BILLED, currency: 'usd' }))
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
