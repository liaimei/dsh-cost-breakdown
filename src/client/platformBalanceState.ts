/** 平台余额的 React 座位：把 DeepSeek 账户余额与各积分平台的剩余积分读成组件状态。
 *
 *  汇总统计页、会话内的消费口径与输入框下方那条读数都必须看到**同一份**余额，
 *  因此轮询只有这一处实现——三个界面各写一遍，它们迟早会对同一个余额给出不同答案。
 */

import { useEffect, useState } from 'react'
import { BALANCE_POLL_MS } from './constants'
import { readPlatformBalance } from './balance'
import { readPlatformCredits, type PlatformCreditsTable } from './platformCredits'
import type { PlatformBalance } from '../shared/types'

export interface PlatformBalanceState {
  balance: PlatformBalance | null
  credits: PlatformCreditsTable | null
}

/** 订阅余额：首帧画出上次记住的数字，随后按 {@link BALANCE_POLL_MS} 周期校正。
 *  两个提供方都读不到值时保持 `null`，界面据此整行不渲染，绝不用一个零蒙混。 */
export function usePlatformBalances(): PlatformBalanceState {
  const [balance, setBalance] = useState<PlatformBalance | null>(() => readPlatformBalance((v) => { setBalance(v) }))
  const [credits, setCredits] = useState<PlatformCreditsTable | null>(() => readPlatformCredits((v) => { setCredits(v) }))
  useEffect(() => {
    const timer = setInterval(() => {
      setBalance(readPlatformBalance(setBalance))
      setCredits(readPlatformCredits(setCredits))
    }, BALANCE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [])
  return { balance, credits }
}
