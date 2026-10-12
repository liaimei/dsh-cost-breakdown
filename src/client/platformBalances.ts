/** 平台卡上「剩余额度」那一行的文案。
 *
 *  两个页面（会话页与概览页）都要给平台卡准备这份数据，因此放在这里共用：
 *  否则两处各写一遍，迟早对同一个余额给出不同答案。
 *
 *  金额平台用余额接口的数字并按显示货币取符号；积分平台取**自己那一版**的积分池
 *  （CN 与国际版是两套账户，不能互相顶替），无限额的不显示这一行。
 */

import { balanceEntryOf } from './balance'
import type { PlatformBalance } from '../shared/types'
import type { PlatformCreditsTable } from './platformCredits'
import type { PlatformSpend } from './platformSpend'
import { isDeepSeekProvider } from '../shared/providers'
import { symbolOf, type CostCurrency } from './cost'
import { fmtCredits } from './turnSpend'

export function platformBalanceTexts(
  rows: readonly PlatformSpend[],
  balance: PlatformBalance | null,
  credits: PlatformCreditsTable | null,
  currency: CostCurrency,
): Record<string, { text: string } | undefined> {
  const deepseek = balanceEntryOf(balance, currency)
  const out: Record<string, { text: string } | undefined> = {}
  for (const row of rows) {
    if (row.unit === 'credits') {
      // 按 provider 取该版本自己的余额：两版是两套积分池，不能互相顶替。
      const own = credits?.[row.provider]
      out[row.provider] = own === undefined || own.unlimited ? undefined : { text: fmtCredits(own.total) }
      continue
    }
    // 余额只归自己那一张卡：把某家的余额放在别家名下是错的。
    out[row.provider] = isDeepSeekProvider(row.provider) && deepseek !== null
      ? { text: symbolOf(deepseek.currency) + deepseek.total.toFixed(2) }
      : undefined
  }
  return out
}
