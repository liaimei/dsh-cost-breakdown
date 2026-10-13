// StatsContext (src/client/components/statsContext.tsx) rendered in both locales against an injected model-price book (the store never
// reaches the network). Connector geometry is pinned through measureFlow's unit tests (jsdom has no layout); the event rows live on the
// events card (contextView.spec.ts). `countsOfRecords` and `toolTallyOf` derive the tallies the split generation's slim head carries.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi, beforeEach } from 'vitest'
import { countsOfRecords, flowCurve, makeStatsContext, makeSubagentCost, measureFlow, toolTallyOf } from '../../../src/client/components/statsContext'
import type { SubagentStats } from '../../../src/client/components/statsContext'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import type { ContextEventRecord, ContextTimeline, RequestRecord, SessionCostUsage, SurfaceNode } from '../../../src/shared/types'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const NO_SUB = (): SubagentStats => ({ usage: null, count: 0 })
const StatsContext = makeStatsContext(kit, NO_SUB)
const StatsContextZh = makeStatsContext(kitZh, NO_SUB)

/** A minimal real-shaped slice of the models.dev /api.json payload. */
const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  zhipuai: { models: { 'glm-5.3-flash': { cost: { input: 0.075, output: 0.25, cache_read: 0.015, cache_write: 0 } } } },
}

const COST: SessionCostUsage = {
  'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
}

const NO_FILES = { reads: 0, writes: 0, searches: 0, images: 0 }
const NO_COUNTS = { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 }

function req(turn?: number): RequestRecord {
  return {
    time: 0, seq: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...(turn !== undefined ? { turn } : {}),
  }
}

function ev(kind: ContextEventRecord['kind']): ContextEventRecord {
  return { seq: 0, time: 0, kind }
}

/** A skill-tagged inject event the way the host fold stamps it (fold.ts). */
function skillEv(name: string): ContextEventRecord {
  return { seq: 0, time: 0, kind: 'inject', form: 'instructions', sub: 'skill', name }
}

/** The five flow nodes in DOM order: inputs / events / session / tools / cost. */
function flowNodes(container: HTMLElement): HTMLElement[] {
  return queryAll(container, '.lc-flow-node')
}

/** One node's pills as 'label+figure' strings (tips excluded). */
function pillsOf(node: HTMLElement): string[] {
  return queryAll(node, '.lc-flow-pill').map(el => (el.querySelector('.lc-flow-pill-label')?.textContent ?? '') + (el.querySelector('b')?.textContent ?? ''))
}

/** The team ledger's rows as 'label+pair' strings (tips excluded). */
function rowsOf(node: HTMLElement): string[] {
  return queryAll(node, '.lc-flow-row').map(el => (el.querySelector('.lc-flow-row-label')?.textContent ?? '') + (el.querySelector('.lc-flow-pair')?.textContent ?? ''))
}

function headsOf(container: HTMLElement): { labels: string[]; totals: string[] } {
  const heads = queryAll(container, '.lc-flow-head')
  return {
    labels: heads.map(el => el.querySelector('.lc-flow-label')?.textContent ?? ''),
    totals: heads.map(el => el.querySelector('.lc-flow-total')?.textContent ?? ''),
  }
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
})

afterEach(() => {
  resetModelPrices()
})

describe('countsOfRecords (the inline generation derivation)', () => {
  test('tallies distinct turns, records, the three priced event kinds, and the distinct loaded skills', () => {
    // Two steps in turn 1, one in turn 2, one without a turn (folds as turn 0).
    const counts = countsOfRecords(
      [req(1), req(1), req(2), req()],
      [
        ev('inject'), ev('inject'), ev('inject'), ev('compaction'), ev('compaction'), ev('prune'), ev('model'), ev('mode'),
        // Skill loads and a `/name` invocation count by DISTINCT name; the
        // available-skills catalog digest rides an untagged inject event and never lands in the tally.
        skillEv('grilling'), skillEv('grilling'), skillEv('ponytail'),
        { ...ev('inject'), name: 'available-skills' },
        // Hostile shapes skip: a nameless tag and a non-string name.
        { ...ev('inject'), sub: 'skill' },
        { ...ev('inject'), sub: 'skill', name: 5 } as unknown as ContextEventRecord,
      ],
    )
    // model/mode events do not appear (only the three priced kinds do); every
    // inject above rides kind 'inject', the catalog digest and hostile shapes
    // included — only the skills TALLY filters by the tag.
    assert.deepEqual(counts, { turns: 3, steps: 4, injects: 9, compactions: 2, prunes: 1, skills: 2 })
  })

  test('empty collections tally zero', () => {
    assert.deepEqual(countsOfRecords([], []), { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: 0 })
  })
})

describe('toolTallyOf (the live-surface per-tool tally)', () => {
  const node = (cat: SurfaceNode['cat'], tool?: string): SurfaceNode => ({ seq: 0, cat, tokens: 0, ...(tool !== undefined ? { tool } : {}) })

  test('folds the host predicate: tool results, plus skill nodes carrying a tool', () => {
    const tally = toolTallyOf([
      node('tool', 'read'), node('tool', 'read'), node('tool', 'bash'),
      node('skill', 'run_code'), // a skill node carrying a tool counts
      node('skill'), // a bare skill node does not
      node('user'), node('assistant'),
      node('tool'), // an unnamed result counts toward the head figure but rides no pill
    ])
    assert.deepEqual(tally, [['read', 2], ['bash', 1], ['run_code', 1]])
  })

  test('sorts count-desc then name-asc, skipping hostile shapes', () => {
    const tally = toolTallyOf([
      node('tool', 'bash'), node('tool', 'read'), node('tool', 'read'),
      { seq: 0, cat: 'tool', tokens: 0, tool: 5 } as unknown as SurfaceNode,
      node('tool', ''),
    ])
    assert.deepEqual(tally, [['read', 2], ['bash', 1]])
  })

  test('count ties break name-asc in either insertion order', () => {
    assert.deepEqual(toolTallyOf([node('tool', 'zed'), node('tool', 'apple')]), [['apple', 1], ['zed', 1]])
    assert.deepEqual(toolTallyOf([node('tool', 'apple'), node('tool', 'zed')]), [['apple', 1], ['zed', 1]])
  })
})

describe('measureFlow (the connector geometry)', () => {
  const boxes = {
    inputs: { x: 0, y: 0, w: 100, h: 40 },
    events: { x: 0, y: 60, w: 100, h: 80 },
    session: { x: 160, y: 30, w: 120, h: 80 },
    tools: { x: 340, y: 0, w: 100, h: 40 },
    cost: { x: 340, y: 60, w: 100, h: 80 },
  }

  test('horizontal mode flows left→right, fanning the session edge at ⅓ and ⅔, colored by element', () => {
    const links = measureFlow(boxes, true)
    assert.equal(links.length, 4)
    // inputs→session: inputs' right-center to the session's left edge at ⅓ (control distance 30 = half the 60px gap).
    assert.equal(links[0].d, `M 100 20 C 130 20 130 ${30 + 80 * (1 / 3)} 160 ${30 + 80 * (1 / 3)}`)
    // events→session: events' right-center to the session's left edge at ⅔.
    assert.equal(links[1].d, `M 100 100 C 130 100 130 ${30 + 80 * (2 / 3)} 160 ${30 + 80 * (2 / 3)}`)
    // session→tools: the session's right edge at ⅓ to tools' left-center.
    assert.equal(links[2].d, `M 280 ${30 + 80 * (1 / 3)} C 310 ${30 + 80 * (1 / 3)} 310 20 340 20`)
    // session→cost: the session's right edge at ⅔ to cost's left-center.
    assert.equal(links[3].d, `M 280 ${30 + 80 * (2 / 3)} C 310 ${30 + 80 * (2 / 3)} 310 100 340 100`)
    assert.deepEqual(links.map(l => l.color), [
      'var(--color-green-500)', 'var(--color-purple-500)', 'var(--color-teal-500)', 'var(--color-pink-500)',
    ])
  })

  test('vertical mode flows top→bottom with the same fan', () => {
    const links = measureFlow(boxes, false)
    assert.equal(links.length, 4)
    // inputs→session: inputs' bottom-center to the session's top edge at ⅓; the 10px gap floors the control distance at 18.
    assert.equal(links[0].d, `M 50 40 C 50 58 ${160 + 120 * (1 / 3)} 12 ${160 + 120 * (1 / 3)} 30`)
    // session→cost: the session's bottom edge at ⅔ to cost's top-center; control distance 25 = half the 50px gap.
    assert.equal(links[3].d, `M ${160 + 120 * (2 / 3)} 110 C ${160 + 120 * (2 / 3)} 135 390 35 390 60`)
  })

  test('flowCurve floors the control distance so near neighbors still bow', () => {
    assert.equal(
      flowCurve({ x: 0, y: 0, dx: 1, dy: 0 }, { x: 20, y: 0, dx: -1, dy: 0 }),
      'M 0 0 C 18 0 2 0 20 0',
    )
  })
})

describe('StatsContext', () => {
  test('folds the flow: source cards feed the session node, which drains into the effect cards', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1, skills: 2 },
      humanInputs: 7,
      answers: 3,
      toolCalls: 12,
      files: { reads: 9, writes: 2, searches: 4, images: 1 },
      tools: [['read', 8], ['bash', 3], ['grep', 2], ['edit', 1], ['glob', 1]],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(text(m.container).includes('Context Stats'))
    const nodes = flowNodes(m.container)
    const { labels, totals } = headsOf(m.container)
    assert.deepEqual(labels, ['Input / Output', 'Context Events', 'Tool Calls', 'Agent Network?'])
    // I/O totals the inputs plus every file op (7 + 9 + 2 + 4 + 1); the family header
    // carries the billed TOKEN face only — money lives in the platform spend section.
    assert.deepEqual(totals, ['23', '6', '12', '1.0M'])
    assert.deepEqual(pillsOf(nodes[0]), ['Human Inputs?7', 'Read9', 'Written2', 'Searched4', 'Images1'])
    assert.deepEqual(pillsOf(nodes[1]), ['Inject3', 'Compact2', 'Prune1'])
    // The three most-called tools pill out; the rest fold into the overflow pill.
    assert.deepEqual(pillsOf(nodes[3]), ['read8', 'bash3', 'grep2', '+2 more'])
    assert.deepEqual(rowsOf(nodes[4]), ['Current Agent1.0M', 'Subagents × 0?0'])
    // The session node carries two figure rows under its label — turns/steps
    // above skill loads/answers (two skills, three answers above).
    assert.equal(nodes[2].querySelector('.lc-flow-label')?.textContent, 'Current Session')
    const selfRows = queryAll(nodes[2], '.lc-flow-self-stats')
    assert.deepEqual(selfRows.map(row => queryAll(row, '.lc-flow-kv b').map(el => el.textContent)), [['3', '4'], ['2', '3']])
    assert.deepEqual(selfRows.map(row => queryAll(row, '.lc-flow-kv i').map(el => el.textContent)), [['Turns', 'Steps'], ['Skill Loads', 'Answers']])
    // The event pills tint by the events card's own kind classes.
    assert.ok(nodes[1].querySelector('.lc-flow-pill.lc-kind-inject') !== null)
    assert.ok(nodes[1].querySelector('.lc-flow-pill.lc-kind-prune') !== null)
    assert.equal(queryAll(m.container, '.lc-stat-tip').length, 3, 'the inputs-pill, family, and sub-row tips')
    // The four connectors, two layers each (jsdom measures zeroed boxes — the geometry itself is measureFlow's pin).
    assert.equal(queryAll(m.container, '.lc-flow-ribbon').length, 4)
    assert.equal(queryAll(m.container, '.lc-flow-dash').length, 4)
    await m.unmount()
  })

  test('absent counters and cost degrade to zeros, dimmed pills, and the dash', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(headsOf(m.container).totals, ['0', '0', '0', '0'])
    const nodes = flowNodes(m.container)
    assert.deepEqual(pillsOf(nodes[0]), ['Human Inputs?0', 'Read0', 'Written0'], 'searches/images pill only when they happened')
    assert.deepEqual(pillsOf(nodes[3]), [], 'no tool pills without calls')
    assert.deepEqual(rowsOf(nodes[4]), ['Current Agent0', 'Subagents × 0?0'])
    assert.equal(queryAll(nodes[0], '.lc-flow-pill-dim').length, 3, 'every zero pill dims')
    assert.equal(queryAll(nodes[1], '.lc-flow-pill-dim').length, 3)
    await m.unmount()
  })

  test('the tools total falls back to the tally sum on hosts too old to carry it', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [['read', 8], ['bash', 3]],
      locale: 'en',
    }))
    await flush()
    assert.equal(headsOf(m.container).totals[2], '11')
    const nodes = flowNodes(m.container)
    assert.deepEqual(pillsOf(nodes[3]), ['read8', 'bash3'], 'two tools pill out, no overflow')
    await m.unmount()
  })

  test('the family and subagent tips scope their token figures, with no money anywhere', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.equal(tips.length, 3, 'the inputs-pill, family, and sub-row tips')
    assert.ok(tips[0].includes('question answerings'), 'the human-inputs tip explains its tally')
    assert.ok(tips[1].includes('descendant subagent'), 'the family tip names the scope')
    assert.ok(tips[1].includes('billed tokens only'))
    assert.ok(tips[2].includes('descendant subagent'), 'the sub tip spells out the subtree covers all levels')
    // A money figure must never appear in this card, at any locale or scope.
    for (const tip of tips) assert.ok(!tip.includes('$') && !tip.includes('¥'), tip)
    assert.ok(!text(m.container).includes('$'))
    await m.unmount()
  })

  test('the zh locale localizes the cards but prices nothing', async () => {
    const m = await mount(h(StatsContextZh, {
      counts: { turns: 1, steps: 1, injects: 0, compactions: 1, prunes: 0, skills: 5 },
      answers: 4,
      files: { reads: 2, writes: 1, searches: 0, images: 0 },
      tools: [['read', 2]],
      cost: COST,
      locale: 'zh',
    }))
    await flush()
    assert.ok(text(m.container).includes('上下文统计'))
    const nodes = flowNodes(m.container)
    const { labels, totals } = headsOf(m.container)
    assert.deepEqual(labels, ['输入输出', '上下文事件', '工具调用', 'Agent 网络?'])
    assert.deepEqual(totals, ['3', '1', '2', '1.0M'])
    assert.deepEqual(pillsOf(nodes[0]), ['用户输入?0', '读取2', '写入1'])
    assert.deepEqual(pillsOf(nodes[1]), ['注入0', '压缩1', '剪枝0'])
    assert.deepEqual(pillsOf(nodes[3]), ['read2'])
    assert.deepEqual(rowsOf(nodes[4]), ['当前 Agent1.0M', '子 Agent × 0?0'])
    assert.equal(nodes[2].querySelector('.lc-flow-label')?.textContent, '当前会话')
    const selfRowsZh = queryAll(nodes[2], '.lc-flow-self-stats')
    assert.deepEqual(selfRowsZh.map(row => queryAll(row, '.lc-flow-kv i').map(el => el.textContent)), [['轮次', '步数'], ['技能加载', '模型回复']])
    assert.deepEqual(selfRowsZh.map(row => queryAll(row, '.lc-flow-kv b').map(el => el.textContent)), [['1', '1'], ['5', '4']])
    const costTip = text(queryAll(m.container, '.lc-stat-tip')[1])
    assert.ok(costTip.includes('含当前智能体及所有层级的子智能体'), 'the tip names the family scope')
    assert.ok(!costTip.includes('¥'))
    await m.unmount()
  })

  test('token figures stand on their own: no price book is needed to read them', async () => {
    setModelPricesLoader(() => new Promise(() => {}))
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    assert.ok(headsOf(m.container).totals[3] === '1.0M', 'a pending book cannot blank a token count')
    assert.ok(!text(m.container).includes('unavailable'), 'a pending fetch is not a failure')
    await m.unmount()
  })

  test('an unpriceable model still reports its billed tokens — dashes were a money concern', async () => {
    setModelPricesLoader(() => Promise.reject(new Error('down')))
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: { 'kimi-coding': { 'kimi-k2.7-code': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
      locale: 'en',
    }))
    await flush()
    assert.ok(headsOf(m.container).totals[3] === '1.0M', 'metered tokens are exact regardless of pricing')
    await m.unmount()
  })

  test('a hostile cost branch cannot break the token tallies', async () => {
    const hostile = {
      junk: 5,
      'zai-coding-cn': {
        'glm-5.3-flash': {
          peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    } as unknown as SessionCostUsage
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: hostile,
      locale: 'en',
    }))
    await flush()
    assert.ok(headsOf(m.container).totals[3] === '2.0M')
    await m.unmount()
  })

  test('clicking the team card scrolls its Agent-network namesake into view', async () => {
    const linked: SessionCostUsage = {
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const m = await mount(h('div', { className: 'lc-root', style: { overflowY: 'auto' } },
      h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: linked, locale: 'en' }),
      h('div', { className: 'lc-agents' }),
    ))
    await flush()
    const root = query(m.container, '.lc-root')
    const agents = query(m.container, '.lc-agents')
    // jsdom reports 0 for both — the wrapper must overflow to be the operative scroller.
    Object.defineProperty(root, 'scrollHeight', { value: 500 })
    Object.defineProperty(root, 'clientHeight', { value: 200 })
    agents.getBoundingClientRect = () => ({ top: 120 }) as DOMRect
    const team = query(m.container, '.lc-flow-team')
    await click(team)
    assert.equal(root.scrollTop, 120)
    root.scrollTop = 0
    // No header of this card is a link: money left with its own section.
    assert.equal(queryAll(m.container, 'a.lc-flow-head').length, 0)
    // Keyboard parity: Enter/Space reveal, anything else stays quiet.
    team.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    assert.equal(root.scrollTop, 120)
    root.scrollTop = 0
    team.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    assert.equal(root.scrollTop, 0)
    await m.unmount()
  })

  test('without the namesake card a click is a quiet no-op', async () => {
    // No .lc-root ancestor at all.
    const bare = await mount(h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, locale: 'en' }))
    await click(query(bare.container, '.lc-flow-team'))
    await bare.unmount()
    // A .lc-root without the Agent network card in it (a harness that hides it).
    const m = await mount(h('div', { className: 'lc-root' },
      h(StatsContext, { counts: NO_COUNTS, files: NO_FILES, tools: [], cost: COST, locale: 'en' }),
    ))
    await click(query(m.container, '.lc-flow-team'))
    await m.unmount()
  })

  test('the second-row figures fire onFigureClick on click and keyboard', async () => {
    const calls: string[] = []
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      answers: 1,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      onFigureClick: (f) => { calls.push(f) },
    }))
    await flush()
    const cells = queryAll(m.container, '.lc-flow-kv-btn')
    assert.equal(cells.length, 2)
    assert.equal(cells[0].getAttribute('role'), 'button')
    assert.ok(cells[0].getAttribute('title') !== null && cells[0].getAttribute('title') !== '', 'the jump tip rides')
    await click(cells[0])
    assert.deepEqual(calls, ['skills'])
    cells[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    assert.deepEqual(calls, ['skills', 'answers'])
    cells[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    assert.deepEqual(calls, ['skills', 'answers'])
    await m.unmount()
  })

  test('without onFigureClick the figure cells stay inert', async () => {
    const m = await mount(h(StatsContext, { counts: NO_COUNTS, answers: 1, files: NO_FILES, tools: [], locale: 'en' }))
    await flush()
    const cells = queryAll(m.container, '.lc-flow-kv')
    assert.ok(cells.every(c => c.getAttribute('role') === null && !c.className.includes('lc-flow-kv-btn')))
    await m.unmount()
  })
})

describe('StatsContext — the subagent split (injected seat)', () => {
  const SUB: SessionCostUsage = {
    'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
  }

  test('the family figure merges the subagent tokens in; each share stays readable', async () => {
    const Stats = makeStatsContext(kit, () => ({ usage: SUB, count: 2 }))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      cost: COST,
      locale: 'en',
    }))
    await flush()
    // Family total: the own 1M plus the subagents' 2M, and nothing else.
    assert.equal(headsOf(m.container).totals[3], '3.0M')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent1.0M', 'Subagents × 2?2.0M'])
    assert.deepEqual(queryAll(flowNodes(m.container)[4], '.lc-flow-row-label').map(el => el.textContent), ['Current Agent', 'Subagents × 2?'])
    const tips = queryAll(m.container, '.lc-stat-tip').map(el => text(el))
    assert.ok(tips[2].includes('descendant subagent'), 'the sub tip names the subtree')
    assert.ok(tips[2].includes('all levels'))
    await m.unmount()
  })

  test('subagent usage alone still counts the family, with the own share at zero', async () => {
    const Stats = makeStatsContext(kit, () => ({ usage: SUB, count: 1 }))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    assert.equal(headsOf(m.container).totals[3], '2.0M')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0', 'Subagents × 1?2.0M'])
    await m.unmount()
  })

  test('a null seat keeps the ledger zeroed with no outage notes', async () => {
    const m = await mount(h(StatsContext, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    assert.equal(headsOf(m.container).totals[3], '0')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0', 'Subagents × 0?0'])
    assert.ok(!text(m.container).includes('unavailable'))
    await m.unmount()
  })
})

describe('StatsContext — the real subagent-cost seat (makeSubagentCost)', () => {
  /** A well-formed slim head with (or without) a cost usage. */
  function head(cost?: SessionCostUsage): ContextTimeline {
    return {
      ok: true,
      contextWindow: 1000,
      current: { system: 10, tools: 10, user: 80, inject: 0, skill: 0, assistant: 0, tool: 0, total: 100 },
      requests: [],
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
      ...(cost !== undefined ? { cost } : {}),
    }
  }

  /** A sessions face double with the list-feed contract (agentGraph.spec's shape). */
  class FakeSessions {
    private listeners = new Set<() => void>()
    state: unknown
    constructor(byId: Record<string, unknown>) {
      this.state = { byId }
    }
    readonly list = {
      getSnapshot: (): unknown => this.state,
      subscribe: (fn: () => void): (() => void) => {
        this.listeners.add(fn)
        return () => { this.listeners.delete(fn) }
      },
    }
    setState(byId: Record<string, unknown>): void {
      this.state = { byId }
      for (const fn of this.listeners) fn()
    }
  }

  function makeSeat(byId: Record<string, unknown>): { seat: (sessionId: string | undefined) => SubagentStats; face: FakeSessions } {
    const face = new FakeSessions(byId)
    const ctx = new TestClientCtx({ services: { sessions: face } })
    return { seat: makeSubagentCost(asClientCtx(ctx), makeAgentHeads()), face }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('warm rows fold live; cold rows fetch once and land; snapshot ticks never refetch', async () => {
    const calls: string[] = []
    let release: ((value: unknown) => void) | undefined
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      // Hold the read until the warm-only paint is asserted.
      return await new Promise((resolve) => { release = resolve })
    })
    const SUB_WARM: SessionCostUsage = {
      'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      warm: { parentId: 'root', updatedAt: 2, projectionValues: { contextTimeline: head(SUB_WARM) } },
      cold: { parentId: 'root', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    // The warm row's tokens count while the cold read is still in flight.
    assert.equal(headsOf(m.container).totals[3], '2.0M')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0', 'Subagents × 2?2.0M'])
    assert.deepEqual(calls, ['cold'], 'only the timeline-less relative fetched')
    // Both descendants count in the ledger's subtree row, cold included.
    assert.deepEqual(queryAll(flowNodes(m.container)[4], '.lc-flow-row-label').map(el => el.textContent), ['Current Agent', 'Subagents × 2?'])
    // A snapshot tick while the read is in flight re-attaches the SAME
    // pending read; when it lands, the duplicate settle bails on identity.
    await act(async () => {
      face.setState({
        root: { running: false, updatedAt: 1 },
        warm: { parentId: 'root', updatedAt: 2, projectionValues: { contextTimeline: head(SUB_WARM) } },
        cold: { parentId: 'root', updatedAt: 3 },
      })
    })
    await flush()
    // The cold read lands: its 2M merges into the family and the sub share.
    await act(async () => {
      release?.({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: {
            rev: 1,
            head: head({ 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } }),
            requests: [],
            events: [],
            nodes: [],
            droppedNodes: 0,
            archive: [],
          },
        }),
      })
    })
    await flush()
    assert.equal(headsOf(m.container).totals[3], '4.0M')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0', 'Subagents × 2?4.0M'])
    await m.unmount()
  })

  test('a failing cold fetch degrades the card without crashing or retrying', async () => {    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      throw new Error('transport down')
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      cold: { parentId: 'root', updatedAt: 2 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.deepEqual(calls, ['cold'])
    assert.equal(headsOf(m.container).totals[3], '0')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0', 'Subagents × 1?0'])
    // The cold descendant still counts in the ledger's subtree row — a subagent is one whether or not its usage priced.
    assert.deepEqual(queryAll(flowNodes(m.container)[4], '.lc-flow-row-label').map(el => el.textContent), ['Current Agent', 'Subagents × 1?'])
    // A later snapshot tick re-folds the subtree; the sticky failure never re-fetches.
    await act(async () => {
      face.setState({ root: { running: false, updatedAt: 1 }, cold: { parentId: 'root', updatedAt: 2 } })
    })
    await flush()
    assert.deepEqual(calls, ['cold'])
    await m.unmount()
  })

  test('a headless detail answer (or a null value) lands nothing and never retries', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      // The head is optional on the payload; a null value answers absence.
      const headless = { rev: 1, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: calls.length === 1 ? headless : null }),
      }
    })
    const { seat, face } = makeSeat({
      root: { running: false, updatedAt: 1 },
      headless: { parentId: 'root', updatedAt: 2 },
      absent: { parentId: 'root', updatedAt: 3 },
    })
    const Stats = makeStatsContext(kit, seat)
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.deepEqual(calls, ['headless', 'absent'])
    // Neither read carried a head: nothing lands, the figures stay zeroed, no throw.
    assert.equal(headsOf(m.container).totals[3], '0')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0', 'Subagents × 2?0'])
    // A later tick re-attaches to the settled nulls without re-fetching.
    await act(async () => {
      face.setState({
        root: { running: false, updatedAt: 1 },
        headless: { parentId: 'root', updatedAt: 2 },
        absent: { parentId: 'root', updatedAt: 3 },
      })
    })
    await flush()
    assert.deepEqual(calls, ['headless', 'absent'])
    await m.unmount()
  })

  test('without the sessions face the seat prices nothing', async () => {
    const ctx = new TestClientCtx()
    const Stats = makeStatsContext(kit, makeSubagentCost(asClientCtx(ctx), makeAgentHeads()))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
      sessionId: 'root',
    }))
    await flush()
    assert.equal(headsOf(m.container).totals[3], '0')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0', 'Subagents × 0?0'])
    await m.unmount()
  })

  test('an absent session id folds nothing (and fetches nothing)', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push(String((JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId))
      throw new Error('must not fetch')
    })
    const face = new FakeSessions({ root: { running: false, updatedAt: 1 }, kid: { parentId: 'root', updatedAt: 2 } })
    const ctx = new TestClientCtx({ services: { sessions: face } })
    const Stats = makeStatsContext(kit, makeSubagentCost(asClientCtx(ctx), makeAgentHeads()))
    const m = await mount(h(Stats, {
      counts: NO_COUNTS,
      files: NO_FILES,
      tools: [],
      locale: 'en',
    }))
    await flush()
    assert.deepEqual(calls, [])
    assert.equal(headsOf(m.container).totals[3], '0')
    assert.deepEqual(rowsOf(flowNodes(m.container)[4]), ['Current Agent0', 'Subagents × 0?0'])
    await m.unmount()
  })
})
