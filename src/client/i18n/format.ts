/**
 * Shared formatting helpers.
 *
 * These exist because the same number appears on several surfaces (dock, cards, tables, tooltips),
 * and a second spelling would let two views of the same value disagree. Everything here is pure and
 * locale-independent: language-specific wording lives in the dictionaries.
 *
 * One rule runs through all of it: a **missing** number renders as a dash, never as `0`. A zero is a
 * measurement; a dash says "not known", and the two must not look alike on a statistics card.
 */

import { countdownOf } from '../../core/clock'
import type { Translate } from '../i18n/dict'

/** Compact count: `1.2k` / `3.4M` / `1.1B`, integers below 1000. A missing or non-finite value is the
 * long dash. */
export function formatCount(value: number | null | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  const sign = value < 0 ? '-' : ''
  const magnitude = Math.abs(value)
  if (magnitude >= 1e9) return `${sign}${(magnitude / 1e9).toFixed(1)}B`
  if (magnitude >= 1e6) return `${sign}${(magnitude / 1e6).toFixed(1)}M`
  if (magnitude >= 1_000) return `${sign}${(magnitude / 1_000).toFixed(1)}k`
  return `${sign}${Math.round(magnitude)}`
}

/** Decimal bytes, never KiB: the numbers come from the harness's own byte counts and the surrounding
 * copy uses decimal units too. Negative counts read as missing. */
export function formatBytes(value: number | null | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value) || value < 0) return '—'
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} kB`
  return `${Math.round(value)} B`
}

/**
 * The cache-hit share of the billed prompt, **truncated** to two decimals — the same figure the
 * harness's own statistics line and the token badge print. Truncation is deliberate: 0.999 of a
 * percentage point must not print as `1.00` while the harness's own line says `0.99`.
 */
export function cacheHitPercent(reads: number, billed: number): string | null {
  if (!(billed > 0)) return null
  const scaled = Math.trunc((reads / billed) * 100 * 100 + 1e-9)
  return `${Math.floor(scaled / 100)}.${String(scaled % 100).padStart(2, '0')}`
}

/** One shared formatter: constructing an `Intl` formatter per call costs about 50x the formatting
 * itself. */
const TIME_FORMAT = new Intl.DateTimeFormat('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** Browser-local `HH:MM:SS`, deliberately locale-independent: only equal-width times let the timing
 * strip's label column align. An invalid date is a dash (`format` would throw). */
export function formatClock(time: number): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return '—'
  return TIME_FORMAT.format(date)
}

/** A share of a whole with one decimal. Debris below 0.1% reads `<0.1%`, and the share caps at 100%. A
 * non-positive whole is a dash, not `0%` — the latter looks like a real measurement of an empty
 * whole. */
export function formatShare(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '—'
  if (part <= 0) return '0.0%'
  const percent = Math.min(1, part / whole) * 100
  if (percent < 0.1) return '<0.1%'
  return `${percent.toFixed(1)}%`
}

/** A whole session's duration in compact locale-independent units; a non-positive input is a dash. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const totalSeconds = Math.floor(ms / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (ms < 3_600_000) return `${minutes}m${seconds}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}

/**
 * The peak/off-peak countdown phrase, with its unit words taken from the dictionary.
 *
 * Not `formatDuration`: that one is the deliberately locale-independent compact form read off the
 * timing curve (`2h0m`), which reads badly inside a Chinese sentence. The unit words live in the
 * dictionary; this only assembles them.
 */
export function formatCountdown(t: Translate, remainingMs: number | null): string | null {
  if (remainingMs === null) return null
  const parts = countdownOf(remainingMs)
  if (parts.days > 0) return t('dock.dur.hm', { h: parts.days * 24 + parts.hours, m: parts.minutes })
  if (parts.hours > 0) return t('dock.dur.hm', { h: parts.hours, m: parts.minutes })
  if (parts.minutes > 0) return t('dock.dur.ms', { m: parts.minutes, s: parts.seconds })
  return t('dock.dur.s', { s: parts.seconds })
}

/**
 * The narrow row's compact countdown (`6h38m` / `38m` / `45s`), language-independent.
 *
 * When the full sentence "off-peak in 6 hours 38 minutes" does not fit, the row switches to a clock
 * glyph plus this form: the number still ticks every second, but occupies a few characters. Same unit
 * ladder as {@link formatDuration}, so the two readouts cannot spell durations differently.
 */
export function formatCountdownCompact(remainingMs: number | null): string | null {
  if (remainingMs === null) return null
  const parts = countdownOf(remainingMs)
  if (parts.days > 0) return `${parts.days * 24 + parts.hours}h${parts.minutes}m`
  if (parts.hours > 0) return `${parts.hours}h${parts.minutes}m`
  if (parts.minutes > 0) return `${parts.minutes}m`
  return `${parts.seconds}s`
}

/** A percentage with one decimal. */
export function formatPercent(part: number, whole: number): string {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return '0%'
  return `${((part / whole) * 100).toFixed(1)}%`
}

/** Clamp into `[0, 1]`. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
