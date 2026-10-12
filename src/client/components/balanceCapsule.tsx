/** Insights 页面标题里的 DeepSeek 开放平台余额药丸。它先画出上一次打开记住的数字，
 * 同时 client/balance.ts 在后台重新校验；什么都没记住且路由也没有回应时，它什么都不渲染。
 * 明细走页面 portal 出去的悬停提示，由药丸的 `data-lc-tip` 驱动（即时响应，
 * 而原生 `title` 会滞后），货币沿用该条目自己的币种；药丸上只承载总额。 */

import { useState, type ReactElement } from 'react'
import { balanceEntryOf, readPlatformBalance } from '../balance'
import type { PlatformBalance } from '../../shared/types'
import type { ClientCtx } from '../services'
import { symbolOf } from '../cost'
import type { ViewKit } from '../viewkit'

/** 平台所支持币种的符号前缀；其余币种直接显示代码。 */
/** 药丸点击后打开的平台控制台页面。 */
const USAGE_URL = 'https://platform.deepseek.com/usage'

/**
 * Insights 标题里的余额药丸，闭包捕获 `ctx` 以取得由语言推导出的展示
 * 货币。记住的数字必须在首次渲染时同步画出——
 * 用占位符的话每次挂载都会闪一下——所以 state 的初始化函数同时也是
 * 在后台重新校验的那个订阅。
 */
export function makeBalanceCapsule(ctx: ClientCtx, kit: ViewKit): () => ReactElement | null {
  const { t } = kit
  return function BalanceCapsule(): ReactElement | null {
    // 初始化函数的 setter 同时充当 `readPlatformBalance` 在稍后
    // 重新校验时触发的回调：一次读取既画出缓存里的数字，又装上监听器，
    // 因此药丸绝不会渲染出中间那个空帧。
    const [balance, setBalance] = useState<PlatformBalance | null>(() => readPlatformBalance((v) =>{  setBalance(v) }))
    const locale = ctx.locale
    const active = typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
    const entry = balanceEntryOf(balance, active === 'zh' ? 'cny' : 'usd')
    // 什么都没记住、也还没取到：空药丸会被读成余额为零。
    if (entry === null) return null
    const money = (amount: number): string => symbolOf(entry.currency) + amount.toFixed(2)
    // 提示只列出明细里非零的部分，所以全零账户的药丸干干净净。
    const tipLines = [
      ...(entry.toppedUp > 0 ? [t('balance.tip.toppedUp') + ': ' + money(entry.toppedUp)] : []),
      ...(entry.granted > 0 ? [t('balance.tip.granted') + ': ' + money(entry.granted)] : []),
    ]
    return (
      <a
        className="lc-ov-balance"
        aria-label={tipLines.length > 0 ? tipLines.join('\n') : undefined}
        {...(tipLines.length > 0 ? { 'data-lc-tip': tipLines.join('\n'), 'data-lc-tip-side': 'bottom' } : {})}
        href={USAGE_URL}
        target="_blank"
        rel="noreferrer"
      >
        <span className="lc-ov-balance-label">{t('balance.title')}</span>
        <span className="lc-ov-balance-value">{money(entry.total)}</span>
      </a>
    )
  }
}
