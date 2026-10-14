/** 平台卡上「剩余额度」那一行的文案。
 *
 *  两个页面（会话页与概览页）都要给平台卡准备这份数据，因此放在这里共用：
 *  否则两处各写一遍，迟早对同一个余额给出不同答案。
 *
 *  金额平台用余额接口的数字并**按账户自己的币种**取符号——绝不跟着界面语言走：
 *  一个以人民币记账的账户换成美元显示，读起来就不是它的账单。积分平台取**自己那一版**
 *  的积分池（CN 与国际版是两套账户，不能互相顶替），无限额的不显示这一行。
 *
 *  金额自带币种符号，而积分没有符号，因此积分那一支必须自己带上单位：
 *  一个光秃秃的「5550」在「剩余」标签旁边读起来像钱，而它是积分。
 */

import { balanceEntryOf } from './balance'
import type { PlatformBalance } from '../shared/types'
import type { PlatformCreditsTable } from './platformCredits'
import type { PlatformSpend } from './platformSpend'
import type { Translate } from './i18n'
import { isDeepSeekProvider } from '../shared/providers'
import { symbolOf } from './cost'
import { fmtCredits } from './turnSpend'

/** 该平台的账户余额条目：只有官方 DeepSeek 有余额来源，而它按人民币记账
 *  （`spendCurrencyOf` 与 `isDeepSeekProvider` 是同一个判定），因此先取 CNY 那一条，
 *  账户只持有别的币种时才退回第一条。第三方金额平台没有余额来源，整行不出现。 */
function balanceFor(row: PlatformSpend, balance: PlatformBalance | null): { text: string } | undefined {
  if (!isDeepSeekProvider(row.provider)) return undefined
  const entry = balanceEntryOf(balance, 'cny')
  return entry === null ? undefined : { text: symbolOf(entry.currency) + entry.total.toFixed(2) }
}

export function platformBalanceTexts(
  rows: readonly PlatformSpend[],
  balance: PlatformBalance | null,
  credits: PlatformCreditsTable | null,
  t: Translate,
): Record<string, { text: string } | undefined> {
  const out: Record<string, { text: string } | undefined> = {}
  for (const row of rows) {
    if (row.unit === 'credits') {
      // 按 provider 取该版本自己的余额：两版是两套积分池，不能互相顶替。
      const own = credits?.[row.provider]
      // 单位跟着数字走：积分没有币种符号，光一个数字会被当成钱。
      out[row.provider] = own === undefined || own.unlimited
        ? undefined
        : { text: t('costStat.credits', { n: fmtCredits(own.total) }) }
      continue
    }
    // 余额只归自己那一张卡：把某家的余额放在别家名下是错的。
    out[row.provider] = balanceFor(row, balance)
  }
  return out
}
