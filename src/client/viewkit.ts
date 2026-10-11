import type { ContextEventRecord } from '../shared/types'
import { fmt, fmtDuration, fmtShare, fmtTime } from './format'
import { makeEventText } from './components/events'
import type { Translate } from './i18n'

/** 打包进 kit 而不是各组件分别 import，这样组件不必横向去够
 *  `i18n`/`format`，每张卡片的格式也因此完全一致。`eventLabel`/`eventAt`
 *  每个 kit 用同一个 `t` 只构建一次（components/events.tsx），
 *  timeline、浏览器与摘要之间的事件措辞和时间戳因此保持一致。 */
export interface ViewKit {
  t: Translate
  fmt: typeof fmt
  fmtTime: typeof fmtTime
  fmtDuration: typeof fmtDuration
  fmtShare: typeof fmtShare
  catLabel: (key: string) => string
  eventLabel: (ev: ContextEventRecord) => string
  eventAt: (ev: ContextEventRecord) => string | null
}

/** `t` 必须是绑定了命名空间的翻译函数（index.ts 里的 `ctx.locale.bind(NS)`，
 *  或 `locale` 座位自带的那个）——`catLabel` 里的键是拼接的
 *  （`'cat.' + key`），会逃过任何静态键检查。kit 构建开销很小，但这里不做记忆化：
 *  调用方每次组件挂载只构建**一个**（见 index.ts 里的 `make*`），
 *  因为每次渲染都重建会让卡片每次都拿到新的 `kit` 标识。 */
export function makeViewKit(t: Translate): ViewKit {
  const { eventLabel, eventAt } = makeEventText(t)
  return {
    t,
    fmt,
    fmtTime,
    fmtDuration,
    fmtShare,
    catLabel: (key: string) => t('cat.' + key),
    eventLabel,
    eventAt,
  }
}
