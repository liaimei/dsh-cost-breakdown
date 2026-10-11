/** 明细集合的等待/失败提示：读取已结束却没有数据时，绝不能渲染成空状态。 */

import { type ReactElement } from 'react'
import type { ViewKit } from '../viewkit'

/**
 * 明细集合的等待/失败提示，绑定 `kit` 取它要用的文案。读取已结束却没有数据时，
 * 必须走这里而不是走空状态：否则一次失败的请求会和「这个区间确实没有数据」
 * 渲染得完全一样，读的人无从分辨。重试按钮只在调用方传入 `onRetry` 时才出现，
 * 不传就只剩失败文案。
 */
export function makeDetailNote(kit: ViewKit): (props: {
  state: 'loading' | 'failed'
  onRetry?: () => void
  className?: string
}) => ReactElement {
  const { t } = kit
  return function DetailNote(props: {
    state: 'loading' | 'failed'
    onRetry?: () => void
    className?: string
  }): ReactElement {
    const cls = props.className ?? 'lc-empty'
    if (props.state === 'loading') return <div className={cls}>{t('detail.loading')}</div>
    return (
      <div className={cls}>
        {props.onRetry !== undefined
          ? <button type="button" className="lc-br-retry hover:brightness-[1.15]" onClick={props.onRetry}>{t('detail.loadFailed')}</button>
          : t('detail.loadFailed')}
      </div>
    )
  }
}
