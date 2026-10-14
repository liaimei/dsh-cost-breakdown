// 输入框下方那一行留给插件的可用宽度（src/client/dockRow.ts）。
//
// 这里钉住的是这条判据**连续出过的两次** bug，两次都错在「比的是哪个宽度」：
//
// 1. 最初拿**整行**宽度去比「完整读数需要多宽」。插件只是这一行里的一个条目
//    （同行还有官方用量胶囊与上下文环），线上行宽约 860px、官方占约 260px、
//    真正留给插件约 570px，读数需要约 600px——判据却拿 600 比 860，答案永远是
//    「够宽」，图标形态因此从不出现。
// 2. 改成减掉兄弟之后，减的却是兄弟**被压扁后**的占用宽度。官方读数胶囊是可压缩的
//    （`min-width:0` + 省略号），插件这条是 `flex:none`，空间不够时亏空全摊给官方：
//    它们被截成「4 ...」，占用随之变小，算出的余量反而变大——**插件越不缩，判据越说
//    够宽**。所以兄弟必须按**需要**的宽度（自然宽度）参与计算。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { naturalWidthOf, roomForEntry, type RowRoomInput } from '../../src/client/dockRow'

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

describe('naturalWidthOf', () => {
  /** A fake layout box: the visible width plus a `scrollWidth` that may be larger. */
  function box(width: number, hidden = 0, children: Element[] = []): Element {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({ width }) as DOMRect
    Object.defineProperty(el, 'clientWidth', { value: width, configurable: true })
    Object.defineProperty(el, 'scrollWidth', { value: width + hidden, configurable: true })
    for (const c of children) el.appendChild(c)
    return el
  }

  test('a box that hides nothing needs exactly its width', () => {
    assert.equal(naturalWidthOf(box(120)), 120)
  })

  test('an ellipsised box needs its width plus the content it is hiding', () => {
    // The official pills are `min-width:0; overflow:hidden; text-overflow:ellipsis`:
    // when the row squeezes them they keep their box but hide their text.
    assert.equal(naturalWidthOf(box(90, 34)), 124, 'width + hidden text')
  })

  test('a clipped descendant is counted, not just the box itself', () => {
    // The real shape: `.root > .anchor > .pill > .label`, where the LABEL is the clipper.
    const label = box(74, 34)
    const pill = box(90, 0, [label])
    const anchor = box(90, 0, [pill])
    const root = box(90, 0, [anchor])
    assert.equal(naturalWidthOf(root), 124)
  })

  test('a parent that merely propagates a clip does not double-count it', () => {
    // The parent's scrollWidth stays equal to its clientWidth while a child overflows,
    // so only the actual clipper contributes.
    const label = box(74, 34)
    const pill = box(90, 0, [label])
    assert.equal(naturalWidthOf(pill), 124, 'not 90 + 34 + 34')
  })

  test('a missing element needs nothing', () => {
    assert.equal(naturalWidthOf(null), 0)
  })

  test('a hostile node degrades to zero instead of throwing', () => {
    const hostile = document.createElement('div')
    Object.defineProperty(hostile, 'getBoundingClientRect', {
      value: () => { throw new Error('hostile layout node') },
    })
    assert.equal(naturalWidthOf(hostile), 0)
  })

  test('the compressed sibling is what makes the verdict correct, not its squashed box', () => {
    // The shipped feedback in one assertion, using the numbers Chrome reported for a
    // 560px row: the official pair had been squeezed to 295px of boxes while actually
    // needing 343px, and the plugin's full reading needs 237px.
    const squashed = 295
    const natural = 343
    const need = 237
    const room = (siblings: number): number =>
      roomForEntry({ rowWidth: 560, paddingLeft: 0, paddingRight: 0, siblingWidths: [siblings], gap: 12 })!
    // Against the squashed boxes there looks like room for the full reading…
    assert.ok(room(squashed) >= need, `${room(squashed)} >= ${need}`)
    // …and that is exactly the feedback: the plugin stays full, so the officials stay
    // squeezed. What the row actually has to hold says otherwise.
    assert.ok(room(natural) < need, `${room(natural)} < ${need}`)
  })
})
