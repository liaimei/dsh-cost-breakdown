/** 按平台拆分消费的卡片组：**每个平台一张卡**。
 *
 *  为什么必须分开：各平台的账单单位不同——DeepSeek 按人民币 token 计价（含峰谷），
 *  积分制平台按次扣积分。放进一张卡就得给一个总额，而把两种货币相加得到的数字没有
 *  意义。各占一张卡则每张只说自己那一种单位，读者也不会误以为它们可以相加。
 *
 *  卡片内容：平台名、该平台的消费、调用次数、出现的模型，以及（若读得到）剩余额度。
 *  余额**只归自己**那一张卡——把某家的余额放在别家名下是错的。
 */

import { type ReactElement } from 'react'
import type { PlatformSpend } from '../platformSpend'
import { formatCost, toCurrency, type CostCurrency } from '../cost'
import { fmtCredits } from '../turnSpend'
import type { ViewKit } from '../viewkit'

/** 一个平台的剩余额度。金额平台用币种符号，积分平台用积分数。 */
export interface PlatformBalanceText {
  text: string
}

export interface StatsPlatformsProps {
  rows: readonly PlatformSpend[]
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

/** 绑定 `kit`，返回这一组平台卡。 */
export function makeStatsPlatforms(kit: ViewKit): (props: StatsPlatformsProps) => ReactElement | null {
  const { t } = kit
  return function StatsPlatforms(props: StatsPlatformsProps): ReactElement | null {
    if (props.rows.length === 0) return null
    const money = (usd: number): string => formatCost(toCurrency(usd, props.currency), props.currency)
    return (
      <>
        {props.rows.map(row => {
          const balance = props.balances?.[row.provider]
          return (
            <div key={row.provider} className="lc-card lc-col-monet lc-pf-card" data-unit={row.unit}>
              <div className="lc-card-title">
                <span className="lc-card-title-text">{platformDisplayName(row.provider, t)}</span>
                {/* 角标给出单位，读者一眼知道这个数字是钱还是积分。
                    积分数值本身不带单位词，所以这里补上；金额自带货币符号，无需重复。 */}
                {row.unit === 'credits'
                  ? <span className="lc-card-sub">{t('costStat.unit.credits')}</span>
                  : null}
              </div>
              <div className="lc-pf-body">
                {/* 金额自带货币符号，积分则补上「积分」二字——同一个数字在不同单位下
                    含义完全不同，标签不能省。 */}
                <span className="lc-pf-value">
                  {row.unit === 'credits' ? fmtCredits(row.value) : money(row.value)}
                </span>
              </div>
              <div className="lc-pf-meta">
                {/* 调用次数：积分平台就是「几次 × 倍率」里的那个「几次」。 */}
                <span className="lc-pf-calls">{t('costStat.calls', { n: row.calls })}</span>
                {balance !== undefined
                  ? <span className="lc-pf-balance" title={t('costStat.balanceTip')}>{balance.text}</span>
                  : null}
              </div>
              {/* 用到的模型：短列表直接列出，长列表截断并把全名放进 title，
                  卡片高度因此不会被某个用得多的平台撑破。 */}
              {row.models.length > 0
                ? (
                  <div className="lc-pf-models" title={row.models.join(' · ')}>
                    {row.models.slice(0, 3).map(m => <span key={m} className="lc-pf-model">{m}</span>)}
                    {row.models.length > 3
                      ? <span className="lc-pf-model lc-pf-model-more">+{row.models.length - 3}</span>
                      : null}
                  </div>
                )
                : null}
            </div>
          )
        })}
      </>
    )
  }
}
