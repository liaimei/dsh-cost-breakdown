/**
 * The dock row's width verdict and the expanded card's placement — the two pieces the earlier
 * implementation records two regressions for.
 *
 * The verdict must subtract siblings' **needed** widths (not their squashed ones) or it feeds back: as the
 * official pills shrink, the arithmetic claims more room and the plugin never collapses. The card must
 * prefer above and flip only when below is genuinely roomier, or it lands off-screen as a sliver.
 */

import { describe, expect, it } from 'vitest'
import { CARD_MIN_WIDTH, neededWidthOf, placeCard, roomForEntry } from '../../src/client/ui/dock/measure'

describe('roomForEntry', () => {
  it('returns null when the row cannot be measured', () => {
    // jsdom and the first unlaid-out frame measure 0; "cannot measure" must read as "fits".
    expect(roomForEntry({ rowWidth: 0, paddingLeft: 0, paddingRight: 0, siblingWidths: [], gap: 0 })).toBeNull()
  })

  it('subtracts paddings, the siblings needed widths and the gaps', () => {
    // 860 − 16 − 16 − (200 + 60) − 2 gaps × 12 = 544
    const room = roomForEntry({ rowWidth: 860, paddingLeft: 16, paddingRight: 16, siblingWidths: [200, 60], gap: 12 })
    expect(room).toBe(544)
  })

  it('never returns a negative room', () => {
    expect(roomForEntry({ rowWidth: 100, paddingLeft: 10, paddingRight: 10, siblingWidths: [90], gap: 4 })).toBe(0)
  })

  it('treats a NaN or negative measurement as zero', () => {
    const room = roomForEntry({ rowWidth: 300, paddingLeft: Number.NaN, paddingRight: -5, siblingWidths: [-10], gap: Number.NaN })
    expect(room).toBe(300)
  })
})

describe('neededWidthOf', () => {
  it('measures nothing for an absent element', () => {
    expect(neededWidthOf(null)).toBe(0)
  })
})

describe('placeCard', () => {
  const viewport = { width: 1200, height: 900 }

  it('places the card above the trigger when it fits', () => {
    const placement = placeCard({
      trigger: { left: 400, top: 700, bottom: 720 },
      viewport,
      natural: 300,
      cardWidth: 440,
    })
    expect(placement.flip).toBe(false)
    expect(placement.top).toBe(700 - 300 - 8)
    expect(placement.width).toBe(440)
    expect(placement.maxHeight).toBeGreaterThanOrEqual(300)
  })

  it('flips below only when below is roomier', () => {
    const placement = placeCard({
      trigger: { left: 400, top: 120, bottom: 140 },
      viewport,
      natural: 400,
      cardWidth: 440,
    })
    expect(placement.flip).toBe(true)
    expect(placement.top).toBe(148)
  })

  it('does not flip into an even smaller space', () => {
    // Both sides are tight; staying above avoids an invisible sliver below the composer.
    const placement = placeCard({
      trigger: { left: 40, top: 500, bottom: 520 },
      viewport: { width: 600, height: 560 },
      natural: 400,
      cardWidth: 440,
    })
    expect(placement.flip).toBe(false)
    expect(placement.maxHeight).toBeGreaterThanOrEqual(160)
  })

  it('clamps the width into the viewport and the floor', () => {
    const narrow = placeCard({
      trigger: { left: 10, top: 400, bottom: 420 },
      viewport: { width: 320, height: 700 },
      natural: 200,
      cardWidth: 440,
    })
    expect(narrow.width).toBeLessThanOrEqual(320 - 24)
    expect(narrow.width).toBeGreaterThanOrEqual(CARD_MIN_WIDTH)
  })
})
