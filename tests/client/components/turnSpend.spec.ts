// 每轮消费读数（src/client/components/turnSpend.tsx）：位置、单位选择，以及
// 「必须从聊天节点读 turn」这条回归。
//
// 为什么这条回归值得单独钉住：`requests` 在瘦身 head 上是**空数组**（集合走 detail
// 通道），所以任何「按 seq 从 requests 反推 turn」的写法在真实环境里永远落空——
// 读数会安静地不显示。这正是曾经线上出现过的症状。

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { makeTurnSpend } from '../../../src/client/components/turnSpend'
import { resetRateTables, setRateTables } from '../../../src/client/rateTables'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import type { ContextTimeline } from '../../../src/shared/types'
import type { ThirdPartyRates } from '../../../src/shared/thirdPartyRates'
import type { CreditRates } from '../../../src/client/turnSpend'
import { flush, makeKit, mount, query, text } from '../helpers/kit'

const kit = makeKit('zh')

// 每例之后把费率表与价目册恢复原状：它们是模块级状态，会跨例泄漏。
afterEach(() => {
  resetRateTables()
  resetModelPrices()
  setModelPricesLoader(null)
})

/** 一条**真实**的聊天节点形状，抄自官方 `finalNode()`：turn 在顶层，
 *  既没有 `location`，`requests` 也不在瘦身 head 上。 */
function assistantNode(messageId: string, turn: number): unknown {
  return { kind: 'assistant', seq: 42, messageId, turn, step: 1, time: 0 }
}

/** 座位：`useChat` 给出节点，`useProjection` 给出投影。都是真实形状的最小子集。 */
function seatOf(nodes: readonly unknown[], timeline: ContextTimeline | null): {
  messageId: string
  useChat: (sel: (s: unknown) => unknown) => unknown
  useProjection: (key: string) => unknown
} {
  return {
    messageId: 'm1',
    useChat: (sel: (s: unknown) => unknown) => sel({ legacy: { nodes } }),
    useProjection: (key: string) => (key === 'contextTimeline' ? timeline : undefined),
  }
}

/** 一个带每轮账本的投影；`requests` 故意留空——瘦身 head 就是如此。 */
function timelineWithTurnCost(turnCost: ContextTimeline['turnCost'], requests: ContextTimeline['requests'] = []): ContextTimeline {
  // 只填这条测试真正读到的字段；其余按最小形状补上，避免假装成完整投影。
  return { ok: true, requests, events: [], nodes: [], archive: [], droppedNodes: 0, current: undefined, turnCost } as unknown as ContextTimeline
}

function creditEntry(provider: string, model: string, calls: number) {
  return {
    usage: { [provider]: { [model]: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    requests: { [provider]: { [model]: calls } },
  }
}

describe('the per-turn spend reading', () => {
  test('reads the turn off the chat node, with an EMPTY requests array', async () => {
    // The exact production shape: the slim head carries no request records at all, so a
    // seq→turn lookup over `requests` would find nothing and the reading would vanish.
    setModelPricesLoader(null)
    resetModelPrices()
    setRateTables({ credits: { 'workbuddy:glm-5.3': 0.5 } })
    const View = makeTurnSpend(kit, () => 'cny', () => null, () => ({ workbuddy: { 'glm-5.3': 0.5 } }))
    const timeline = timelineWithTurnCost({ '3': creditEntry('workbuddy', 'glm-5.3', 4) })
    const el = h(View as never, seatOf([assistantNode('m1', 3)], timeline) as never)
    const m = await mount(el)
    try {
      await flush()
      const pill = query(m.container, '.lc-turn-spend')
      assert.equal(text(pill), '2 积分', '4 calls x 0.5 credits')
      assert.equal(pill.getAttribute('data-unit'), 'credits')
    } finally { await m.unmount() }
  })

  test('a money turn renders the amount in the display currency', async () => {
    setModelPricesLoader(null)
    resetModelPrices()
    const View = makeTurnSpend(kit, () => 'cny', () => null, () => null)
    // deepseek-v4.1-flash: the official CNY table, ¥1/M off-peak = USD 0.15; shown in CNY.
    const usage = { 'deepseek-account': { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const timeline = timelineWithTurnCost({ '1': { usage, requests: {} } })
    const m = await mount(h(View as never, seatOf([assistantNode('m1', 1)], timeline) as never))
    try {
      await flush()
      const pill = query(m.container, '.lc-turn-spend')
      assert.equal(pill.getAttribute('data-unit'), 'money')
      // Official ¥1/M in CNY: the number is the table's own unit, so ¥1.00.
      assert.match(text(pill), /1/)
    } finally { await m.unmount() }
  })

  test('also accepts a turn nested under location', async () => {
    // Defensive compatibility: some node shapes carry the turn in the rendering
    // location object instead of at the top level.
    setModelPricesLoader(null)
    resetModelPrices()
    setRateTables({ credits: { 'workbuddy:glm-5.3': 0.5 } })
    const View = makeTurnSpend(kit, () => 'cny', () => null, () => ({ workbuddy: { 'glm-5.3': 0.5 } }))
    const node = { kind: 'assistant', seq: 42, messageId: 'm1', location: { kind: 'turn', turn: { turn: 2 } } }
    const timeline = timelineWithTurnCost({ '2': creditEntry('workbuddy', 'glm-5.3', 2) })
    const m = await mount(h(View as never, seatOf([node], timeline) as never))
    try {
      await flush()
      assert.equal(text(query(m.container, '.lc-turn-spend')), '1 积分')
    } finally { await m.unmount() }
  })

  test('renders nothing when the turn has no ledger', async () => {
    setModelPricesLoader(null)
    resetModelPrices()
    const View = makeTurnSpend(kit, () => 'cny', () => null, () => null)
    const m = await mount(h(View as never, seatOf([assistantNode('m1', 9)], timelineWithTurnCost({})) as never))
    try {
      await flush()
      assert.equal(m.container.querySelector('.lc-turn-spend'), null, 'no ledger, no reading')
    } finally { await m.unmount() }
  })

  test('renders nothing when the node carries no turn at all', async () => {
    setModelPricesLoader(null)
    resetModelPrices()
    const View = makeTurnSpend(kit, () => 'cny', () => null, () => null)
    // 一个没有 turn 的节点（例如被截断的合成节点）：不得把别人的轮次算给它。
    const node = { kind: 'assistant', seq: 1, messageId: 'm1' }
    const timeline = timelineWithTurnCost({ '1': creditEntry('workbuddy', 'glm-5.3', 1) })
    const m = await mount(h(View as never, seatOf([node], timeline) as never))
    try {
      await flush()
      assert.equal(m.container.querySelector('.lc-turn-spend'), null, 'no turn, no reading')
    } finally { await m.unmount() }
  })

  test('renders nothing for a non-string message id', async () => {
    setModelPricesLoader(null)
    resetModelPrices()
    const View = makeTurnSpend(kit, () => 'cny', () => null, () => null)
    const seat = { ...seatOf([], timelineWithTurnCost({})), messageId: 7 as unknown as string }
    const m = await mount(h(View as never, seat as never))
    try {
      await flush()
      assert.equal(m.container.querySelector('.lc-turn-spend'), null)
    } finally { await m.unmount() }
  })
})

describe('the per-turn spend reading ignores a third-party rate table it is not given', () => {
  test('an unpriced money turn stays hidden even when a book is loaded', async () => {
    // Models.dev is reachable but has no branch for this platform, so the turn is
    // unpriced. It must stay absent rather than show a guessed figure.
    setModelPricesLoader(async () => ({ 'some-unrelated': { models: {} } }))
    resetModelPrices()
    const View = makeTurnSpend(kit, () => 'cny', () => null, () => null)
    const usage = { 'mystery-platform': { 'unknown-model': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const timeline = timelineWithTurnCost({ '1': { usage, requests: {} } })
    const m = await mount(h(View as never, seatOf([assistantNode('m1', 1)], timeline) as never))
    try {
      await flush()
      assert.equal(m.container.querySelector('.lc-turn-spend'), null)
    } finally { await m.unmount(); resetModelPrices(); setModelPricesLoader(null) }
  })
})

describe('the credit table is not a money table', () => {
  test('an empty credit table still prices official models as money', async () => {
    setModelPricesLoader(null)
    resetModelPrices()
    const View = makeTurnSpend(kit, () => 'usd', () => null, () => null)
    const rates: ThirdPartyRates | null = null
    const usage = { 'deepseek-account': { 'deepseek-v4.1-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const timeline = timelineWithTurnCost({ '1': { usage, requests: {} } })
    const m = await mount(h(View as never, { ...seatOf([assistantNode('m1', 1)], timeline), rates } as never))
    try {
      await flush()
      assert.equal(query(m.container, '.lc-turn-spend').getAttribute('data-unit'), 'money')
    } finally { await m.unmount() }
  })
})
