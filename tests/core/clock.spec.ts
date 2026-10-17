/**
 * The Beijing billing calendar: the peak windows, the holiday calendar, the period flip and the fallback
 * rules. These decide what every official settlement in the ledger is charged, so the boundaries (09:00
 * included, 12:00 excluded) and the all-day-off rules are asserted explicitly.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HOLIDAYS, beijingClock, countdownOf, findOfficialModel, isPeakAt, msUntilFlip, nextFlipAt,
  normaliseHolidays, offDayReason, officialRateOf, peakWindowsText, periodAt,
} from '../../src/core/clock'

/** A Beijing wall-clock instant as an epoch millisecond (Beijing is a fixed UTC+8). */
function beijing(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute)
}

describe('beijingClock', () => {
  it('splits an instant into Beijing fields', () => {
    const clock = beijingClock(beijing(2026, 10, 16, 9, 30))
    expect(clock).toMatchObject({ year: 2026, month: 10, day: 16, hour: 9, date: '2026-10-16' })
  })

  it('reads a non-finite instant as the epoch instead of throwing', () => {
    expect(beijingClock(Number.NaN).date).toBe('1970-01-01')
  })
})

describe('isPeakAt', () => {
  it('includes the window start and excludes its end', () => {
    // 2026-10-16 is a Friday.
    expect(isPeakAt(beijing(2026, 10, 16, 9))).toBe(true)
    expect(isPeakAt(beijing(2026, 10, 16, 11, 59))).toBe(true)
    expect(isPeakAt(beijing(2026, 10, 16, 12))).toBe(false)
    expect(isPeakAt(beijing(2026, 10, 16, 14))).toBe(true)
    expect(isPeakAt(beijing(2026, 10, 16, 18))).toBe(false)
  })

  it('bills weekends off-peak all day', () => {
    expect(isPeakAt(beijing(2026, 10, 17, 10))).toBe(false)
    expect(offDayReason(beijing(2026, 10, 17, 10))).toBe('weekend')
  })

  it('bills a public holiday off-peak all day', () => {
    const nationalDay = beijing(2026, 10, 1, 10)
    expect(isPeakAt(nationalDay)).toBe(false)
    expect(offDayReason(nationalDay)).toBe('holiday')
    // A weekday that is not a holiday is not excused.
    expect(offDayReason(beijing(2026, 10, 16, 10))).toBeNull()
  })

  it('honours a configured holiday table', () => {
    expect(isPeakAt(beijing(2026, 10, 16, 10), ['2026-10-16'])).toBe(false)
    expect(isPeakAt(beijing(2026, 10, 16, 10), [])).toBe(true)
  })
})

describe('periodAt / nextFlipAt / msUntilFlip', () => {
  it('reports the period of an instant', () => {
    expect(periodAt(beijing(2026, 10, 16, 10))).toBe('peak')
    expect(periodAt(beijing(2026, 10, 16, 13))).toBe('off')
  })

  it('finds the next flip inside the same day', () => {
    const next = nextFlipAt(beijing(2026, 10, 16, 10, 30))
    expect(next).toBe(beijing(2026, 10, 16, 12))
    expect(msUntilFlip(beijing(2026, 10, 16, 10, 30))).toBe(90 * 60 * 1000)
  })

  it('skips the weekend to Monday morning', () => {
    const next = nextFlipAt(beijing(2026, 10, 17, 10))
    expect(next).toBe(beijing(2026, 10, 19, 9))
  })

  it('splits a remaining count into countdown units', () => {
    expect(countdownOf(6 * 3_600_000 + 38 * 60_000)).toEqual({ days: 0, hours: 6, minutes: 38, seconds: 0 })
  })

  it('renders the peak windows from the table', () => {
    expect(peakWindowsText('、')).toBe('09:00–12:00、14:00–18:00')
    expect(peakWindowsText(', ')).toBe('09:00–12:00, 14:00–18:00')
  })
})

describe('holidays', () => {
  it('keeps well-formed dates and drops the rest', () => {
    expect(normaliseHolidays(['2026-01-01', 'nope', '01-02', '2026-1-1'])).toEqual(['2026-01-01'])
  })

  it('falls back (undefined) when nothing usable survives', () => {
    // The distinction matters: `[]` would bill every holiday at peak and double those days.
    expect(normaliseHolidays([])).toBeUndefined()
    expect(normaliseHolidays(['nope'])).toBeUndefined()
    expect(normaliseHolidays('2026-01-01')).toBeUndefined()
  })

  it('ships a 2026 calendar', () => {
    expect(DEFAULT_HOLIDAYS.length).toBeGreaterThan(0)
    expect(DEFAULT_HOLIDAYS).toContain('2026-10-01')
  })
})

describe('the official table', () => {
  it('matches by id and by alias, case-insensitively', () => {
    expect(findOfficialModel('deepseek-v4-pro')?.id).toBe('deepseek-v4-pro')
    expect(findOfficialModel('DeepSeek-V4.1-Flash')?.id).toBe('deepseek-flash')
    expect(findOfficialModel('deepseek-flash')?.id).toBe('deepseek-flash')
  })

  it('declines to guess an unlisted model', () => {
    expect(findOfficialModel('gpt-4o')).toBeNull()
    expect(findOfficialModel(undefined)).toBeNull()
  })

  it('halves the peak column for off-peak', () => {
    const peak = officialRateOf('deepseek-flash', true)
    const off = officialRateOf('deepseek-flash', false)
    expect(peak).not.toBeNull()
    expect(off).not.toBeNull()
    expect(peak?.miss).toBe(2)
    expect(off?.miss).toBe(1)
  })
})
