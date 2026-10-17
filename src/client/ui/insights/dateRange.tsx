/**
 * The date-range picker: one pill carrying both ends of the live window, so the picker and the preset
 * group above can never contradict each other.
 *
 * Two clicks make a range in either order — the pair is sorted, so every downstream reader (the scope
 * window, the ledger-day predicate, the labels) always sees `from <= to` and none of them has to
 * re-check.
 *
 * The panel portals to `<body>` and is positioned `fixed` against the trigger's rect: the page root is
 * an `inline-size` container, and its scroll box would clip a popup left in the tree. Any scroll,
 * resize, outside press or Escape closes it instead of leaving it hanging beside an anchor that moved.
 */

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { DayRange } from '../../data/aggregate'
import { monthGrid, shiftDayKey, shiftMonthKey } from '../../../core/day'
import type { Translate } from '../../i18n/dict'
import { GlyphChevronDown } from '../glyphs'

/** Trigger-to-panel gap and the viewport margin the panel is clamped inside, in px. */
const GAP = 6
const MARGIN = 8

/** The id the keyboard cursor's cell carries for `aria-activedescendant`. */
const CELL_ID = 'cb-ov-dp-day'

const MONTH_KEY = /^\d{4}-\d{2}$/

/** Normalise a pair so `from <= to`. Both the picker's state and every reader can then assume order. */
export function orderedDayRange(left: string, right: string): DayRange {
  return left <= right ? { from: left, to: right } : { from: right, to: left }
}

/** Day shift for a recognised arrow key, or `null` when the key is not the grid's business. */
function dayStepOf(key: string): number | null {
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  if (key === 'ArrowUp') return -7
  if (key === 'ArrowDown') return 7
  return null
}

/** A localised `YYYY-MM` title. A key that fails the month pattern is returned verbatim rather than
 * handed to `Intl`, whose formatter throws `RangeError` on an invalid date. */
function monthLabelOf(month: string, locale: string): string {
  if (!MONTH_KEY.test(month)) return month
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(date)
  } catch {
    // A host with no usable Intl data still gets a readable title.
    return month
  }
}

export interface DateRangeProps {
  /** The scope's day span: the picked range, else the preset's window read as days (its open end is
   * today); `null` when the scope has no lower bound. */
  value: DayRange | null
  /** Whether the value is a user-picked range (as opposed to a preset's window). */
  picked: boolean
  /** A committed range, or `null` when the range is cleared back to the preset. */
  onChange: (range: DayRange | null) => void
  /** Local today as `YYYY-MM-DD`, injected so tests pin the calendar. */
  today: string
  /** BCP-47 tag for the month title. */
  locale: string
  t: Translate
}

/** The two-click range picker. */
export function DateRange(props: DateRangeProps): ReactElement {
  const { t } = props
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState('')
  const [cursor, setCursor] = useState('')
  const [anchor, setAnchor] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const close = (): void => { setOpen(false) }

  useEffect(() => {
    if (!open) return undefined
    // Capture-phase Escape: the page owns no other overlay, but a host surface may, and this panel
    // must close before the host's own handler runs.
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    // An outside press closes; a scroll or resize retracts, rather than leaving the panel beside an
    // anchor that has moved.
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true) return
      close()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // Re-place the panel after every commit. The equality check makes "re-measured to the same spot" a
  // no-op, so measuring on every render cannot loop. `Object.is` rather than `===`: an unmeasurable
  // anchor yields NaN, and `NaN === NaN` is false — that would spin a new object every pass and
  // restart the tree. The panel is portaled, so its size is already readable while still hidden.
  useLayoutEffect(() => {
    const anchorEl = rootRef.current
    const panelEl = panelRef.current
    if (!open || anchorEl === null || panelEl === null) return
    const rect = anchorEl.getBoundingClientRect()
    const width = panelEl.offsetWidth
    const height = panelEl.offsetHeight
    const left = Math.max(MARGIN, Math.min(rect.right - width, window.innerWidth - width - MARGIN))
    const below = rect.bottom + GAP
    const top = below + height > window.innerHeight - MARGIN
      ? Math.max(MARGIN, rect.top - height - GAP)
      : below
    setSpot(current => current !== null && Object.is(current.left, left) && Object.is(current.top, top)
      ? current
      : { left, top })
  })

  // While closed the grid is never built; before the first anchor `draft` is undefined so each end
  // falls back to its own placeholder.
  const draft = anchor === null ? props.value : orderedDayRange(anchor, hover ?? anchor)
  const grid = open ? monthGrid(month) : null

  const show = (): void => {
    // Reopening starts at today's month and drops any half-made selection, so a previous visit's
    // partial range cannot silently continue.
    const home = props.today.slice(0, 7)
    setMonth(home)
    setCursor(`${home}-01`)
    setAnchor(null)
    setHover(null)
    setSpot(null)
    setOpen(true)
  }

  const pick = (key: string): void => {
    // First click only sets the anchor; the panel stays open so `hover` can preview the other end.
    if (anchor === null) {
      setAnchor(key)
      setHover(null)
      return
    }
    const next = orderedDayRange(anchor, key)
    setAnchor(null)
    setHover(null)
    setOpen(false)
    props.onChange(next)
  }

  const stepMonth = (delta: number): void => {
    const next = shiftMonthKey(month, delta)
    // `null` means the shift left the representable range; the cursor cannot follow a month that did
    // not move, so both stay in step by construction.
    if (next === null) return
    setMonth(next)
    setCursor(`${next}-01`)
  }

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(cursor)
      return
    }
    const step = dayStepOf(event.key)
    if (step === null) return
    event.preventDefault()
    const next = shiftDayKey(cursor, step)
    // The cursor neither leaves the displayed month nor crosses into the future: the grid does not
    // render those days, and the host clamps future days anyway.
    if (next !== null && next <= props.today && next.slice(0, 7) === month) setCursor(next)
  }

  const shown = spot !== null && open ? spot : null
  // After the first click with no hover yet only the start is chosen, so the end keeps its placeholder
  // instead of echoing the start.
  const from = draft?.from
  const to = anchor !== null && hover === null ? undefined : draft?.to
  return (
    <div className="cb-ov-dp" ref={rootRef}>
      <button
        type="button"
        className={'cb-ov-dp-trigger' + (props.picked ? ' cb-ov-dp-trigger-on' : '')}
        aria-haspopup="dialog"
        aria-expanded={grid !== null}
        aria-label={t('ov.date.open')}
        onClick={() => { if (open) close(); else show() }}
      >
        <span className={'cb-ov-dp-half' + (from === undefined ? ' cb-ov-dp-half-empty' : '')}>
          {from ?? t('ov.date.from')}
        </span>
        <span className="cb-ov-dp-sep">→</span>
        <span className={'cb-ov-dp-half' + (to === undefined ? ' cb-ov-dp-half-empty' : '')}>
          {to ?? t('ov.date.to')}
        </span>
        <GlyphChevronDown size={12} />
      </button>
      {grid === null ? null : createPortal(
        <div
          ref={panelRef}
          className="cb-ov-tip cb-ov-dp-panel"
          role="dialog"
          aria-label={t('ov.date.label')}
          style={shown === null
            ? { left: 0, top: 0, visibility: 'hidden' }
            : { left: shown.left, top: shown.top }}
        >
          <div className="cb-ov-dp-nav">
            <button type="button" className="cb-ov-dp-navbtn" aria-label={t('ov.date.prev')} onClick={() => { stepMonth(-1) }}>‹</button>
            <span className="cb-ov-dp-month">{monthLabelOf(month, props.locale)}</span>
            <button
              type="button"
              className="cb-ov-dp-navbtn"
              aria-label={t('ov.date.next')}
              disabled={month >= props.today.slice(0, 7)}
              onClick={() => { stepMonth(1) }}
            >›</button>
          </div>
          <div className="cb-ov-dp-wds" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5, 6].map(day => (
              <span key={day} className="cb-ov-dp-wd">{t(`ov.date.wd.${String(day)}`)}</span>
            ))}
          </div>
          <div
            className="cb-ov-dp-grid"
            role="grid"
            tabIndex={0}
            aria-label={t('ov.date.pick')}
            aria-activedescendant={CELL_ID}
            onKeyDown={onGridKeyDown}
          >
            {grid.map((week, weekIndex) => (
              <div className="cb-ov-dp-week" role="row" key={weekIndex}>
                {week.map((key, dayIndex) => {
                  if (key === null) return <span className="cb-ov-dp-cell cb-ov-dp-blank" key={dayIndex} />
                  const future = key > props.today
                  const edge = draft !== null && (key === draft.from || key === draft.to)
                  const inRange = draft !== null && key >= draft.from && key <= draft.to
                  const className = 'cb-ov-dp-cell'
                    + (inRange ? ' cb-ov-dp-in' : '')
                    + (edge ? ' cb-ov-dp-edge' : '')
                    + (key === cursor ? ' cb-ov-dp-cursor' : '')
                    + (key === props.today ? ' cb-ov-dp-today' : '')
                    + (future ? ' cb-ov-dp-future' : '')
                  const day = String(Number(key.slice(8, 10)))
                  if (future) {
                    // The keyboard cursor never lands here, so this cell carries no activedescendant id.
                    return (
                      <span className={className} role="gridcell" aria-disabled="true" aria-label={key} key={dayIndex}>
                        {day}
                      </span>
                    )
                  }
                  return (
                    <span
                      className={className}
                      role="gridcell"
                      id={key === cursor ? CELL_ID : undefined}
                      aria-label={key}
                      aria-selected={edge}
                      key={dayIndex}
                      onMouseEnter={() => { if (anchor !== null) setHover(key) }}
                      onClick={() => { pick(key) }}
                    >
                      {day}
                    </span>
                  )
                })}
              </div>
            ))}
          </div>
          <div className="cb-ov-dp-foot">
            <span className="cb-ov-dp-hint">{anchor === null ? t('ov.date.hint') : t('ov.date.hintEnd')}</span>
            {props.picked && (
              <button type="button" className="cb-ov-dp-clear" onClick={() => { props.onChange(null) }}>
                {t('ov.date.clear')}
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
