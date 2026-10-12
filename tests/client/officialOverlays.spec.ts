// 官方同行浮层的让位判据（src/client/officialOverlays.ts）。
//
// 插件卡片与官方的上下文浮层都在 `z-index: 1100`，同层时后挂载的赢。插件不该把层级
// 抬到官方之上，所以官方开着时我们自己让位。这里钉住的是「怎么算官方开着」——
// 判宽了会无故收起自己的卡片，判窄了则仍会互相压住。

import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { officialOverlayOpen } from '../../src/client/officialOverlays'

/** 一个官方形状的浮层：portal 到 body 的对话框，落在共享层级上。 */
function overlay(zIndex = '1100'): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', '上下文已用')
  el.style.zIndex = zIndex
  document.body.appendChild(el)
  // jsdom 没有布局引擎：把它说成有尺寸，才代表「真的显示着」。
  el.getBoundingClientRect = () => ({ width: 264, height: 320, top: 0, left: 0, right: 264, bottom: 320, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return el
}

afterEach(() => { document.body.innerHTML = '' })

describe('officialOverlayOpen', () => {
  test('an open official panel at the shared layer is detected', () => {
    overlay()
    assert.equal(officialOverlayOpen(), true)
  })

  test('nothing on the page reads as closed', () => {
    assert.equal(officialOverlayOpen(), false)
  })

  test('the plugin\\u2019s own card is not mistaken for the official one', () => {
    // Our card is a plain div at the same layer; the marker is `role="dialog"`.
    const mine = document.createElement('div')
    mine.className = 'lc-dock-card'
    mine.style.zIndex = '1100'
    document.body.appendChild(mine)
    assert.equal(officialOverlayOpen(), false)
  })

  test('a dialog on a different layer does not force a yield', () => {
    // Official dialogs that cover the whole UI (settings, and so on) live higher up;
    // they hide everything anyway, so reacting to them would only cause flicker.
    overlay('10000')
    assert.equal(officialOverlayOpen(), false)
  })

  test('a hidden panel does not count', () => {
    const el = overlay()
    el.style.display = 'none'
    assert.equal(officialOverlayOpen(), false)
    el.style.display = ''
    el.style.visibility = 'hidden'
    assert.equal(officialOverlayOpen(), false)
  })

  test('an unmounted-but-present zero-size panel does not count', () => {
    // The official panel renders hidden at 0,0 until its position is resolved; that
    // frame must not make us close a card the reader just opened.
    const el = overlay()
    el.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    assert.equal(officialOverlayOpen(), false)
  })

  test('a nested dialog is not scanned, only body-level ones', () => {
    // Official panels are portaled to body; a dialog inside the chat tree is not one.
    const wrapper = document.createElement('div')
    const inner = document.createElement('div')
    inner.setAttribute('role', 'dialog')
    inner.style.zIndex = '1100'
    inner.getBoundingClientRect = () => ({ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
    wrapper.appendChild(inner)
    document.body.appendChild(wrapper)
    assert.equal(officialOverlayOpen(), false)
  })
})
