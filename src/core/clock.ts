/**
 * Beijing wall-clock: the billing calendar the official CNY price list is written against.
 *
 * Why a bespoke decomposition instead of `Intl.DateTimeFormat`: the host fold resolves the
 * period of every settlement, so this runs once per assistant message over a whole session
 * log. Beijing is a fixed UTC+8 offset with no DST, so shifting the epoch and reading the UTC
 * accessors is both exact and allocation-light.
 *
 * Everything here is pure: no `Date.now()` inside a decision, time is always a parameter. That
 * is what lets the fold be a pure function of the log.
 */

/** One official CNY rate row, in yuan per million tokens. Cache writes are billed as misses. */
export interface OfficialRate {
  hit: number
  miss: number
  out: number
}

/** A model the official price list covers. */
export interface OfficialModel {
  /** Canonical id used in the ledger and in the UI. */
  id: string
  /** Human label, e.g. `DeepSeek-V4.1-Flash`. */
  label: string
  /** Every wire id the API has used for this model. */
  aliases: readonly string[]
  offPeak: OfficialRate
  peak: OfficialRate
}

/** The official price list. Off-peak is exactly half of peak in every column. */
export const OFFICIAL_TABLE: readonly OfficialModel[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek-V4.1-Flash',
    aliases: [
      'deepseek-flash',
      'deepseek-v4.1-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4.1-flash-vision-exp',
    ],
    offPeak: { hit: 0.02, miss: 1, out: 4 },
    peak: { hit: 0.04, miss: 2, out: 8 },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek-V4-Pro',
    aliases: ['deepseek-v4-pro', 'deepseek-v4.1-pro', 'deepseek-pro'],
    offPeak: { hit: 0.15, miss: 4.5, out: 13.5 },
    peak: { hit: 0.3, miss: 9, out: 27 },
  },
]

/** Beijing peak windows as half-open `[from, to)` hours. */
export const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [14, 18],
]

/**
 * Chinese public holidays as Beijing dates. A holiday bills off-peak all day, like a weekend.
 * Dates whose make-up workday arrangement is unclear are deliberately absent: misreading a
 * holiday would misprice every request that day, while missing one only costs a peak rate.
 */
export const HOLIDAYS_2026: readonly string[] = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]

/** The built-in holiday calendar, used whenever a configured table yields nothing usable. */
export const DEFAULT_HOLIDAYS: readonly string[] = HOLIDAYS_2026

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
/** How far ahead the countdown looks for the next flip. Eight days covers a long holiday plus
 * the weekend on either side, so the scan cannot fall off the end. */
const FLIP_SCAN_MS = 8 * 24 * HOUR_MS
/** Countdown resolution: one minute. A finer step would re-render for a digit that never shows. */
const FLIP_STEP_MS = 60 * 1000

/** Beijing clock fields of one instant. */
export interface BeijingClock {
  year: number
  month: number
  day: number
  hour: number
  /** 0 = Sunday. */
  weekday: number
  /** `YYYY-MM-DD` in Beijing. */
  date: string
}

/** Split an epoch millisecond into Beijing clock fields. Non-finite input reads as the epoch. */
export function beijingClock(time: number): BeijingClock {
  const shifted = new Date((Number.isFinite(time) ? time : 0) + BEIJING_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  return {
    year,
    month,
    day,
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

/** Why a whole day bills off-peak, or `null` for an ordinary weekday. */
export type OffDayReason = 'weekend' | 'holiday' | null

/** Whether an instant sits inside a Beijing peak window. Weekends and holidays are off-peak all
 * day; the 12:00–14:00 midday gap is off-peak too. */
export function isPeakAt(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): boolean {
  const clock = beijingClock(time)
  if (clock.weekday === 0 || clock.weekday === 6) return false
  if (holidays.includes(clock.date)) return false
  return PEAK_WINDOWS.some(([from, to]) => clock.hour >= from && clock.hour < to)
}

/** The all-day off-peak reason for an instant's date, if any. Shares the weekend/holiday rules
 * with {@link isPeakAt} so the UI can say *why* there is no peak to count down to. */
export function offDayReason(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): OffDayReason {
  const clock = beijingClock(time)
  if (clock.weekday === 0 || clock.weekday === 6) return 'weekend'
  if (holidays.includes(clock.date)) return 'holiday'
  return null
}

/** The billing period of one instant. */
export type Period = 'peak' | 'off'

/** Which period an instant bills in. */
export function periodAt(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): Period {
  return isPeakAt(time, holidays) ? 'peak' : 'off'
}

/** The next instant the period flips, or `null` when the scan window is exhausted (a
 * pathological holiday table spanning more than a week). */
export function nextFlipAt(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): number | null {
  if (!Number.isFinite(time)) return null
  const now = isPeakAt(time, holidays)
  const first = Math.ceil(time / FLIP_STEP_MS) * FLIP_STEP_MS
  for (let at = first; at <= time + FLIP_SCAN_MS; at += FLIP_STEP_MS) {
    if (at <= time) continue
    if (isPeakAt(at, holidays) !== now) return at
  }
  return null
}

/** Milliseconds until the next period flip; `null` when there is none in the scan window. */
export function msUntilFlip(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): number | null {
  const next = nextFlipAt(time, holidays)
  return next === null ? null : next - time
}

/** A countdown split into display units. `days` is only non-zero for a holiday-shortened week. */
export interface Countdown {
  days: number
  hours: number
  minutes: number
  seconds: number
}

/** Split a remaining millisecond count into countdown units, flooring to whole seconds. */
export function countdownOf(remainingMs: number): Countdown {
  const total = Math.max(0, Math.floor((Number.isFinite(remainingMs) ? remainingMs : 0) / 1000))
  return {
    days: Math.floor(total / 86_400),
    hours: Math.floor((total % 86_400) / 3_600),
    minutes: Math.floor((total % 3_600) / 60),
    seconds: total % 60,
  }
}

/** The peak windows as display text, e.g. `09:00–12:00、14:00–18:00`. Derived from
 * {@link PEAK_WINDOWS}, so editing the table edits the copy. */
export function peakWindowsText(separator = '、'): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return PEAK_WINDOWS.map(([from, to]) => `${pad(from)}:00–${pad(to)}:00`).join(separator)
}

/**
 * Normalise a configured holiday table.
 *
 * Returns `undefined` — meaning "fall back to the built-in calendar" — for anything that yields
 * no usable date. That distinction matters: reading a broken table as "no holidays" would bill
 * every holiday at the peak rate and silently double those days.
 */
export function normaliseHolidays(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const kept: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry)) kept.push(entry)
  }
  return kept.length === 0 ? undefined : kept
}

/** Find the official price row covering a wire model id (exact or via alias). */
export function findOfficialModel(model: string | undefined): OfficialModel | null {
  if (typeof model !== 'string' || model === '') return null
  const needle = model.trim().toLowerCase()
  for (const row of OFFICIAL_TABLE) {
    if (row.id === needle) return row
    if (row.aliases.some(alias => alias === needle)) return row
  }
  return null
}

/** The official rate for a model in a period, converted to USD, or `null` when unlisted. */
export function officialRateOf(model: string | undefined, peak: boolean): OfficialRate | null {
  const row = findOfficialModel(model)
  if (row === null) return null
  return peak ? row.peak : row.offPeak
}

/** Whether the model is priced by the official table (so its period split is meaningful). */
export function isOfficialModel(model: string | undefined): boolean {
  return findOfficialModel(model) !== null
}
