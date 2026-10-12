/**
 * 输入框下方那行常驻开销读数——composer dock。
 *
 * 收起时它只有一行：本会话的开销、DeepSeek 余额，以及
 * 当前定价时段。点击会展开一张明细卡片，里面装着**汇总统计页的两张卡**——
 * 「Token 统计」与「费用统计」——外加官方费率表：同一份数据、同一种排版，
 * 因此输入框下方与统计页读到的永远是一回事。
 *
 * 这张卡片是 `position: fixed` 的，从触发器量出来，因而得以避开
 * composer 自身的溢出裁剪；上方没有空间时它翻转到触发器下方，
 * 并夹在视口之内。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { balanceEntryOf, readPlatformBalance } from '../balance'
import { formatCost, formatPriceRate, fromCny, type CostCurrency } from '../cost'
import { readDock, useDockBook, usePricingPeriod } from '../dockReading'
import { fmtCountdown, fmtCountdownCompact } from '../format'
import { contextBreakdownOf, projectionOf, tokenUsageOf } from '../services'
import type { ClientCtx, SessionStandardProps } from '../services'
import type { ViewKit } from '../viewkit'
import { allDayOffReason, OFFICIAL_MODELS, peakWindowsText } from '../../shared/officialRates'
import { IconClock } from '../primitives'
import type { PlatformBalance } from '../../shared/types'
import { Donut } from './donut'
import { makeStatsCost } from './statsCost'
import { makeStatsTokens } from './statsTokens'

/** 平台所支持币种的符号前缀；其余币种直接显示代码。 */
function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return currency + ' '
}

/** 余额自己的轮询节奏：收起那一行长期存活，而余额随着每一笔计费请求变化，
 *  只有周期性读取才能让这行保持诚实。 */
const BALANCE_POLL_MS = 60_000

/** 固定定位卡片的落点，以视口像素计；`maxHeight` 是翻转方向
 *  剩下的空间，好让卡片滚动而不是跑出屏幕。 */
interface Anchor { left: number; top: number; width: number; maxHeight: number }

/** 卡片宽度（px）：对齐 harness 官方面板的上限（`stat-dialog.module.css` 的
 *  `max-width: min(440px, 100vw - 24px)`），两张复用卡的环形图与图例因此能并排
 *  放下且不与官方弹窗抢宽度。实际宽度再受触发条与视口约束（见 `place()`）。 */
const CARD_WIDTH = 440

/** 视口两侧各留的边距（px）：卡片是 `position: fixed`，留出它才不会贴边。
 *  与官方面板的 `100vw - 24px` 同源（每侧 12px）。 */
const VIEWPORT_GUTTER = 12

/** 极窄视口下的兜底宽度（px），避免在异常环境下算出 0 或负数。 */
const CARD_MIN_VIEWPORT_WIDTH = 200

/** 这一行放不放得下**完整读数**。
 *
 *  判据是「留给本行的空间」与「完整内容需要的宽度」之比，而不是拿一个写死的
 *  断点去比这一行的总宽：官方那一行里还有用量读数与上下文环，它们先占掉一截，
 *  所以**总宽够、留给本行的却可能不够**——线上正是这种情况（行宽约 860px，
 *  官方两块占掉约 260px，留给本行的约 570px，而整句需要约 600px）。
 *
 *  `have` 由「父级内容宽 − 其它条目宽度」算出，`need` 由一句**始终渲染但不可见**
 *  的量宽探针给出——两者都与当前渲染的是整句还是紧凑形态无关，因此不会自激。 */
export type IsRowTooNarrow = (trigger: HTMLElement) => boolean

/** 量宽探针的类名；JSX 里始终渲染，CSS 里挪出可视区。 */
export const PROBE_CLASS = 'lc-dock-probe'

export const isRowTooNarrow: IsRowTooNarrow = (trigger) => {
  const parent = trigger.parentElement
  const probe = trigger.querySelector<HTMLElement>('.' + PROBE_CLASS)
  if (parent === null || probe === null) return false
  // 探针始终按整句排版，所以它的宽度与当前渲染哪种形态无关——这是不自激的关键。
  const full = probe.offsetWidth
  const row = parent.clientWidth
  if (full <= 0 || row <= 0) return false
  // 本行除倒计时以外的部分。整句形态下 = 总宽 − 整句宽；紧凑形态下 = 总宽 − 紧凑宽；
  // 两者都等于同一份核心读数宽度，因此同样与形态无关。
  const countdown = trigger.querySelector<HTMLElement>('.lc-dock-countdown')
  const core = trigger.offsetWidth - (countdown?.offsetWidth ?? 0)
  // 兄弟条目（官方用量读数、上下文环）占掉的宽度。本行自己的浮层卡不算：
  // 它是 `position: fixed`，不参与这一行的排布。
  let others = 0
  let count = 0
  for (const child of Array.from(parent.children)) {
    if (child === trigger || child.classList.contains('lc-dock-card')) continue
    const width = (child as HTMLElement).offsetWidth
    if (width > 0) {
      others += width
      count += 1
    }
  }
  // 条目之间各有一个 gap；兄弟有 count 个，加上本行共 count 个间隔。
  const gap = Number.parseFloat(getComputedStyle(parent).columnGap) || 0
  const have = row - others - gap * count
  return core + full > have
}

/**
 * 绑定 `ctx`（语言 → 展示货币）与 `kit`，返回 composer 槽位的入口。
 * 宿主在切换语言时会重新渲染每个槽位入口，所以货币可以在每次渲染时读取
 * 而无须订阅；`readDock` 随后按读到的东西重新计价。
 */
export function makeComposerDock(
  ctx: ClientCtx,
  kit: ViewKit,
  tooNarrow: IsRowTooNarrow = isRowTooNarrow,
): (props: SessionStandardProps) => ReactElement | null {
  const { t } = kit
  // 明细卡里复用汇总统计页的那两张卡，同一份数据、同一种排版——两处因此不会各说各话。
  const StatsTokens = makeStatsTokens(kit, Donut)
  const StatsCost = makeStatsCost(kit, Donut)
  /** 当前语言决定展示货币，与其他每个成本界面一样；
   *  harness 在切换语言时会重新渲染每个槽位入口，所以每次渲染读一次就是精确的。 */
  const localeNow = (): string => {
    try {
      const locale = ctx.locale
      return typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
    } catch {
      return 'en'
    }
  }
  const currencyNow = (): CostCurrency => (localeNow() === 'zh' ? 'cny' : 'usd')
  return function ComposerDock(props: SessionStandardProps): ReactElement | null {
    const currency = currencyNow()
    const activeLocale = localeNow()
    const { book, failed } = useDockBook()
    const reading = readDock(props, { currency }, book, failed)
    const period = usePricingPeriod()
    const [open, setOpen] = useState(false)
    const [anchor, setAnchor] = useState<Anchor | null>(null)
    const [balance, setBalance] = useState<PlatformBalance | null>(null)
    const [narrow, setNarrow] = useState(false)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const cardRef = useRef<HTMLDivElement | null>(null)
    // 按钮只在 timeline 到位后才渲染（见下面那个提前返回）。首帧它是 null，
    // 所以这个 effect 必须在它出现时**重跑**一次：把 `hasTrigger` 放进依赖。
    // 否则 `triggerRef.current === null` 那一帧会直接 return，而依赖永不变化，
    // 观察者就永远挂不上——判据永远停在初始的「够宽」，也就是线上表现出的「不生效」。
    const hasTrigger = reading.timeline !== null

    // 状态栏放不下完整读数时切到紧凑形态。判据见 `isRowTooNarrow`：
    // 比的是「留给本行的空间」与「完整内容需要的宽度」，因此官方那两块先占位、
    // 本行只剩一点空间的情况也能正确降级。用 ResizeObserver 观察父级：
    // 它的宽度由对话栏决定，与我们的内容无关，所以不会自激。
    useLayoutEffect(() => {
      if (!hasTrigger) return
      const trigger = triggerRef.current
      if (trigger === null) return
      const apply = (): void => { setNarrow(tooNarrow(trigger)) }
      apply()
      // 父级宽度变化（对话栏伸缩、侧栏开合）都要重新判定。
      const target = trigger.parentElement
      if (target === null || typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', apply)
        return () => { window.removeEventListener('resize', apply) }
      }
      const observer = new ResizeObserver(apply)
      observer.observe(target)
      return () => { observer.disconnect() }
    }, [tooNarrow, hasTrigger])

    // 收起那一行自己也要显示余额，所以这份读取不能省：先画记住的数字，
    // 随后在 dock 保持挂载期间由轮询让它保持诚实，切换会话时清理计时器。
    // （展开卡里的余额行由费用卡自己承担，见下面的 StatsCost。）
    useEffect(() => {
      setBalance(readPlatformBalance(setBalance))
      const timer = setInterval(() => { setBalance(readPlatformBalance(setBalance)) }, BALANCE_POLL_MS)
      return () => { clearInterval(timer) }
    }, [])

    /** 上一次真正应用过的锚点。ResizeObserver 的回调会因为卡片自身尺寸变化而再次触发，
     *  而 `maxHeight` 又取决于测得的高度——没有这道闸门，两者会互相推动形成循环。 */
    const appliedAnchor = useRef<string>('')

    // 测量触发器并把卡片钉在它上方，没有空间时翻到下方。
    // 卡片此时已挂载（渲染条件只看 `open`），因此这里量到的是真实高度；
    // 量不到时才退回 260px 的兜底值。
    const place = useCallback(() => {
      const trigger = triggerRef.current
      /* place() 只从那个仅在触发器位于屏幕内时才触发的布局 effect 里调用，
         * 所以到那时 ref 一定已经挂上。 */
      if (trigger === null) return
      const rect = trigger.getBoundingClientRect()
      const card = cardRef.current
      // 取「内容高度」而不是「当前盒高」：卡片一旦被 maxHeight 夹住，盒高就等于
      // maxHeight，用它反推 maxHeight 会自我循环；`scrollHeight` 是内容自身的高度，
      // 不受夹取影响，因此同一个输入永远得到同一个锚点。
      const boxHeight = card?.getBoundingClientRect().height ?? 0
      const contentHeight = card?.scrollHeight ?? 0
      const natural = Math.max(boxHeight, contentHeight) || 260
      const above = rect.top - natural - 8
      const flip = above < 8
      const available = Math.max(120, (flip ? window.innerHeight - rect.bottom : rect.top) - 16)
      const height = Math.min(natural, available)
      // 宽度：以内容偏好为准，再夹进视口（两侧各留边距），同时不窄于触发条。
      // 只跟随触发条会把复用卡右列的数值挤出卡片；而宽度一旦超过视口又会长出
      // 横向滚动条，所以这里主动夹好，配套 CSS 把横向溢出关死。
      const viewportMax = Math.max(CARD_MIN_VIEWPORT_WIDTH, window.innerWidth - VIEWPORT_GUTTER * 2)
      const width = Math.min(Math.max(rect.width, CARD_WIDTH), viewportMax)
      const next: Anchor = {
        left: Math.max(VIEWPORT_GUTTER, Math.min(rect.left, window.innerWidth - width - VIEWPORT_GUTTER)),
        top: flip ? rect.bottom + 8 : rect.top - height - 8,
        width,
        maxHeight: available,
      }
      // 只有结果真的变了才 setState：否则观察者每回调一次就重渲染一次。
      const key = `${next.left}|${next.top}|${next.width}|${next.maxHeight}`
      if (appliedAnchor.current === key) return
      appliedAnchor.current = key
      setAnchor(next)
    }, [])

    // 布局 effect 在浏览器绘制前跑完，所以这一趟的测量结果就是首帧：卡片
    // 不会先画在按兜底值算出的位置上再跳一下。依赖只有 `open`：卡片一旦挂载，
    // 后续的高度变化由下面的 ResizeObserver 负责，而不是重跑本 effect。
    useLayoutEffect(() => {
      if (!open) return
      place()
      const onResize = (): void => { place() }
      window.addEventListener('resize', onResize)
      return () => { window.removeEventListener('resize', onResize) }
    }, [open, place])

    // 卡片内容是异步长出来的：余额行要等挂载后的那次读取、费率表要等价目册
    // 到位，两者都会把卡片撑高。没有观察者的话，锚点是按「还没长高」的旧高度
    // 算的，卡片底部会压到触发条上。
    useEffect(() => {
      if (!open) return
      const card = cardRef.current
      if (card === null || typeof ResizeObserver === 'undefined') return
      const observer = new ResizeObserver(() => { place() })
      observer.observe(card)
      return () => { observer.disconnect() }
    }, [open, place])

    // 在外部按下或 Escape 时关闭。
    useEffect(() => {
      if (!open) return
      const onDown = (ev: MouseEvent): void => {
        const target = ev.target as Node | null
        /* mousedown 总是在某个节点上派发。 */
        if (target === null) return
        if (triggerRef.current?.contains(target) === true) return
        if (cardRef.current?.contains(target) === true) return
        setOpen(false)
      }
      const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') setOpen(false) }
      document.addEventListener('mousedown', onDown)
      document.addEventListener('keydown', onKey)
      return () => {
        document.removeEventListener('mousedown', onDown)
        document.removeEventListener('keydown', onKey)
      }
    }, [open])

    // 两张复用卡读的是与统计页同一批投影：Token 卡要 `tokenUsage` 与
    // `contextBreakdown`，而当前上下文取自 timeline 自身（`ContextTimeline` 就是
    // `Snapshot`）。投影未装配时它们的空状态照常成立。
    // `projectionOf` 是 hook，必须在下面那个提前返回**之前**无条件调用，
    // 否则首帧（timeline 为 null）与之后各帧的 hook 数量不一致。
    const tokenUsage = projectionOf(props, 'tokenUsage', tokenUsageOf)
    const breakdown = projectionOf(props, 'contextBreakdown', contextBreakdownOf)

    // 第一个推来的值出现之前没有什么可报告的：宁可不渲染任何单元格，
    // 也不要渲染一个误导性的 0。
    if (reading.timeline === null) return null
    const entry = balanceEntryOf(balance, currency)
    const costText = reading.cost === null ? '—' : formatCost(reading.cost, currency)
    const periodLabel = t(period.peak ? 'dock.peak' : 'dock.off')
    // 峰时窗口由官方表派生，分隔符按语言给：中文用顿号，其余用逗号。
    const windows = peakWindowsText(activeLocale === 'zh' ? '、' : ', ')
    // 周末/节假日全天谷时：当天根本没有峰时窗口，改说原因，
    // 而不是报一个指向「下一个工作日 09:00」的倒计时——那会让人以为今天还有峰时。
    const dayOff = allDayOffReason(period.now)
    // 倒计时指向「即将进入」的那个时段，所以文案取当前时段的反面。
    const countdown = fmtCountdown(t, period.remainingMs)
    const countdownText = countdown === null || dayOff !== null
      ? null
      : t(period.peak ? 'dock.toOff' : 'dock.toPeak', { countdown })
    // 窄状态栏的退化形态：整句「6 小时 38 分 后进入峰时」放不下时，
    // 换成一个时钟图标 + 紧凑读数（`6h38m`）。两者由 CSS 按容器宽度二选一，
    // 数字都来自同一个 `remainingMs`，不会各走各的。
    const compactCountdown = dayOff === null ? fmtCountdownCompact(period.remainingMs) : null
    // 悬停提示把两件事说全：峰时窗口是哪几段，以及还有多久翻转。
    const periodTip = [
      t('dock.peakWindows', { windows }),
      dayOff === 'weekend' ? t('dock.weekendOff') : null,
      dayOff === 'holiday' ? t('dock.holidayOff') : null,
      countdownText,
    ].filter((part): part is string => part !== null).join(' · ')

    return (
      <>
        <button
          type="button"
          ref={triggerRef}
          className="lc-dock"
          data-peak={period.peak ? '1' : '0'}
          aria-expanded={open}
          title={periodTip}
          onClick={() => { setOpen(v => !v) }}
        >
          <span className="lc-dock-cost">{costText}</span>
          {entry !== null
            ? <span className="lc-dock-sep">·</span>
            : null}
          {entry !== null
            ? <span className="lc-dock-balance">{symbolOf(entry.currency) + entry.total.toFixed(2)}</span>
            : null}
          <span className="lc-dock-sep">·</span>
          <span className="lc-dock-period">{periodLabel}</span>
          {/* 宽时读整句，窄时读时钟图标 + 紧凑读数。两者互斥渲染，
              数字都来自同一个 `remainingMs`，所以不会各走各的。 */}
          {countdownText !== null && !narrow
            ? <span className="lc-dock-countdown">{countdownText}</span>
            : null}
          {compactCountdown !== null && narrow
            ? (
              <span className="lc-dock-countdown" title={countdownText ?? undefined}>
                <IconClock size={12} />
                {compactCountdown}
              </span>
            )
            : null}
          {/* 量宽探针：**始终**按整句排版，因此它的宽度与当前显示的是整句还是
              紧凑形态无关——判据靠它才不自激。CSS 把它移出可视区，不占排布。 */}
          {countdownText !== null
            ? <span className={PROBE_CLASS} aria-hidden="true">{countdownText}</span>
            : null}
        </button>
        {/* 只在 `open` 时挂载：`place()` 需要在同一个布局趟里量到真实高度，
            所以卡片不能等 `anchor` 就绪才出现（那时 ref 还是 null，只能退回兜底高度，
            卡片会停在一个错的 top 上）。`anchor` 未就绪的这一帧先不定位，
            靠 `visibility: hidden` 藏住，避免出现在 0,0 处闪一下。 */}
        {open
          ? (
            <div
              ref={cardRef}
              className="lc-dock-card"
              style={{
                left: anchor === null ? 0 : anchor.left,
                top: anchor === null ? 0 : anchor.top,
                minWidth: anchor === null ? undefined : anchor.width,
                maxHeight: anchor === null ? undefined : anchor.maxHeight,
                visibility: anchor === null ? 'hidden' : undefined,
              }}
            >
              <div className="lc-dock-head">
                <span className="lc-dock-head-title">{t('dock.title')}</span>
                <span className={'lc-dock-badge' + (period.peak ? ' lc-dock-badge-peak' : '')}>{periodLabel}</span>
              </div>
              {/* 峰谷窗口与倒计时在展开卡里也写全：收起那一行只放得下一个倒计时，
                  而「峰时是哪几段」正是这张卡要回答的问题。 */}
              <div className="lc-dock-period-row">
                <span className="lc-dock-period-windows">{t('dock.peakWindows', { windows })}</span>
                <span className="lc-dock-period-eta">
                  {dayOff === 'weekend' ? t('dock.weekendOff') : null}
                  {dayOff === 'holiday' ? t('dock.holidayOff') : null}
                  {countdownText !== null ? countdownText : null}
                </span>
              </div>
              {/* 余额不再单列：费用卡自带那行（与统计页一致），两处各写一遍会显得像两个数。 */}
              <div className="lc-dock-cards">
                <StatsTokens usage={tokenUsage} current={reading.timeline.current} breakdown={breakdown} />
                <StatsCost
                  usage={reading.usage}
                  calls={reading.calls ?? null}
                  creditRates={reading.creditRates ?? null}
                  currency={currency}
                />
              </div>
              <DockRates kit={kit} peak={period.peak} currency={currency} />
              <div className="lc-dock-note">{t('dock.note')}</div>
            </div>
          )
          : null}
      </>
    )
  }
}

/** 当前生效时段的官方费率表。费率住在表格自己的 CNY 空间里，
 *  逐格换算，所以切换货币永远不需要第二张表。 */
/** 当前生效时段的官方费率表。费率住在表格自己的 CNY 空间里，
 *  逐格换算，所以切换货币永远不需要第二张表。
 *  三列各取自己的颜色，与上方 token 分桶一一对应——表里哪一列贵、
 *  用量花在哪个桶，用同一种颜色说话。 */
function DockRates(props: { kit: ViewKit; peak: boolean; currency: CostCurrency }): ReactElement {
  const { t } = props.kit
  return (
    <div className="lc-dock-card-block">
      <div className="lc-dock-block-title">{t('dock.rates')}</div>
      <table className="lc-dock-table">
        <thead>
          <tr>
            <th>{t('dock.model')}</th>
            <th>{t('stats.costHit')}</th>
            <th>{t('stats.costMiss')}</th>
            <th>{t('stats.costOut')}</th>
          </tr>
        </thead>
        <tbody>
          {OFFICIAL_MODELS.map(row => {
            const rate = props.peak ? row.peak : row.offPeak
            return (
              <tr key={row.id}>
                <td>{row.label}</td>
                {(['hit', 'miss', 'out'] as const).map(k => (
                  <td key={k} className={'lc-dock-rate-' + k}>{formatPriceRate(fromCny(rate[k], props.currency), props.currency)}</td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
