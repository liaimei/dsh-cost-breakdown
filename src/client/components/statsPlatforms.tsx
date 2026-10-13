/** 按平台拆分消费的卡片组：**每个平台一张卡**。
 *
 *  为什么必须分开：各平台的账单单位不同——DeepSeek 按人民币 token 计价（含峰谷），
 *  积分制平台按次扣积分。放进一张卡就得给一个总额，而把两种货币相加得到的数字没有
 *  意义。各占一张卡则每张只说自己那一种单位，读者也不会误以为它们可以相加。
 *
 *  每张卡自上而下：平台名与消费、环图（按模型分份额）、**逐模型的消费与调用次数**、
 *  平台的调用合计与剩余额度。逐模型的明细就长在卡内——另起一张表只会把这些
 *  数字再抄一遍。
 */

import { useState, type ReactElement } from 'react'
import { modelSpendRowsOf, type PlatformSpend } from '../platformSpend'
import { formatNativeSpend, type CostCurrency } from '../cost'
import { fmtCredits } from '../turnSpend'
import { SliceList, type SliceRow } from './sliceList'
import type { DonutProps } from './donut'
import type { ViewKit } from '../viewkit'

/** 一个平台的剩余额度。金额平台用币种符号，积分平台用积分数。 */
export interface PlatformBalanceText {
  text: string
}

export interface StatsPlatformsProps {
  rows: readonly PlatformSpend[]
  /** 布局用的展示货币（语言相关）；金额**不**用它渲染，见 `spendText`。 */
  currency: CostCurrency
  /** 平台名 → 剩余额度文案；没有就整行不出现。 */
  balances?: Readonly<Record<string, PlatformBalanceText | undefined>>
}

/** 平台在这一行里显示的名字。DeepSeek 的官方路由显示为人熟知的「DeepSeek」，
 *  其余原样——平台名是事实标识，不该被翻译或美化。 */
export function platformDisplayName(provider: string, t: ViewKit['t']): string {
  return provider === 'deepseek-account' || provider === 'deepseek-official'
    ? t('dock.platform.deepseek')
    : provider
}

/** 一笔平台消费的读数：积分平台给积分，金额平台给**它自己账单的币种**。
 *  按平台原币显示而不是统一换算，是因为换算后相加会把两份账单混成一个数字。 */
export function platformSpendText(row: PlatformSpend, t: ViewKit['t']): string {
  return row.unit === 'credits'
    ? fmtCredits(row.value) + ' ' + t('costStat.unit.credits')
    : formatNativeSpend(row.value, row.currency ?? 'USD')
}

/** 环图分段的调色板：沿用全局分桶的那几色，因此同一张卡里的颜色含义与别处一致。 */
const SEGMENT_COLORS = [
  'var(--color-green-500)',
  'var(--color-amber-500)',
  'var(--color-purple-500)',
  'var(--color-pink-500)',
  'var(--color-blue-500)',
  'var(--color-teal-500)',
]

/** 绑定 `kit` 与共享的 `Donut`，返回这一组平台卡。
 *
 *  骨架刻意与「费用统计」卡一字不差：标题 + 右角总额、环图 + 图例、明细行、页脚。
 *  两张卡回答的是同一类问题（这个平台花了多少、由什么构成），排版一致读者才不用
 *  为每张卡重新找数字在哪。
 *
 *  `Donut` 由调用方传入而不是在这里 import：各页面必须复用同一个实例，
 *  自己 import 会拿到第二份实现，悬停联动之类的行为就会分叉。 */
export function makeStatsPlatforms(
  kit: ViewKit,
  Donut: (props: DonutProps) => ReactElement,
): (props: StatsPlatformsProps) => ReactElement | null {
  const { t, fmt, fmtShare } = kit
  return function StatsPlatforms(props: StatsPlatformsProps): ReactElement | null {
    // 每张卡各自的悬停联动：一张卡的图例不该点亮另一张卡的分段。
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    if (props.rows.length === 0) return null
    // 金额一律按**平台自己的账单币种**渲染，与界面语言无关。
    const money = (usd: number, row: PlatformSpend): string => formatNativeSpend(usd, row.currency ?? 'USD')
    return (
      <>
        {props.rows.map(row => {
          const balance = props.balances?.[row.provider]
          const isCredit = row.unit === 'credits'
          const valueText = isCredit ? fmtCredits(row.value) : money(row.value, row)
          // 分段按**该平台各模型的消费**分配，与右角总额同源，因此各段之和恒等于它。
          // 只列出真的花了钱/积分的模型——零值分段进环图只会画出一条零弧。
          const segments = row.models
            .map((model, i) => ({
              key: model,
              color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
              value: row.byModel?.[model] ?? 0,
              calls: row.callsByModel?.[model] ?? 0,
            }))
            .filter(s => s.value > 0)
          const segTotal = segments.reduce((n, s) => n + s.value, 0)
          const rowsForLegend: SliceRow[] = segments.map(s => ({
            key: s.key,
            color: s.color,
            label: s.key,
            pct: fmtShare(s.value, segTotal),
            count: isCredit ? fmtCredits(s.value) : money(s.value, row),
          }))
          // 逐模型明细就长在这张卡里：模型的消费与调用次数。定不出价的模型显式标注，
          // 绝不显示 0——「拿不到费率」与「这些调用免费」是两回事。
          const modelLines = modelSpendRowsOf(row)
          return (
            <div key={row.provider} className="lc-card lc-col-donut lc-pf-card" data-unit={row.unit}>
              <div className="lc-card-title">
                <span className="lc-card-title-text">{platformDisplayName(row.provider, t)}</span>
                {/* 与费用卡一致：右角放这张卡最该先被读到的数字。
                    单位必须写出来——同一个数字在积分与人民币下含义完全不同。 */}
                <span className="lc-card-rate" title={t('costStat.balanceTip')}>
                  {valueText}
                  {isCredit ? ' ' + t('costStat.unit.credits') : ''}
                </span>
              </div>
              {segments.length > 0
                ? (
                  <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
                    <Donut
                      segments={segments.map(s => ({ key: s.key, color: s.color, value: s.value }))}
                      size={96}
                      centerTop={valueText}
                      centerSub={t('costStat.total')}
                      hoverKey={hoverKey}
                      onHoverKey={setHoverKey}
                    />
                    <SliceList rows={rowsForLegend} hoverKey={hoverKey} onHoverKey={setHoverKey} />
                  </div>
                )
                : null}
              {/* 逐模型明细：模型 / 消费 / 调用次数。它就是这张卡的「由什么构成」，
                  因此不再另起一张表把同样的数字再抄一遍。 */}
              <table className="lc-pf-models">
                <tbody>
                  {modelLines.map(line => (
                    <tr key={line.model} className={line.value === null ? 'lc-pf-model-unpriced' : undefined}>
                      <td className="lc-pf-model-name" title={line.model}>{line.model}</td>
                      <td className="lc-pf-model-spend">
                        {line.value === null
                          ? t('spendDetail.unpriced')
                          : isCredit ? fmtCredits(line.value) : money(line.value, row)}
                      </td>
                      <td className="lc-pf-model-calls">{fmt(line.calls)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {/* 平台自己的调用合计与剩余额度。 */}
              <div className="lc-sc-periods">
                <span className="lc-sc-period">
                  <span className="lc-sc-period-label">{t('costStat.callsLabel')}</span>
                  <b>{fmt(row.calls)}</b>
                </span>
                {balance !== undefined
                  ? (
                    <span className="lc-sc-period" title={t('costStat.balanceTip')}>
                      <span className="lc-sc-period-label">{t('costStat.balanceLabel')}</span>
                      <b>{balance.text}</b>
                    </span>
                  )
                  : null}
              </div>
            </div>
          )
        })}
      </>
    )
  }
}
