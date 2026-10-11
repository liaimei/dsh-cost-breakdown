/** fetch-on-miss 状态机：每个错过的 key 只做一次定向历史读取；`absent`/`failed` 是终态，
 * 而落地的值按 key 缓存（历史不可变，因此绝不会重复请求）。 */

import { useEffect, useState, type ReactNode } from 'react'
import type { Translate } from '../i18n'

/** fetch-on-miss 读取的四个状态；`absent` 与 `failed` 在用户重试前都是终态，
 *  落地的值则把该 key 搬进 `values`。 */
export type FetchMissState = 'idle' | 'loading' | 'absent' | 'failed'

/** 调用方据此渲染：按 key 存放的已落地值、当前状态，以及一个
 *  为同一 key 重新武装 effect 的 retry。 */
export interface FetchOnMiss<T> {
  values: Map<number, T>
  state: FetchMissState
  retry: () => void
}

/**
 * fetch-on-miss hook。历史不可变，所以落地的值会被永久缓存，
 * effect 绝不会为那个 key 再取一次；`attempt` 是重试计数器，
 * 用来重新武装已进入终态的 `absent`/`failed`。`live` 标记则丢弃在卸载之后、
 * 或 key 已变之后才到达的结果。
 */
export function useFetchOnMiss<T>(
  key: number | null,
  fetcher: ((key: number) => Promise<T | null>) | undefined,
  warn: string,
): FetchOnMiss<T> {
  const [values, setValues] = useState<Map<number, T>>(() => new Map())
  const [state, setState] = useState<FetchMissState>('idle')
  const [attempt, setAttempt] = useState(0)
  // `key === null` 与缺少 fetcher 都表示这台状态机无事可做；这两种情况由调用方
  // 渲染自己的空提示，所以这里不做任何状态迁移。
  useEffect(() => {
    if (key === null || fetcher === undefined || values.has(key)) return
    let live = true
    setState('loading')
    fetcher(key).then((value) => {
      if (!live) return
      if (value === null) {
        setState('absent')
        return
      }
      setValues((prev) => {
        const next = new Map(prev)
        next.set(key, value)
        return next
      })
      setState('idle')
    }, (error: unknown) => {
      console.warn(warn, error)
      if (live) setState('failed')
    })
    return () => { live = false }
  }, [key, fetcher, attempt, values])
  return { values, state, retry: () => { setAttempt(a => a + 1) } }
}

/**
 * 明细集合错过时的提示。`fetcher === undefined` 表示宿主根本没有 history face，
 * 这与「日志里没有这个 key」是两件事——
 * 所以那一分支要用调用方传入的 `emptyKey`。`loading` 也覆盖第一帧，
 * 即 effect 还没跑的时候。
 */
export function fetchMissNote(
  t: Translate,
  fetcher: unknown,
  state: FetchMissState,
  onRetry: () => void,
  emptyKey: 'browser.noContent' | 'browser.headerMetaOnly',
): ReactNode {
  if (fetcher === undefined) return t(emptyKey)
  if (state === 'absent') return t('browser.notInLog')
  if (state === 'failed') {
    return (
      <button type="button" className="lc-br-retry hover:brightness-[1.15]" onClick={onRetry}>
        {t('browser.loadFailed')}
      </button>
    )
  }
  return t('browser.loading')
}
