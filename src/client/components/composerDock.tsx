/**
 * 输入框下方那行常驻开销读数——composer dock。
 *
 * 收起时它只有一行：本会话的开销、DeepSeek 余额，以及
 * 当前定价时段。点击会展开一张明细卡片，里面装着 token 拆分、
 * 按时段的成本拆分，以及官方费率表。
 *
 * 这张卡片是 `position: fixed` 的，从触发器量出来，因而得以避开
 * composer 自身的溢出裁剪；上方没有空间时它翻转到触发器下方，
 * 并夹在视口之内。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { balanceEntryOf, readPlatformBalance } from '../balance'
import { estimateSessionCostByPeriod, formatCost, formatPriceRate, fromCny, toCurrency, type CostCurrency } from '../cost'
import { readDock, useDockBook, usePricingPeriod } from '../dockReading'
import type { ClientCtx, SessionStandardProps } from '../services'
import { fmt, fmtShare } from '../format'
import type { ViewKit } from '../viewkit'
import { OFFICIAL_MODELS } from '../../shared/officialRates'
import type { PlatformBalance } from '../../shared/types'

/** 平台所支持币种的符号前缀；其余币种直接显示代码。 */
function symbolOf(currency: string): string {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return currency + ' '
}

/** 余额数字背后那个旧版平台控制台页面。 */
const USAGE_URL = 'https://platform.deepseek.com/usage'

/** 余额自己的轮询节奏：这行读数长期存活，而数字随着每一笔
 *  计费请求变化，只有周期性读取才能让这行保持诚实。 */
const BALANCE_POLL_MS = 60_000

/** 固定定位卡片的落点，以视口像素计；`maxHeight` 是翻转方向
 *  剩下的空间，好让卡片滚动而不是跑出屏幕。 */
interface Anchor { left: number; top: number; width: number; maxHeight: number }

/** 成本块绘制的定价时段带，按顺序排列。 */
const PERIOD_BANDS = [
  { key: 'peak', labelKey: 'dock.peak' },
  { key: 'off', labelKey: 'dock.off' },
] as const

/**
 * 绑定 `ctx`（语言 → 展示货币）与 `kit`，返回 composer 槽位的入口。
 * 宿主在切换语言时会重新渲染每个槽位入口，所以货币可以在每次渲染时读取
 * 而无须订阅；`readDock` 随后按读到的东西重新计价。
 */
export function makeComposerDock(ctx: ClientCtx, kit: ViewKit): (props: SessionStandardProps) => ReactElement | null {
  const { t } = kit
  /** 当前语言决定展示货币，与其他每个成本界面一样；
   *  harness 在切换语言时会重新渲染每个槽位入口，所以每次渲染读一次就是精确的。 */
  const currencyNow = (): CostCurrency => {
    try {
      const locale = ctx.locale
      const active = typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
      return active === 'zh' ? 'cny' : 'usd'
    } catch {
      return 'usd'
    }
  }
  return function ComposerDock(props: SessionStandardProps): ReactElement | null {
    const currency = currencyNow()
    const { book, failed } = useDockBook()
    const reading = readDock(props, { currency }, book, failed)
    const period = usePricingPeriod()
    const [open, setOpen] = useState(false)
    const [anchor, setAnchor] = useState<Anchor | null>(null)
    const [balance, setBalance] = useState<PlatformBalance | null>(null)
    const triggerRef = useRef<HTMLButtonElement | null>(null)
    const cardRef = useRef<HTMLDivElement | null>(null)

    // 第一个数字必须来自记住的那次读取，而不是转圈：随后在 dock 保持挂载期间由轮询让
    // 它保持诚实，而清理函数会在切换会话时停掉计时器。
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
      const next: Anchor = {
        left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
        top: flip ? rect.bottom + 8 : rect.top - height - 8,
        width: rect.width,
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

    // 第一个推来的值出现之前没有什么可报告的：宁可不渲染任何单元格，
    // 也不要渲染一个误导性的 0。
    if (reading.timeline === null) return null
    const entry = balanceEntryOf(balance, currency)
    const split = estimateSessionCostByPeriod(reading.usage, book)
    const peak = toCurrency(split.peak, currency)
    const off = toCurrency(split.off, currency)
    const periodSum = peak + off
    const costText = reading.cost === null ? '—' : formatCost(reading.cost, currency)
    const periodLabel = t(period.peak ? 'dock.peak' : 'dock.off')

    return (
      <>
        <button
          type="button"
          ref={triggerRef}
          className="lc-dock"
          data-peak={period.peak ? '1' : '0'}
          aria-expanded={open}
          title={t('dock.title')}
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
              {entry !== null
                ? (
                  <a className="lc-dock-balance-row" href={USAGE_URL} target="_blank" rel="noreferrer">
                    <span>{t('balance.title')}</span>
                    <b>{symbolOf(entry.currency) + entry.total.toFixed(2)}</b>
                  </a>
                )
                : null}
              <DockTokens kit={kit} reading={reading} />
              <DockCost kit={kit} peak={peak} off={off} periodSum={periodSum} currency={currency} />
              <DockRates kit={kit} peak={period.peak} currency={currency} />
              <div className="lc-dock-note">{t('dock.note')}</div>
            </div>
          )
          : null}
      </>
    )
  }
}

/** 行内进度条填充的入场类：与堆叠条/计时条/Agent 条同款（`scaleX` 生长），
 *  并自带 `motion-reduce:animate-none`，尊重系统的「减少动效」偏好。
 *  留前导空格以便直接拼接（与 trendChart 的 `RISE_CLASS` 同一写法）。 */
const BAR_RISE = ' animate-lc-stacked-in motion-reduce:animate-none'

/** token 拆分：先是计费总量，然后是三个分桶及其占比。投影还没有用量时
 *  什么都不渲染，所以卡片永远不会显示一份全零的拆分。 */
function DockTokens(props: { kit: ViewKit; reading: ReturnType<typeof readDock> }): ReactElement | null {
  const { t } = props.kit
  const usage = props.reading.usage
  if (usage === null) return null
  let cacheRead = 0
  let miss = 0
  let output = 0
  for (const models of Object.values(usage)) {
    for (const model of Object.keys(models)) {
      const periods = models[model]
      for (const key of ['peak', 'off'] as const) {
        const bucket = periods[key]
        if (bucket === undefined) continue
        cacheRead += bucket.cacheRead
        miss += bucket.uncached + bucket.cacheWrite
        output += bucket.output
      }
    }
  }
  const total = props.reading.tokens
  if (total <= 0) return null
  const rows = [
    { key: 'cacheHit', value: cacheRead, tint: 'hit' },
    { key: 'cacheMiss', value: miss, tint: 'miss' },
    { key: 'output', value: output, tint: 'out' },
  ]
  return (
    <div className="lc-dock-card-block">
      <div className="lc-dock-block-title">
        {t('dock.tokens')}
        <b>{fmt(total)}</b>
      </div>
      {rows.map(r => (
        <div key={r.key} className="lc-dock-block-row" data-zero={r.value <= 0 ? '1' : undefined}>
          <span>{t('dock.' + r.key)}</span>
          <span className={'lc-dock-block-track lc-dock-tint-' + r.tint}><i className={'lc-dock-bar-fill' + BAR_RISE} style={{ width: fmtShare(r.value, total) }} /></span>
          <b>{fmt(r.value)}</b>
          <em>{fmtShare(r.value, total)}</em>
        </div>
      ))}
    </div>
  )
}

/** 按时段的成本拆分；一个计价为零的会话不贡献任何带。
 *  峰/谷各用自己的色（红/绿），两行同色的话这张表读不出「贵的占了多少」。 */
function DockCost(props: { kit: ViewKit; peak: number; off: number; periodSum: number; currency: CostCurrency }): ReactElement | null {
  const { t } = props.kit
  if (props.periodSum <= 0) return null
  const rows = PERIOD_BANDS.map(band => ({
    key: band.key,
    label: t(band.labelKey),
    value: band.key === 'peak' ? props.peak : props.off,
    tint: band.key,
  }))
  return (
    <div className="lc-dock-card-block">
      <div className="lc-dock-block-title">
        {t('dock.cost')}
        <b>{formatCost(props.periodSum, props.currency)}</b>
      </div>
      {rows.map(r => (
        <div key={r.key} className="lc-dock-block-row" data-zero={r.value <= 0 ? '1' : undefined}>
          <span>{r.label}</span>
          <span className={'lc-dock-block-track lc-dock-tint-' + r.tint}><i className={'lc-dock-bar-fill' + BAR_RISE} style={{ width: fmtShare(r.value, props.periodSum) }} /></span>
          <b>{formatCost(r.value, props.currency)}</b>
          <em>{fmtShare(r.value, props.periodSum)}</em>
        </div>
      ))}
    </div>
  )
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
