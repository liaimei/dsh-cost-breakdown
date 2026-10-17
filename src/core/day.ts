/**
 * Local-day keys and calendar arithmetic.
 *
 * The activity fold (host) and the heatmap (browser) must bucket on the *same* calendar, so
 * both use the machine's local day. Keys sort lexicographically in time order, which is what
 * makes retention windows and week maths cheap.
 */

import type { ActivityLedger, LedgerDay } from '../wire/model'

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
const MONTH_KEY = /^\d{4}-\d{2}$/

/** The local `YYYY-MM-DD` key of an instant, or `null` for a non-finite / out-of-range time —
 * untrusted log data must not be able to mint garbage keys. */
export function dayKeyOf(time: number): string | null {
  if (!Number.isFinite(time)) return null
  const date = new Date(time)
  const year = date.getFullYear()
  if (!Number.isFinite(year) || year < 1970 || year > 9999) return null
  return `${String(year).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Local midnight of a day key, or `null` for a malformed or rolling-over key (`2026-02-30`). */
function dateOfDayKey(key: string): Date | null {
  if (!DAY_KEY.test(key)) return null
  const year = Number(key.slice(0, 4))
  const month = Number(key.slice(5, 7))
  const day = Number(key.slice(8, 10))
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return date
}

/** Shift a day key by whole local days. Field arithmetic, not epoch addition, so a DST day is
 * still exactly one day. */
export function shiftDayKey(key: string, days: number): string | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setDate(date.getDate() + days)
  return dayKeyOf(date.getTime())
}

/** Local weekday of a day key (0 = Sunday). */
export function weekdayOf(key: string): number | null {
  const date = dateOfDayKey(key)
  return date === null ? null : date.getDay()
}

/** The Sunday starting a day key's week — the column origin of the heatmap. */
export function weekStartOf(key: string): string | null {
  const weekday = weekdayOf(key)
  return weekday === null ? null : shiftDayKey(key, -weekday)
}

/** First millisecond of a day key (inclusive range start). */
export function startOfDay(key: string): number | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** Last millisecond of a day key (inclusive range end). */
export function endOfDay(key: string): number | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

/** Shift a month key by whole months, `null` on malformed input or out-of-range output. */
export function shiftMonthKey(month: string, delta: number): string | null {
  if (!MONTH_KEY.test(month)) return null
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  if (index < 1 || index > 12) return null
  const total = year * 12 + (index - 1) + delta
  const shiftedYear = Math.floor(total / 12)
  if (shiftedYear < 1970 || shiftedYear > 9999) return null
  return `${String(shiftedYear).padStart(4, '0')}-${String(total - shiftedYear * 12 + 1).padStart(2, '0')}`
}

/** A month laid out as Sunday-first weeks of day keys, padded with `null`. */
export function monthGrid(month: string): (string | null)[][] | null {
  const first = `${month}-01`
  const lead = weekdayOf(first)
  if (lead === null) return null
  const weeks: (string | null)[][] = []
  let week: (string | null)[] = []
  for (let i = 0; i < lead; i++) week.push(null)
  for (let day = 0; ; day++) {
    const key = shiftDayKey(first, day)
    if (key === null || key.slice(0, 7) !== month) {
      while (week.length < 7) week.push(null)
      weeks.push(week)
      return weeks
    }
    week.push(key)
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
}

/** An empty day ledger row. */
export function emptyDay(): LedgerDay {
  return { tokens: 0, requests: 0 }
}

/** Sum two day rows (tokens and requests add; ledgers and skill tallies merge). */
export function mergeDay(into: LedgerDay, from: LedgerDay): LedgerDay {
  const merged: LedgerDay = {
    tokens: into.tokens + from.tokens,
    requests: into.requests + from.requests,
  }
  const cost = from.cost
  if (cost !== undefined) {
    const target = into.cost ?? {}
    for (const [provider, models] of Object.entries(cost)) {
      const providerRow = target[provider] ?? {}
      for (const [model, entry] of Object.entries(models)) {
        const row = providerRow[model] ?? {}
        if (entry.peak !== undefined) {
          row.peak = row.peak === undefined ? { ...entry.peak } : {
            uncached: row.peak.uncached + entry.peak.uncached,
            cacheRead: row.peak.cacheRead + entry.peak.cacheRead,
            cacheWrite: row.peak.cacheWrite + entry.peak.cacheWrite,
            output: row.peak.output + entry.peak.output,
          }
        }
        if (entry.off !== undefined) {
          row.off = row.off === undefined ? { ...entry.off } : {
            uncached: row.off.uncached + entry.off.uncached,
            cacheRead: row.off.cacheRead + entry.off.cacheRead,
            cacheWrite: row.off.cacheWrite + entry.off.cacheWrite,
            output: row.off.output + entry.off.output,
          }
        }
        providerRow[model] = row
      }
      target[provider] = providerRow
    }
    merged.cost = target
  }
  if (from.skills !== undefined) {
    const skills = { ...(into.skills ?? {}) }
    for (const [name, tally] of Object.entries(from.skills)) {
      const current = skills[name]
      skills[name] = current === undefined
        ? { n: tally.n, last: tally.last }
        : { n: current.n + tally.n, last: Math.max(current.last, tally.last) }
    }
    merged.skills = skills
  }
  return merged
}

/** Merge two per-session activity ledgers (the Insights page sums every listed session). */
export function mergeActivity(left: ActivityLedger | null, right: ActivityLedger | null): ActivityLedger | null {
  if (left === null && right === null) return null
  const days: Record<string, LedgerDay> = { ...(left?.days ?? {}) }
  for (const [key, day] of Object.entries(right?.days ?? {})) {
    days[key] = days[key] === undefined ? day : mergeDay(days[key], day)
  }
  return { days }
}
