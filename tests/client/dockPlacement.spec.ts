// 展开卡的定位几何（src/client/dockPlacement.ts）。
//
// 这里钉住的是一个真实发生过的 bug：触发条贴在窗口底部、卡片内容高达 909px 时，
// 旧算法「只看上方放不下就翻转」，把卡片推到 900px 视口的 y=912（屏幕之外），
// 同时被硬编码的最小高度压成 120px 的窄带。点得动、state 也对——就是看不见。

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { placeDockCard, type PlacementInput } from '../../src/client/dockPlacement'

/** 默认输入：1440×900 视口，触发条位于底部，内容 909px（截图里的真实数字）。 */
function input(over: Partial<PlacementInput> = {}): PlacementInput {
  return {
    trigger: { top: 890, left: 500, width: 300, bottom: 906 },
    viewport: { width: 1440, height: 900 },
    natural: 909,
    preferredWidth: 440,
    gutter: 12,
    gap: 8,
    minHeight: 160,
    ...over,
  }
}

describe('placeDockCard — the geometry that decides whether the card is visible', () => {
  test('the reported failure: a bottom-hugging trigger keeps the card on screen', () => {
    const a = placeDockCard(input())
    // The card must start inside the viewport and be tall enough to read.
    assert.ok(a.top >= 0 && a.top < 900, `top ${a.top} must be on screen`)
    assert.ok(a.maxHeight >= 160, `height ${a.maxHeight} must be usable`)
    // And its top edge must not sit past the bottom edge, which is what made it vanish.
    assert.ok(a.top <= 900 - 16, 'the card starts above the viewport bottom')
  })

  test('a trigger near the bottom prefers the roomy side, not the cramped one', () => {
    // Above has 878px, below has none: flipping would be strictly worse.
    const a = placeDockCard(input())
    assert.ok(a.top < 890, 'placed above the trigger, where the space is')
  })

  test('a trigger at the very top flips below, where the room is', () => {
    const a = placeDockCard(input({
      trigger: { top: 10, left: 500, width: 300, bottom: 30 },
      natural: 600,
    }))
    assert.ok(a.top > 30, 'below the trigger')
    assert.ok(a.maxHeight > 600 - 1, 'and it gets the space it needs')
  })

  test('flipping only happens when the other side is genuinely roomier', () => {
    // Above is cramped (188px) but below is worse (100px): stay above rather than move
    // the card into a tighter slot just because the top one is short.
    const a = placeDockCard(input({
      trigger: { top: 200, left: 500, width: 300, bottom: 788 },
      natural: 400,
    }))
    assert.ok(a.top < 200, 'stayed above, where there is more room')
  })

  test('short content never flips and needs no clamping', () => {
    const a = placeDockCard(input({ natural: 200 }))
    assert.equal(a.maxHeight, Math.max(160, 890 - 12), 'the full side is available')
    assert.ok(a.top < 890)
  })

  test('width follows the content preference but stays inside the viewport', () => {
    const wide = placeDockCard(input({ preferredWidth: 2000 }))
    assert.ok(wide.left >= 12 && wide.left + wide.width <= 1440 - 12, 'clamped on both sides')
    const narrow = placeDockCard(input({ preferredWidth: 100 }))
    assert.equal(narrow.width, 300, 'never narrower than the trigger')
  })

  test('the minimum height is a floor, so a cramped side still yields a readable card', () => {
    // Both sides nearly empty: the card may overflow, but not collapse to a sliver.
    const a = placeDockCard(input({
      trigger: { top: 430, left: 500, width: 300, bottom: 446 },
      viewport: { width: 1440, height: 900 },
      natural: 900,
    }))
    assert.ok(a.maxHeight >= 160, `got ${a.maxHeight}`)
  })
})
