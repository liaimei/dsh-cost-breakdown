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
import { createPortal } from 'react-dom'
import { formatNativeSpend, formatPriceRate, fromCny, type CostCurrency } from '../cost'
import { readDock, useDockBook, usePricingPeriod } from '../dockReading'
import { fmtCountdown } from '../format'
import { contextBreakdownOf, projectionOf, tokenUsageOf } from '../services'
import type { ClientCtx, SessionStandardProps } from '../services'
import type { ViewKit } from '../viewkit'
import { allDayOffReason, OFFICIAL_MODELS, peakWindowsText } from '../../shared/officialRates'
import { DOCK_CARD_MIN_HEIGHT, placeDockCard } from '../dockPlacement'
import { officialOverlayOpen } from '../officialOverlays'
import { isDeepSeekProvider } from '../../shared/providers'
import type { PlatformBalance } from '../../shared/types'
import { fmtCredits } from '../turnSpend'
import { platformSpendsOf, type PlatformSpend } from '../platformSpend'
import type { PlatformCreditsTable } from '../platformCredits'
import { usePlatformBalances } from '../platformBalanceState'
import { platformBalanceTexts } from '../platformBalances'
import { moneyRates } from '../rateTables'
import { InsightPanelIcon } from '../icon'
import { Donut } from './donut'
import { makeStatsCost } from './statsCost'
import { makeStatsPlatforms } from './statsPlatforms'
import { makeStatsTokens } from './statsTokens'

/** 平台所支持币种的符号前缀；其余币种直接显示代码。 */
/** 余额自己的轮询节奏：收起那一行长期存活，而余额随着每一笔计费请求变化，
 *  只有周期性读取才能让这行保持诚实。 */


/** 固定定位卡片的落点，以视口像素计；`maxHeight` 是翻转方向
 *  剩下的空间，好让卡片滚动而不是跑出屏幕。 */
interface Anchor { left: number; top: number; width: number; maxHeight: number }

/** 卡片宽度的**下限**（px）：与同一行那个官方浮层并排时不至于显得局促
 *  （`ContextMeter.module.css` 的 `width: min(264px, 100vw - 24px)`）。
 *
 *  实际宽度由样式表给出（`width: min(440px, 100vw - 24px)`，见 composerDock.css 的说明：
 *  卡内的百分比子项不贡献内在宽度，`max-content` 会塌到这个下限）。JS 只把量到的
 *  实际宽度用于水平夹取，量不到时（首帧样式未生效）才退回这里。 */
const CARD_MIN_WIDTH = 264

/** 视口两侧各留的边距（px）：卡片是 `position: fixed`，留出它才不会贴边。
 *  与官方面板的 `100vw - 24px` 同源（每侧 12px）。 */
const VIEWPORT_GUTTER = 12

/** 平台在这一行里显示的名字。DeepSeek 官方路由显示为人熟知的「DeepSeek」，
 *  其余原样——平台名是事实标识，不该被翻译或美化。 */
function platformLabel(row: PlatformSpend, t: ViewKit['t']): string {
  return row.provider === 'deepseek-account' || row.provider === 'deepseek-official'
    ? t('dock.platform.deepseek')
    : row.provider
}

/** 该平台的剩余额度：积分平台用 host 转发的剩余积分（DeepSeek 余额在上面单独一截）。
 *  取不到就返回 null，那一截不渲染——宁可少一个数字，也不显示过期的额度。 */
/** 该平台的剩余额度：积分平台用 host 转发的剩余积分，DeepSeek 用平台余额。
 *  两者都只归到自己那一行——把某个平台的余额挂到别家名下会是错的。
 *  取不到就返回 null，那一截不渲染：宁可少一个数字，也不显示过期或错配的额度。 */
/** 该平台的剩余额度那一截（余额或剩余积分）。
 *
 *  两者都**只归到自己那一行**：把某个平台的余额挂到别家名下会是错的。归属规则走
 *  与统计页同一个 `platformBalanceTexts`，因此三个界面不会对同一个余额给出不同答案。 */
function balanceCellFor(
  row: PlatformSpend,
  balance: PlatformBalance | null,
  credits: PlatformCreditsTable | null,
  t: ViewKit['t'],
): ReactElement | null {
  const text = platformBalanceTexts([row], balance, credits)[row.provider]?.text
  if (text === undefined) return null
  return row.unit === 'credits'
    ? <span className="lc-dock-left">{t('dock.creditsLeft', { n: text })}</span>
    : <span className="lc-dock-balance">{text}</span>
}

/** 各平台在展开卡里的余额文案；与统计页共用同一个归属函数。 */
function dockBalanceTexts(
  rows: readonly PlatformSpend[],
  balance: PlatformBalance | null,
  credits: PlatformCreditsTable | null,
): Record<string, { text: string } | undefined> {
  return platformBalanceTexts(rows, balance, credits)
}

/**
 * 绑定 `ctx`（语言 → 展示货币）与 `kit`，返回 composer 槽位的入口。
 * 宿主在切换语言时会重新渲染每个槽位入口，所以货币可以在每次渲染时读取
 * 而无须订阅；`readDock` 随后按读到的东西重新计价。
 */
export function makeComposerDock(
  ctx: ClientCtx,
  kit: ViewKit,
): (props: SessionStandardProps) => ReactElement | null {
  const { t } = kit
  // 明细卡里复用汇总统计页的那两张卡，同一份数据、同一种排版——两处因此不会各说各话。
  const StatsTokens = makeStatsTokens(kit, Donut)
  const StatsCost = makeStatsCost(kit, Donut)
  const StatsPlatforms = makeStatsPlatforms(kit, Donut)
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
    // 宽度不够时这一行只留图标（见下面那个测量 effect）。
    const [narrow, setNarrow] = useState(false)
    // 按钮是否已挂载。它决定下面那个测量 effect 何时能真正开始工作。
    const ready = reading.timeline !== null
    /** 完整读数的量宽探针：始终按完整排版，因此与当前显示哪种形态无关，判据不自激。 */
    const probeRef = useRef<HTMLSpanElement | null>(null)
    const [anchor, setAnchor] = useState<Anchor | null>(null)
    // 余额与剩余积分由共享座位读取：与统计页、会话页同一份轮询，
    // 三个界面因此不会对同一个余额给出不同答案（收起那一行也靠它保持诚实）。
    const { balance, credits } = usePlatformBalances()
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const cardRef = useRef<HTMLDivElement | null>(null)
    // 宽度够不够：比的是「留给本行的可用宽度」与「完整读数需要的宽度」，
    // 而不是拿一个写死的断点比整行总宽——官方那一行里还有用量读数与上下文环，
    // 它们先占掉一截，所以总宽够、留给本行的却可能不够。
    // 探针始终按完整排版量宽，因此「已切成图标」时判据答案不变，不会自激。
    useLayoutEffect(() => {
      const trigger = triggerRef.current
      const probe = probeRef.current
      // 按钮只在 timeline 到位后才渲染（见下面那个提前返回），所以首帧这两个 ref 都还是
      // null。effect 必须在它们出现时**重跑**一次——依赖里放 `ready` 就是为此；
      // 否则依赖永不变化，观察者永远挂不上，判据会一直停在初始的「够宽」。
      if (trigger === null || probe === null) return
      const apply = (): void => {
        const parent = trigger.parentElement
        const row = parent?.clientWidth ?? 0
        const need = probe.offsetWidth
        // 量不到时按「够宽」处理：宁可显示完整读数，也不要在异常环境里退化成图标。
        setNarrow(row > 0 && need > 0 && need > row)
      }
      apply()
      const target = trigger.parentElement
      if (target === null || typeof ResizeObserver === 'undefined') {
        window.addEventListener('resize', apply)
        return () => { window.removeEventListener('resize', apply) }
      }
      const observer = new ResizeObserver(apply)
      observer.observe(target)
      return () => { observer.disconnect() }
    }, [ready])

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
      // 宽度由样式表按内容定（`width: max-content`），这里只量出来用于水平夹取。
      // 首帧样式还没生效时量到 0，交给 `minWidth` 兜底。
      const cardWidth = card?.getBoundingClientRect().width ?? 0
      // 几何判据在 dockPlacement.ts 里（纯函数，可单测）：它负责「上方优先、确有必要
      // 才翻转、且高度有下限」这三件事——此前把触发条贴底的情形算成了屏幕外的窄带。
      const next: Anchor = placeDockCard({
        trigger: { top: rect.top, left: rect.left, width: rect.width, bottom: rect.bottom },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        natural,
        cardWidth,
        minWidth: CARD_MIN_WIDTH,
        gutter: VIEWPORT_GUTTER,
        gap: 8,
        minHeight: DOCK_CARD_MIN_HEIGHT,
      })
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

    // 官方同行浮层出现时让位：两者都在 `z-index: 1100`，同层时后挂载的赢，
    // 而插件不该把层级抬到官方之上。所以官方开着的时候，我们把卡片收起来。
    // 用 MutationObserver 盯着 body 的子节点变化——官方那个浮层是 portal 到 body 的，
    // 挂载/卸载都表现为一次子树变化。
    useEffect(() => {
      if (!open) return
      if (typeof MutationObserver === 'undefined') return
      const sync = (): void => {
        if (officialOverlayOpen()) setOpen(false)
      }
      sync()
      const observer = new MutationObserver(sync)
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
      return () => { observer.disconnect() }
    }, [open])

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
    // 峰谷只对**官方计价**的平台成立：其他平台的 `peak` 桶就是普通牌价，
    // 给它们标「峰/谷」等于替别家发明一套时段规则。当前路由未知时按官方处理，
    // 因为官方价目表是这套拆分的唯一来源。
    const onOfficialRates = reading.active === undefined || isDeepSeekProvider(reading.active.provider)
    // 这个会话**用过官方模型**吗？整块金额统计（费用卡、峰谷、价目表）都只在
    // 有过官方用量时才成立——它们描述的全是官方计价。
    const usedOfficial = reading.usage !== null
      && Object.keys(reading.usage).some(provider => isDeepSeekProvider(provider))
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
    // 悬停提示把两件事说全：峰时窗口是哪几段，以及还有多久翻转。
    // 没有可显示的平台行时的兜底读数。
    // 这里**不能**用 `reading.cost`——那是整个账本的合计，而账本里各平台的单位不同，
    // 相加得到的数没有意义（实测：两个金额平台的量相加后，在当前根本没用量的一条
    // 路由上显示出 ¥4.00，读起来像「此刻花了 4 元」）。拿不到当前平台就读不到数，
    // 用破折号如实表达。
    const costTextFallback = '—'
    // 按平台拆分本会话消费：每个平台各自带自己的单位与余额。
    // 不同平台的账单单位不同，合成一个数字没有意义。
    //
    // 这里分成两个作用域，因为它们回答的不是同一个问题：
    // - **收起那一行**只讲「此刻在用什么」：那是状态读数，不是账单，因此只取当前路由。
    // - **展开卡**是账单视图：本会话用过几个平台就列几张卡，与统计页同一个口径。
    const allPlatforms = platformSpendsOf(reading.usage, reading.calls, reading.book, moneyRates(), reading.creditRates)
    const active = reading.active
    // 当前路由所在的那一行；「这一轮还没入账」或「拿不到费率」时会是 undefined，
    // 那时状态栏不报读数（据实），但**不**退回列出全部平台。
    const activeRow = active === undefined ? undefined : allPlatforms.find(row => row.provider === active.provider)
    const platforms = active === undefined ? allPlatforms : (activeRow === undefined ? [] : [activeRow])
    // 完整读数（用于量宽）：与上面渲染的那一串同源，因此量出来的就是要显示的东西。
    const probeText = platforms.map(row => (
      platformLabel(row, t)
      + (row.unit === 'credits'
        ? t('dock.creditsSpent', { n: fmtCredits(row.value) })
        : t('dock.moneySpent', { n: formatNativeSpend(row.value, row.currency ?? 'USD') }))
      + (balanceCellFor(row, balance, credits, t) !== null ? ' ' + t('dock.creditsLeft', { n: '' }) : '')
    )).join(' · ') + (onOfficialRates ? ' · ' + periodLabel : '')
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
          className={narrow ? 'lc-dock lc-dock-narrow' : 'lc-dock'}
          data-peak={period.peak ? '1' : '0'}
          aria-expanded={open}
          title={periodTip}
          onClick={() => { setOpen(v => !v) }}
        >
          {/* 每个平台一小段：平台名 + 累计消耗 + 剩余额度。单位各自不同，因此分行
              列出、绝不相加。倒计时不在这一行——它属于时段，不属于消费，仍留在悬停里。 */}
          {platforms.length === 0
            ? <span className="lc-dock-cost">{costTextFallback}</span>
            : null}
          {/* 图标：与左侧栏「统计」入口同一个（InsightPanelIcon），因此读者认得它属于哪里。
              宽度不够时这一行只留它，完整读数仍在悬停提示里。 */}
          <InsightPanelIcon size={14} />
          {narrow
            ? null
            : (
              <>
                {platforms.map((row, i) => (
                  <span key={row.provider} className="lc-dock-platform" data-unit={row.unit}>
                    {i > 0 ? <span className="lc-dock-sep">·</span> : null}
                    <span className="lc-dock-platform-name">{platformLabel(row, t)}</span>
                    <span className="lc-dock-spend">
                      {row.unit === 'credits'
                        ? t('dock.creditsSpent', { n: fmtCredits(row.value) })
                        : t('dock.moneySpent', { n: formatNativeSpend(row.value, row.currency ?? 'USD') })}
                    </span>
                    {balanceCellFor(row, balance, credits, t)}
                  </span>
                ))}
                {/* 时段徽标：峰/谷是这一行唯一保留语义色的地方，它回答「此刻贵不贵」。
                    只对走官方峰谷计价的平台显示——其他平台没有这个概念，
                    标上去等于替别家发明一套时段规则。 */}
                {onOfficialRates
                  ? (
                    <>
                      <span className="lc-dock-sep">·</span>
                      <span className="lc-dock-period">{periodLabel}</span>
                    </>
                  )
                  : null}
                  </>
            )}
          {/* 量宽探针：**始终**按完整读数排版，因此它的宽度与当前显示图标还是全文无关——
              判据靠它才不自激。CSS 把它移出可视区，不占排布。 */}
          <span ref={probeRef} className="lc-dock-probe" aria-hidden="true">{probeText}</span>
        </button>
        {/* 只在 `open` 时挂载：`place()` 需要在同一个布局趟里量到真实高度，
            所以卡片不能等 `anchor` 就绪才出现（那时 ref 还是 null，只能退回兜底高度，
            卡片会停在一个错的 top 上）。`anchor` 未就绪的这一帧先不定位，
            靠 `visibility: hidden` 藏住，避免出现在 0,0 处闪一下。 */}
        {open
          ? createPortal(
            <div
              ref={cardRef}
              className="lc-dock-card"
              style={{
                left: anchor === null ? 0 : anchor.left,
                top: anchor === null ? 0 : anchor.top,
                maxHeight: anchor === null ? undefined : anchor.maxHeight,
                visibility: anchor === null ? 'hidden' : undefined,
              }}
            >
              <div className="lc-dock-head">
                <span className="lc-dock-head-title">{t('dock.title')}</span>
                {onOfficialRates
                  ? <span className={'lc-dock-badge' + (period.peak ? ' lc-dock-badge-peak' : '')}>{periodLabel}</span>
                  : null}
              </div>
              {/* 标题下的发丝分割线：官方 stat-dialog 的 `.titleRule` 把标题与明细分开，
                  插件同步这一笔，两块面板读作同一种排版。 */}
              <div className="lc-dock-head-rule" aria-hidden="true" />
              {/* 峰谷窗口与倒计时在展开卡里也写全：收起那一行只放得下一个倒计时，
                  而「峰时是哪几段」正是这张卡要回答的问题。
                  整块只对走官方峰谷计价的平台出现——其他平台没有这个概念。 */}
              {onOfficialRates
                ? (
                  <div className="lc-dock-period-row">
                    <span className="lc-dock-period-windows">{t('dock.peakWindows', { windows })}</span>
                    <span className="lc-dock-period-eta">
                      {dayOff === 'weekend' ? t('dock.weekendOff') : null}
                      {dayOff === 'holiday' ? t('dock.holidayOff') : null}
                      {countdownText !== null ? countdownText : null}
                    </span>
                  </div>
                )
                : null}
              {/* 余额不再单列：费用卡自带那行（与统计页一致），两处各写一遍会显得像两个数。 */}
              <div className="lc-dock-cards">
                <StatsTokens usage={tokenUsage} current={reading.timeline.current} breakdown={breakdown} />
                {/* 费用卡只在**这个会话用过官方模型**时出现：峰谷、人民币价目表、
                    按 token 的拆分都是官方计价才有的概念，一个只用积分平台的会话
                    显示它等于凭空造出一笔账单。只算当前在用的那个平台。 */}
                {usedOfficial
                  ? (
                <StatsCost
                  usage={reading.usage}
                  calls={reading.calls ?? null}
                  creditRates={reading.creditRates ?? null}
                  provider={platforms[0]?.provider ?? null}
                  unit={platforms[0]?.unit}
                    creditsValue={platforms[0]?.unit === 'credits' ? platforms[0].value : undefined}
                    currency={currency}
                  />
                  )
                  : null}
                {/* 每个平台一张卡：本会话用过几个平台就列几张，与统计页同一个组件、
                    同一份数据。这里用**全部**平台而不是收起那一行的单个路由——
                    展开卡是账单视图，不是「此刻在用什么」的状态读数。 */}
                <StatsPlatforms
                  rows={allPlatforms}
                  currency={currency}
                  balances={dockBalanceTexts(allPlatforms, balance, credits)}
                />
              </div>
              {/* 价目表是**官方人民币**的费率表，只对走官方计价的平台显示：
                  对积分平台列出人民币单价，读者会以为那就是它的账单。 */}
              {onOfficialRates
                ? <DockRates kit={kit} peak={period.peak} currency={currency} />
                : null}
              {/* 估算值说明说的是「按官方价目表计算」——没有官方用量时那句话
                  既不对也多余。 */}
              {usedOfficial
                ? <div className="lc-dock-note">{t('dock.note')}</div>
                : null}
            </div>,
            document.body,
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
