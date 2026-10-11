/**
 * Insights 页面的日期区间选择器：一个药丸同时承载实时窗口的两端，因此选择器与预设
 * 分组永远不会互相矛盾。两次点击以任意顺序构成区间——这一对被排序过，所以下游每个读取方（作用域
 * 窗口、台账日的判定、标签）看到的永远是 `from <= to`。
 *
 * 面板 portal 到 <body> 并按触发器的 rect 固定：页面就是那个 `lc-ov` 查询容器，它的滚动容器
 * 会把留在树内的弹出层裁掉。任何滚动、尺寸变化、外部按下或 Escape 都关闭它，而不是让它悬在一个已经移开的锚点旁。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { MONTH_KEY_RE, monthGridOf, shiftDayKey, shiftMonthKey } from '../../shared/days'
import { orderedDayRange, type DayRange } from '../overview'
import type { ViewKit } from '../viewkit'
import { useEscapeClose } from './escapeClose'
import { IconChevronDown } from '../primitives'

/** 选择器的受控输入：`value` 是排好序的那一对，`picked` 标记用户自选的
 *  区间（与预设窗口相对），`today` 则注入进来以便测试固定日历。 */
export interface DateRangeProps {
  /** 作用域的日跨度：已选区间，否则把预设自己的窗口按天数读（它的开口端是今天）；
   * 作用域无下界时为 null。 */
  value: DayRange | null
  picked: boolean
  onChange: (range: DayRange | null) => void
  today: string
  locale: string
}

/** 触发器到面板的距离，以及面板被夹在其中的视口边距，单位 px。 */
const GAP = 6
const MARGIN = 8

const CELL_ID = 'lc-dp-day'

/** 每个方向键走过的日 key 步长（单位：天）；该键不归网格管时返回 null。 */
function dayStepOf(key: string): number | null {
  if (key === 'ArrowLeft') return -1
  if (key === 'ArrowRight') return 1
  if (key === 'ArrowUp') return -7
  if (key === 'ArrowDown') return 7
  return null
}

/** `YYYY-MM` key 对应的月份标题，已本地化；通不过 `MONTH_KEY_RE` 的 key
 *  原样返回，而不是交给 `Intl`——它的格式化器遇到非法日期
 *  会抛 `RangeError`。 */
export function monthLabelOf(month: string, locale: string): string {
  if (!MONTH_KEY_RE.test(month)) return month
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(date)
}

/**
 * 绑定 `kit`，返回该选择器。两次点击构成区间：第一次设下 `anchor`，
 * 第二次顺着它收尾并通过 `onChange` 上报——所以任何残缺的区间都不会离开
 * 这个组件。
 */
export function makeDateRange(kit: ViewKit): (props: DateRangeProps) => ReactElement {
  const { t } = kit
  return function DateRange(props: DateRangeProps): ReactElement {
    const [open, setOpen] = useState(false)
    const [month, setMonth] = useState('')
    const [cursor, setCursor] = useState('')
    const [anchor, setAnchor] = useState<string | null>(null)
    const [hover, setHover] = useState<string | null>(null)
    const [spot, setSpot] = useState<{ left: number; top: number } | null>(null)
    const rootRef = useRef<HTMLDivElement | null>(null)
    const panelRef = useRef<HTMLDivElement | null>(null)

    const close = (): void => { setOpen(false) }
    useEscapeClose(open, close)

    // 外部按下即关闭；滚动与尺寸变化则把面板收回，而不是把它留在已经移走的锚点旁。
    useEffect(() => {
      if (!open) return undefined
      const onDown = (ev: MouseEvent): void => {
        const target = ev.target
        if (!(target instanceof Node)) return
        if (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true) return
        close()
      }
      window.addEventListener('mousedown', onDown)
      window.addEventListener('scroll', close, true)
      window.addEventListener('resize', close)
      return () => {
        window.removeEventListener('mousedown', onDown)
        window.removeEventListener('scroll', close, true)
        window.removeEventListener('resize', close)
      }
    }, [open])

    // 每次提交后重新安放面板；那个比较让「重新测量落到同一位置」成为空操作，所以
    // 每次渲染都测量也不会成环。用 Object.is 而不是 ===：量不出位置的锚点读出 NaN，而 NaN === NaN 为
    // 假——每次重新测量都会造出一个新对象，把整棵树转起来。
    // 面板是 portal 出去的，所以即使在测量前的隐藏阶段也能量出自己的尺寸。
    useLayoutEffect(() => {
      const anchorEl = rootRef.current
      const panelEl = panelRef.current
      if (!open || anchorEl === null || panelEl === null) return
      const rect = anchorEl.getBoundingClientRect()
      const left = Math.max(MARGIN, Math.min(rect.right - panelEl.offsetWidth, window.innerWidth - panelEl.offsetWidth - MARGIN))
      const below = rect.bottom + GAP
      const top = below + panelEl.offsetHeight > window.innerHeight - MARGIN
        ? Math.max(MARGIN, rect.top - panelEl.offsetHeight - GAP)
        : below
      setSpot(current => current !== null && Object.is(current.left, left) && Object.is(current.top, top) ? current : { left, top })
    })

    // `open` 把网格挡在外面，关闭的选择器不会构建任何月份；`draft` 在第一个
    // 锚点之前保持 undefined，让两端各自落到自己的占位文案。
    const draft = anchor === null ? props.value : orderedDayRange(anchor, hover ?? anchor)
    const grid = open ? monthGridOf(month) : null

    const show = (): void => {
      // 每次打开都重置到今天的月份并丢掉任何做了一半的选择，
      // 这样上一次打开留下的半个区间不会悄悄延续下来。
      const home = props.today.slice(0, 7)
      setMonth(home)
      setCursor(`${home}-01`)
      setAnchor(null)
      setHover(null)
      setOpen(true)
    }

    const pick = (key: string): void => {
      // 第一次点击：只设下锚点，面板保持打开，好让 `hover` 在指针移动时
      // 预览另一端。
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
      // 返回 null 表示这次位移超出了可表示范围；游标不能跟着月份走，
      // 所以两者靠构造保持同步。
      if (next === null) return
      setMonth(next)
      setCursor(`${next}-01`)
    }

    const onKeyDown = (ev: React.KeyboardEvent): void => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault()
        pick(cursor)
        return
      }
      const step = dayStepOf(ev.key)
      if (step === null) return
      ev.preventDefault()
      const next = shiftDayKey(cursor, step)
      // 游标既不离开当前显示的月份，也不跨进未来：否则网格会滚到一个
      // 它并不渲染的日期，而宿主本来也会把未来的日子夹掉。
      if (next !== null && next <= props.today && next.slice(0, 7) === month) setCursor(next)
    }

    const shown = spot !== null && open ? spot : null
    // 第一次点击且还没有悬停时只选定了起点，所以终点保持占位而不是回显起点。
    const from = draft?.from
    const to = anchor !== null && hover === null ? undefined : draft?.to
    // 面板 portal 到 `document.body`：页面就是那个 `lc-ov` 查询容器，
    // 它自己的滚动容器会把留在树内的弹出层裁掉。
    return (
      <div className="lc-dp" ref={rootRef}>
        <button
          type="button"
          className={'lc-dp-trigger' + (props.picked ? ' lc-dp-trigger-on' : '')}
          aria-haspopup="dialog"
          aria-expanded={grid !== null}
          aria-label={t('ov.date.open')}
          onClick={() => { if (open) { close() } else { show() } }}
        >
          <span className={'lc-dp-half' + (from === undefined ? ' lc-dp-half-empty' : '')}>{from ?? t('ov.date.from')}</span>
          <span className="lc-dp-sep">→</span>
          <span className={'lc-dp-half' + (to === undefined ? ' lc-dp-half-empty' : '')}>{to ?? t('ov.date.to')}</span>
          <IconChevronDown size={12} />
        </button>
        {grid === null ? null : createPortal(
          <div
            ref={panelRef}
            className="lc-tip lc-dp-panel"
            role="dialog"
            aria-label={t('ov.date.label')}
            style={shown === null
              ? { left: 0, top: 0, visibility: 'hidden' }
              : { left: shown.left, top: shown.top }}
          >
            <div className="lc-dp-nav">
              <button type="button" className="lc-dp-navbtn" aria-label={t('ov.date.prev')} onClick={() => { stepMonth(-1) }}>‹</button>
              <span className="lc-dp-month">{monthLabelOf(month, props.locale)}</span>
              <button
                type="button"
                className="lc-dp-navbtn"
                aria-label={t('ov.date.next')}
                disabled={month >= props.today.slice(0, 7)}
                onClick={() => { stepMonth(1) }}
              >›</button>
            </div>
            <div className="lc-dp-wds" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5, 6].map(d => <span key={d} className="lc-dp-wd">{t(`ov.date.wd.${String(d)}`)}</span>)}
            </div>
            <div
              className="lc-dp-grid"
              role="grid"
              tabIndex={0}
              aria-label={t('ov.date.pick')}
              aria-activedescendant={CELL_ID}
              onKeyDown={onKeyDown}
            >
              {grid.map((week, w) => (
                <div className="lc-dp-week" role="row" key={w}>
                  {week.map((key, d) => {
                    if (key === null) return <span className="lc-dp-cell lc-dp-blank" key={d} />
                    const future = key > props.today
                    const edge = draft !== null && (key === draft.from || key === draft.to)
                    const inRange = draft !== null && key >= draft.from && key <= draft.to
                    const className = 'lc-dp-cell'
                      + (inRange ? ' lc-dp-in' : '')
                      + (edge ? ' lc-dp-edge' : '')
                      + (key === cursor ? ' lc-dp-cursor' : '')
                      + (key === props.today ? ' lc-dp-today' : '')
                      + (future ? ' lc-dp-future' : '')
                    const day = String(Number(key.slice(8, 10)))
                    if (future) {
                      // 键盘游标永远不会落在这里，所以这个单元格不带 activedescendant id。
                      return (
                        <span className={className} role="gridcell" aria-disabled="true" aria-label={key} key={d}>
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
                        key={d}
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
            <div className="lc-dp-foot">
              <span className="lc-dp-hint">{anchor === null ? t('ov.date.hint') : t('ov.date.hintEnd')}</span>
              {props.picked && (
                <button
                  type="button"
                  className="lc-dp-clear"
                  onClick={() => { props.onChange(null) }}
                >{t('ov.date.clear')}</button>
              )}
            </div>
          </div>,
          document.body,
        )}
      </div>
    )
  }
}
