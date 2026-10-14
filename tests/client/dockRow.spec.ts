// 输入框下方那一行留给插件的可用宽度（src/client/dockRow.ts）。
//
// 这里钉住的是一个很直接的 bug：插件原本拿**整行**宽度去比「完整读数需要多宽」，
// 而它只是这一行里的一个条目（同行还有官方用量胶囊与上下文环）。线上行宽约 860px、
// 官方占约 260px、留给插件约 570px，读数需要约 600px——判据却拿 600 比 860，
// 答案永远是「够宽」，图标形态因此从不出现。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { roomForEntry, type RowRoomInput } from '../../src/client/dockRow'

/** 默认输入：线上那一行的真实数字（整行 860px，官方兄弟共占 260px，间距 12px）。 */
function input(over: Partial<RowRoomInput> = {}): RowRoomInput {
  return {
    rowWidth: 860,
    paddingLeft: 0,
    paddingRight: 0,
    siblingWidths: [140, 120],
    gap: 12,
    ...over,
  }
}

describe('roomForEntry', () => {
  test('subtracts the siblings and the gaps, not just the row width', () => {
    // 860 - (140 + 120) - 12*2 = 576
    assert.equal(roomForEntry(input()), 576)
  })

  test('the online reading fits after the subtraction, which is the whole point', () => {
    // The bug in one line: the full reading needs ~600px against a 576px slot, so the
    // verdict must be "too narrow" — but comparing against the 860px row said "fits".
    const room = roomForEntry(input())
    assert.ok(room !== null)
    assert.ok(room < 600, 'the reading does NOT fit in what is actually left')
    assert.ok(600 < 860, 'even though it fits the row width — the old, wrong comparison')
  })

  test('the row padding comes off the content box before anything else', () => {
    // clientWidth includes padding; the entries live inside it.
    assert.equal(roomForEntry(input({ paddingLeft: 8, paddingRight: 8 })), 560)
  })

  test('a lone entry on the row gets the whole content width', () => {
    assert.equal(roomForEntry(input({ siblingWidths: [] })), 860)
  })

  test('no siblings means no gaps are charged', () => {
    // The gap count follows the sibling count: n siblings sit around n gaps.
    assert.equal(roomForEntry(input({ siblingWidths: [100] })), 748, '860 - 100 - 12')
    assert.equal(roomForEntry(input({ siblingWidths: [100, 100] })), 636, '860 - 200 - 24')
  })

  test('an over-full row floors at zero instead of going negative', () => {
    assert.equal(roomForEntry(input({ siblingWidths: [900, 900] })), 0)
  })

  test('an unmeasurable row reads as unknown, never as "no room"', () => {
    // jsdom reports 0 for every box. Unknown must fall back to the full reading rather
    // than collapsing to the icon in a bogus environment.
    assert.equal(roomForEntry(input({ rowWidth: 0 })), null)
    assert.equal(roomForEntry(input({ rowWidth: Number.NaN })), null)
  })

  test('garbage in a single field degrades that field, not the whole verdict', () => {
    assert.equal(roomForEntry(input({ paddingLeft: Number.NaN })), 576, 'a bad padding reads as 0')
    assert.equal(roomForEntry(input({ gap: -5 })), 600, 'a negative gap reads as 0')
    assert.equal(roomForEntry(input({ siblingWidths: [Number.NaN, 120] })), 716, 'a bad sibling reads as 0')
  })
})
