// The official DeepSeek CNY price book (src/shared/officialRates.ts): the price
// rows, the Beijing peak windows, the Chinese public-holiday calendar that bills a
// holiday off-peak all day, and the two boundary narrowings (model id, config table).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  allDayOffReason,
  beijingParts,
  countdownParts,
  DEFAULT_HOLIDAYS,
  holidaysFrom,
  isPeakBeijing,
  matchOfficialModel,
  msUntilFlip,
  officialRateOf,
  OFFICIAL_MODELS,
  PEAK_WINDOWS,
  peakWindowsText,
  periodAt,
} from '../../src/shared/officialRates'

/** A Beijing wall-clock instant as epoch ms (UTC+8, so subtract 8h). */
function beijing(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

describe('the official price book', () => {
  test('carries the two DeepSeek rows with off-peak exactly half of peak', () => {
    assert.deepEqual(OFFICIAL_MODELS.map(r => r.id), ['deepseek-flash', 'deepseek-v4-pro'])
    for (const row of OFFICIAL_MODELS) {
      for (const key of ['hit', 'miss', 'out'] as const) {
        assert.equal(row.peak[key], row.offPeak[key] * 2, `${row.id}.${key}`)
      }
    }
    // The published list, spelled out: the table is the contract.
    const flash = OFFICIAL_MODELS[0]
    assert.deepEqual(flash.offPeak, { hit: 0.02, miss: 1, out: 4 })
    assert.deepEqual(flash.peak, { hit: 0.04, miss: 2, out: 8 })
    const pro = OFFICIAL_MODELS[1]
    assert.deepEqual(pro.offPeak, { hit: 0.15, miss: 4.5, out: 13.5 })
    assert.deepEqual(pro.peak, { hit: 0.3, miss: 9, out: 27 })
  })

  test('every row is reachable through its id and every alias, case-insensitively', () => {
    for (const row of OFFICIAL_MODELS) {
      for (const id of [row.id, ...row.aliases]) {
        assert.equal(matchOfficialModel(id)?.id, row.id, id)
        assert.equal(matchOfficialModel(id.toUpperCase())?.id, row.id, `${id} uppercased`)
        assert.equal(matchOfficialModel(`  ${id}  `)?.id, row.id, `${id} padded`)
      }
    }
  })

  test('an unlisted or non-string id matches nothing (no substring guessing)', () => {
    // A bare `pro`/`flash` guess would hand a foreign vendor's model DeepSeek's rates.
    for (const id of ['kimi-k2.7-code', 'gpt-x', 'deepseek-v4-pro-0813', 'flash', 'pro', '', '   ', 'deepseek']) {
      assert.equal(matchOfficialModel(id), null, JSON.stringify(id))
    }
    for (const id of [null, undefined, 7, {}, []]) {
      assert.equal(matchOfficialModel(id), null, JSON.stringify(id))
    }
  })

  test('officialRateOf picks the period row, or null for an unlisted id', () => {
    assert.deepEqual(officialRateOf('deepseek-v4.1-flash', false), OFFICIAL_MODELS[0].offPeak)
    assert.deepEqual(officialRateOf('deepseek-v4.1-flash', true), OFFICIAL_MODELS[0].peak)
    assert.deepEqual(officialRateOf('deepseek-pro', false), OFFICIAL_MODELS[1].offPeak)
    assert.equal(officialRateOf('kimi-k2.7-code', true), null)
  })
})

describe('Beijing wall-clock parts', () => {
  test('reports the Beijing calendar date and weekday, not the machine’s', () => {
    // 2026-01-05 00:30 Beijing is still 2026-01-04 in UTC.
    const parts = beijingParts(beijing(2026, 1, 5, 0, 30))
    assert.equal(parts.date, '2026-01-05')
    assert.equal(parts.year, 2026)
    assert.equal(parts.month, 1)
    assert.equal(parts.day, 5)
    assert.equal(parts.hour, 0)
    assert.equal(parts.weekday, 1, 'Monday')
  })

  test('a non-finite instant reads as the epoch instead of throwing', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(beijingParts(bad).date, '1970-01-01')
    }
  })
})

describe('the peak windows', () => {
  test('are the published morning and afternoon ranges, half-open', () => {
    assert.deepEqual(PEAK_WINDOWS, [[9, 12], [14, 18]])
    // Monday 2026-01-05, a plain working day.
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 8, 59)), false, 'before the morning window')
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 9, 0)), true, 'the morning window opens inclusive')
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 11, 59)), true)
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 12, 0)), false, 'the morning window closes exclusive')
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 13, 59)), false, 'the lunch gap is off-peak')
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 14, 0)), true, 'the afternoon window opens inclusive')
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 17, 59)), true)
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 18, 0)), false, 'the afternoon window closes exclusive')
    assert.equal(isPeakBeijing(beijing(2026, 1, 5, 23, 0)), false, 'the night is off-peak')
  })

  test('weekends are off-peak all day', () => {
    // 2026-01-10 is a Saturday, 2026-01-11 a Sunday.
    assert.equal(isPeakBeijing(beijing(2026, 1, 10, 10)), false)
    assert.equal(isPeakBeijing(beijing(2026, 1, 11, 15)), false)
  })

  test('a Chinese public holiday is off-peak all day, exactly like a weekend', () => {
    // 2026-10-01 is a Thursday inside the National Day run.
    const part = beijingParts(beijing(2026, 10, 1, 10))
    assert.equal(part.weekday, 4, 'a weekday, so only the holiday table can make it off-peak')
    assert.equal(isPeakBeijing(beijing(2026, 10, 1, 10)), false)
    // The same hour exactly one week later is a plain Thursday and bills peak.
    assert.equal(isPeakBeijing(beijing(2026, 10, 8, 10)), true)
  })

  test('the caller’s own holiday table replaces the built-in one', () => {
    const plain = beijing(2026, 10, 1, 10)
    assert.equal(isPeakBeijing(plain, []), true, 'an empty table means no holidays at all')
    assert.equal(isPeakBeijing(plain, ['2026-10-01']), false)
    assert.equal(isPeakBeijing(plain, ['2026-10-02']), true, 'only the listed date is off-peak')
  })

  test('the built-in table covers the published 2026 arrangement', () => {
    assert.equal(DEFAULT_HOLIDAYS.length, 31)
    assert.ok(DEFAULT_HOLIDAYS.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)))
    assert.deepEqual([...DEFAULT_HOLIDAYS].sort(), [...DEFAULT_HOLIDAYS], 'kept in calendar order')
    for (const day of ['2026-01-01', '2026-02-17', '2026-04-05', '2026-05-03', '2026-06-20', '2026-09-26', '2026-10-07']) {
      assert.ok(DEFAULT_HOLIDAYS.includes(day), day)
    }
  })
})

describe('periodAt (the current period and its next flip)', () => {
  test('reports the window in force and the instant it next flips', () => {
    // Monday 2026-01-05 10:00 Beijing, inside the morning window → 12:00 ends it.
    const morning = periodAt(beijing(2026, 1, 5, 10))
    assert.equal(morning.peak, true)
    assert.equal(morning.next?.peak, false)
    assert.equal(morning.next?.at, beijing(2026, 1, 5, 12), 'the lunch gap opens at 12:00')
    // 13:00 Beijing is in the lunch gap → the afternoon window opens at 14:00.
    const lunch = periodAt(beijing(2026, 1, 5, 13))
    assert.equal(lunch.peak, false)
    assert.equal(lunch.next?.at, beijing(2026, 1, 5, 14))
    // 19:00 Beijing on a Monday: the next boundary is Tuesday 09:00.
    const night = periodAt(beijing(2026, 1, 5, 19))
    assert.equal(night.peak, false)
    assert.equal(night.next?.at, beijing(2026, 1, 6, 9))
  })

  test('the boundary instant itself belongs to the NEW period', () => {
    const at = beijing(2026, 1, 5, 12)
    assert.equal(periodAt(at).peak, false, '12:00 is already off-peak')
    assert.equal(periodAt(at - 1).peak, true, 'one millisecond earlier is still peak')
    assert.equal(periodAt(beijing(2026, 1, 5, 14)).peak, true)
    assert.equal(periodAt(beijing(2026, 1, 5, 18)).peak, false)
  })

  test('a holiday run reports the flip at its own end, not the weekend’s', () => {
    // 2026-10-01..07 is the National Day run; 2026-10-06 is a Tuesday inside it.
    const inside = periodAt(beijing(2026, 10, 6, 10))
    assert.equal(inside.peak, false, 'a weekday inside the holiday is off-peak')
    // The run ends 2026-10-07 (Wednesday), so the next peak opens Thursday 2026-10-08 09:00.
    assert.equal(inside.next?.at, beijing(2026, 10, 8, 9))
  })

  test('a caller-supplied holiday table replaces the built-in one', () => {
    const plain = beijing(2026, 10, 6, 10)
    assert.equal(periodAt(plain, []).peak, true, 'with no holidays that Thursday is peak')
  })

  test('an instant whose next flip is beyond the scan horizon reports none', () => {
    // A holiday table covering every weekday for a month: no flip can be found in eight days.
    const holidays = Array.from({ length: 60 }, (_, i) => {
      const day = beijingParts(beijing(2026, 1, 1, 12) + i * 86_400_000).date
      return day
    })
    const period = periodAt(beijing(2026, 1, 5, 10), holidays)
    assert.equal(period.peak, false)
    assert.equal(period.next, null, 'nothing flips within the scan window')
  })

  test('a non-finite instant reads as the epoch instead of throwing', () => {
    const period = periodAt(Number.NaN)
    assert.equal(typeof period.peak, 'boolean')
  })
})

describe('holidaysFrom (the config narrowing)', () => {
  test('keeps the well-formed dates and drops everything else', () => {
    assert.deepEqual(holidaysFrom(['2026-01-01', 'bad', 7, null, '2026-10-01']), ['2026-01-01', '2026-10-01'])
  })

  test('a value with nothing usable returns undefined, so the built-in table applies', () => {
    // An empty table is NOT the same as an absent one: it would bill every holiday at the peak rate.
    for (const bad of [undefined, null, '2026-01-01', 7, {}, [], ['bad'], [7, null], ['']]) {
      assert.equal(holidaysFrom(bad), undefined, JSON.stringify(bad))
    }
  })
})

describe('peakWindowsText (the windows as the UI spells them)', () => {
  test('renders every window from the table, zero-padded', () => {
    // Derived from PEAK_WINDOWS, so changing the table changes the label — the two
    // can never disagree about when peak actually is.
    assert.equal(peakWindowsText(', '), '09:00–12:00, 14:00–18:00')
    assert.equal(peakWindowsText('、'), '09:00–12:00、14:00–18:00')
    assert.equal(PEAK_WINDOWS.length, 2)
  })

  test('the separator is the caller’s, so no locale punctuation is baked in', () => {
    assert.equal(peakWindowsText(' / '), '09:00–12:00 / 14:00–18:00')
  })
})

describe('msUntilFlip (the countdown source)', () => {
  test('counts down to the end of the current peak window', () => {
    // Monday 10:00 Beijing is peak; the window ends at 12:00, so two hours remain.
    assert.equal(msUntilFlip(beijing(2026, 10, 12, 10)), 2 * 3600 * 1000)
  })

  test('counts down to the start of the next peak window', () => {
    // Monday 12:30 sits in the 12:00-14:00 gap, so the next boundary is 14:00.
    assert.equal(msUntilFlip(beijing(2026, 10, 12, 12, 30)), 90 * 60 * 1000)
  })

  test('never reports a negative remainder', () => {
    // Exactly on a boundary the remainder is zero, not a negative leftover: 12:00 is
    // already off-peak, so the next boundary is 14:00, two hours away.
    const onBoundary = beijing(2026, 10, 12, 12)
    assert.equal(isPeakBeijing(onBoundary), false, 'the boundary itself belongs to the new period')
    assert.equal(msUntilFlip(onBoundary), 2 * 3600 * 1000)
    assert.ok(msUntilFlip(Number.NaN) === null || msUntilFlip(Number.NaN)! >= 0)
  })
})

describe('allDayOffReason (why a day has no peak window)', () => {
  test('names the weekend', () => {
    // 2026-10-11 is a Sunday.
    assert.equal(allDayOffReason(beijing(2026, 10, 11, 10)), 'weekend')
  })

  test('names a listed holiday', () => {
    assert.equal(allDayOffReason(beijing(2026, 10, 2, 10)), 'holiday')
  })

  test('is null on a plain weekday, so the countdown is shown instead', () => {
    assert.equal(allDayOffReason(beijing(2026, 10, 12, 10)), null)
    // ...and it agrees with isPeakBeijing about which days are off.
    for (const [y, m, d] of [[2026, 10, 11], [2026, 10, 12], [2026, 10, 2]] as const) {
      const t = beijing(y, m, d, 10)
      assert.equal(allDayOffReason(t) !== null, !isPeakBeijing(t), `${y}-${m}-${d}`)
    }
  })
})

describe('countdownParts (arithmetic only, no locale words)', () => {
  test('splits hours, minutes and seconds', () => {
    assert.deepEqual(countdownParts(2 * 3600 * 1000 + 30 * 60 * 1000 + 5000), { hours: 2, minutes: 30, seconds: 5 })
    assert.deepEqual(countdownParts(90 * 1000), { hours: 0, minutes: 1, seconds: 30 })
    assert.deepEqual(countdownParts(7000), { hours: 0, minutes: 0, seconds: 7 })
  })

  test('floors rather than rounding, so the reading never overstates the wait', () => {
    assert.deepEqual(countdownParts(1999), { hours: 0, minutes: 0, seconds: 1 })
  })

  test('clamps negatives to zero and passes null through', () => {
    assert.deepEqual(countdownParts(-5000), { hours: 0, minutes: 0, seconds: 0 })
    assert.equal(countdownParts(null), null)
    assert.equal(countdownParts(Number.NaN), null)
    assert.equal(countdownParts(Number.POSITIVE_INFINITY), null)
  })
})
