/** 用户声明的费率表的运行时存放处。
 *
 *  两张表语义不同、互不覆盖：
 *  - `money`：`<provider>:<model>` → 每 **100 万 token** 的美元费率（`thirdPartyRates`）；
 *  - `credits`：`<provider>:<model>` → **每次请求**的积分数。
 *
 *  这里刻意只是一个可被替换的运行时槽位，而不是设置项：设置在会话中途可改，
 *  组件每帧都从这里读，因此改完立刻生效。设置界面接进来时只需调用
 *  `setRateTables`，组件与解析逻辑都不用动。
 */

import { thirdPartyRatesOf, type ThirdPartyRates } from '../shared/thirdPartyRates'
import { creditRatesOf, type CreditRates } from './turnSpend'

let money: ThirdPartyRates | null = null
let credits: CreditRates | null = null

/** 设置或清空两张表；`null`/缺省表示「没有声明」，解析时按不可定价处理。 */
export function setRateTables(next: { money?: unknown; credits?: unknown } | null): void {
  money = next === null ? null : thirdPartyRatesOf(next.money)
  credits = next === null ? null : creditRatesOf(next.credits)
}

export function moneyRates(): ThirdPartyRates | null {
  return money
}

export function creditRates(): CreditRates | null {
  return credits
}

/** 测试用：回到未声明状态。 */
export function resetRateTables(): void {
  setRateTables(null)
}
