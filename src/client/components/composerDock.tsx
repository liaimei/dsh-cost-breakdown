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
import {formatCost, formatPriceRate, fromCny, toCurrency, type CostCurrency, symbolOf } from '../cost'
import { readDock, useDockBook, usePricingPeriod } from '../dockReading'
import { fmtCountdown } from '../format'
import { contextBreakdownOf, projectionOf, tokenUsageOf } from '../services'
import type { ClientCtx, SessionStandardProps } from '../services'
import type { ViewKit } from '../viewkit'
import { allDayOffReason, OFFICIAL_MODELS, peakWindowsText } from '../../shared/officialRates'
import { BALANCE_POLL_MS } from '../constants'
import { isDeepSeekProvider } from '../../shared/providers'
import type { PlatformBalance, PlatformBalanceEntry } from '../../shared/types'
import { fmtCredits } from '../turnSpend'
import { platformSpendsOf, type PlatformSpend } from '../platformSpend'
import { readPlatformCredits, type PlatformCredits } from '../platformCredits'
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

/** 卡片宽度（px）：对齐 harness 官方面板的上限（`stat-dialog.module.css` 的
 *  `max-width: min(440px, 100vw - 24px)`），两张复用卡的环形图与图例因此能并排
 *  放下且不与官方弹窗抢宽度。实际宽度再受触发条与视口约束（见 `place()`）。 */
const CARD_WIDTH = 440

/** 视口两侧各留的边距（px）：卡片是 `position: fixed`，留出它才不会贴边。
 *  与官方面板的 `100vw - 24px` 同源（每侧 12px）。 */
const VIEWPORT_GUTTER = 12

/** 极窄视口下的兜底宽度（px），避免在异常环境下算出 0 或负数。 */
const CARD_MIN_VIEWPORT_WIDTH = 200

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
 *  两者都**只归到自己那一行**：把某个平台的余额挂到别家名下会是错的。
 *  取不到就返回 null，那一截不渲染——宁可少一个数字，也不显示过期或错配的额度。
 *  余额沿用既有的 `.lc-dock-balance` 类名，因此配色与既有样式一致。 */
function balanceCellFor(
  row: PlatformSpend,
  credits: PlatformCredits | null,
  balance: PlatformBalanceEntry | null,
  symbolOf: (currency: string) => string,
  t: ViewKit['t'],
): ReactElement | null {
  if (row.unit === 'credits') {
    if (credits === null || credits.unlimited) return null
    return <span className="lc-dock-left">{t('dock.creditsLeft', { n: fmtCredits(credits.total) })}</span>
  }
  // 金额平台：只有 DeepSeek 的余额我们读得到，因此只给它这一行。
  if (!isDeepSeekProvider(row.provider) || balance === null) return null
  return <span className="lc-dock-balance">{symbolOf(balance.currency) + balance.total.toFixed(2)}</span>
}


/** 各平台在展开卡里的余额文案。归属规则与统计页一致：DeepSeek 的账户余额只给
 *  DeepSeek，剩余积分只给积分平台；读不到的整行不出现。 */
function dockBalanceTexts(
  rows: readonly PlatformSpend[],
  entry: PlatformBalanceEntry | null,
  credits: PlatformCredits | null,
): Record<string, { text: string } | undefined> {
  const out: Record<string, { text: string } | undefined> = {}
  for (const row of rows) {
    if (row.unit === 'credits') {
      out[row.provider] = credits === null || credits.unlimited ? undefined : { text: fmtCredits(credits.total) }
      continue
    }
    out[row.provider] = isDeepSeekProvider(row.provider) && entry !== null
      ? { text: symbolOf(entry.currency) + entry.total.toFixed(2) }
      : undefined
  }
  return out
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
  const StatsPlatforms = makeStatsPlatforms(kit)
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
    // 平台的剩余积分（积分制平台）；与余额同一套「先画记住的数字、再后台校正」的语义。
    const [credits, setCredits] = useState<PlatformCredits | null>(() => readPlatformCredits((v: PlatformCredits) => { setCredits(v) }))
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const cardRef = useRef<HTMLDivElement | null>(null)
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
    // 一个平台都定不出价时的兜底读数：那时没有平台行可显示，但这一行仍有话要说
    // （「还没有可计价的量」或「有量但拿不到费率」），用破折号如实表达。
    const costTextFallback = reading.cost === null ? '—' : formatCost(reading.cost, currency)
    // 按平台拆分本会话消费：每个平台各自带自己的单位与余额。
    // 这是这行读数的主内容——不同平台的账单单位不同，合成一个数字没有意义。
    const platforms = platformSpendsOf(reading.usage, reading.calls, reading.book, null, reading.creditRates)
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
          {/* 每个平台一小段：平台名 + 累计消耗 + 剩余额度。单位各自不同，因此分行
              列出、绝不相加。倒计时不在这一行——它属于时段，不属于消费，仍留在悬停里。 */}
          {platforms.length === 0
            ? <span className="lc-dock-cost">{costTextFallback}</span>
            : null}
          {platforms.map((row, i) => (
            <span key={row.provider} className="lc-dock-platform" data-unit={row.unit}>
              {i > 0 ? <span className="lc-dock-sep">·</span> : null}
              <span className="lc-dock-platform-name">{platformLabel(row, t)}</span>
              <span className="lc-dock-spend">
                {row.unit === 'credits'
                  ? t('dock.creditsSpent', { n: fmtCredits(row.value) })
                  : t('dock.moneySpent', { n: formatCost(toCurrency(row.value, currency), currency) })}
              </span>
              {balanceCellFor(row, credits, entry, symbolOf, t) !== null
                ? balanceCellFor(row, credits, entry, symbolOf, t)
                : null}
            </span>
          ))}
          {/* 时段徽标：峰/谷是这一行唯一保留语义色的地方，它回答「此刻贵不贵」，
              与旁边的消费读数互补。倒计时仍在悬停提示里，不占这一行。 */}
          <span className="lc-dock-sep">·</span>
          <span className="lc-dock-period">{periodLabel}</span>
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
                {/* 每个平台一张卡，与统计页同一个组件、同一份数据。 */}
                <StatsPlatforms
                  rows={platforms}
                  currency={currency}
                  balances={dockBalanceTexts(platforms, entry, credits)}
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
