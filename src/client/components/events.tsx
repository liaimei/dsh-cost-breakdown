/** 图标：inject/model 切换复用 harness 的共享图标集（`@deepseek-ai/dsh-client-ui-primitives`，一种平台种子词）；
 * compaction/prune 保留 ✂ 记号——共享图标集里没有对应的图形。 */

import { useEffect, useLayoutEffect, useRef, type ReactElement } from 'react'
import type { ContextEventRecord } from '../../shared/types'
import { IconBranch, IconPlus } from '../primitives'
import type { Translate } from '../i18n'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeDetailNote } from './detailNote'

/** 每种事件对应的图标；`inject`/`model` 来自共享图标集，
 *  compaction/prune 保留 ✂，其余种类落到圆点兜底。 */
const EVENT_ICONS: Record<string, string> = { compaction: '✂', prune: '✂', mode: '⇄' }

/** 事件列表的输入；`state`/`onRetry` 让一份还没取到的列表如实说明这一点，
 *  而不是声称本会话没有事件。 */
export interface EventListProps {
  events: ContextEventRecord[]
  /** timeline source 的明细状态（拆分代际）：没有事件可列时，
   * `loading`/`failed` 用等待提示 / 重试按钮替掉「没有事件」的说法
   * ——还没取到并不等于空。 */
  state?: DetailState
  onRetry?: () => void
}

/** 基于同一个翻译器造出两个取文案函数。`eventLabel` 最后落到 inject 那一支：
 *  到那一步种类联合类型已经收窄为 `inject`，所以将来新增一种事件会在
 *  这里变成编译错误，而不是悄悄标错一行。 */
export function makeEventText(t: Translate): {
  eventLabel: (ev: ContextEventRecord) => string
  eventAt: (ev: ContextEventRecord) => string | null
} {
  function eventLabel(ev: ContextEventRecord): string {
    if (ev.kind === 'compaction') return t('ev.compaction', { n: ev.count || 0 })
    if (ev.kind === 'prune') return t('ev.prune')
    if (ev.kind === 'model') return t('ev.model', { a: ev.from || '?', b: ev.to || '?' })
    if (ev.kind === 'mode') return t('ev.mode.' + (ev.name || '?'))
    // 种类联合类型在这里收窄为 'inject'；将来新增的种类会打断
    // 编译（ev.sub、ev.form、ev.name 都是 inject 独有的），逼着补一个标签。
    if (ev.sub === 'skill') return t('ev.skill', { name: ev.name || '?' })
    const base = t('form.' + (ev.form || 'context'))
    let label = ev.name ? base + ' · ' + ev.name : base
    if (ev.detail) label += ' · ' + ev.detail
    return label
  }

  /** 该事件在时间线上的位置：边界事件（compaction/prune）标的是它们所处的空隙——同轮次的 'Turn 2 · Step 3→4'，
   * 跨轮次的 'Turn 50 · Step 8 → Turn 51 · Step 1'；其余种类保持单点；没有轮次/步骤（尚在途中）→ null。 */
  function eventAt(ev: ContextEventRecord): string | null {
    if (ev.kind === 'compaction' || ev.kind === 'prune') {
      if (typeof ev.turn === 'number' && typeof ev.step === 'number') {
        if (typeof ev.fromTurn === 'number' && typeof ev.fromStep === 'number') {
          if (ev.fromTurn === ev.turn) return t('events.range', { t: ev.turn, a: ev.fromStep, b: ev.step })
          return t('events.rangeTo', { a: ev.fromTurn, as: ev.fromStep, b: ev.turn, bs: ev.step })
        }
        return t('events.at', { t: ev.turn, s: ev.step })
      }
      return null
    }
    if (typeof ev.turn === 'number' && typeof ev.step === 'number') {
      return t('events.at', { t: ev.turn, s: ev.step })
    }
    return null
  }

  return { eventLabel, eventAt }
}

/** 给每个文本溢出自身容器的标签设上原生 `title`（样式化提示只覆盖卡片，一行朴素的
 * 省略号仍然需要原生兜底）；读（scrollWidth/clientWidth）与写（title）都与影响布局的工作分开，
 * 并由调用方决定何时运行，使它永远不会变成每次渲染都强制一次布局。 */
function syncTitles(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>('.lc-event-label')) {
    el.title = el.scrollWidth > el.clientWidth ? el.textContent || '' : ''
  }
}

/** 绑定 `kit`（它已经带着共享的 `eventLabel`/`eventAt`）并返回列表；
 *  最新的事件排在最前，所以这份列表自下而上读，像它所注释的对话一样。 */
export function makeEventList(kit: ViewKit): (props: EventListProps) => ReactElement {
  const { t, fmt, fmtTime, eventLabel, eventAt } = kit
  const DetailNote = makeDetailNote(kit)
  return function EventList(props: EventListProps): ReactElement {
    // hook 必须无条件调用（hooks 规则）：同一个已挂载实例里事件从空变为
    // 非空，不能让 hook 数量增加——在这些 hook 上方提前 return 是一类 React #310 的 bug
    // （issue #12）。
    const rootRef = useRef<HTMLDivElement | null>(null)
    // 截断标题靠一个只监听 resize 的监听器加上事件驱动的重新同步：这个 effect 绝不能
    // 每次渲染都跑——一次普通的重新渲染（视图别处的悬停/选中）会让每个标签重读 scrollWidth /
    // clientWidth，逐行强制一次同步布局，还会重新绑定监听器。
    useLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      syncTitles(root)
    }, [props.events])
    useEffect(() => {
      const onResize = (): void => {
        const root = rootRef.current
        if (root !== null) syncTitles(root)
      }
      window.addEventListener('resize', onResize)
      return () => { window.removeEventListener('resize', onResize) }
    }, [])
    if (props.events.length === 0) {
      // 顺序有讲究：等待中或失败的读取有自己的提示，只有取到了并且确实为空
      // 的列表才允许说「没有事件」。
      if (props.state === 'loading') return <DetailNote state="loading" />
      if (props.state === 'failed' && props.onRetry !== undefined) {
        return <DetailNote state="failed" onRetry={props.onRetry} />
      }
      return <div className="lc-empty">{t('events.empty')}</div>
    }
    // `slice().reverse()` 先复制：`props.events` 是调用方的数组（往往是
    // provider 自己的顺序），就地反转会改动被推送出去的值。
    const sorted = props.events.slice().reverse()
    return (
      <div className="lc-events" ref={rootRef}>
        {sorted.map((ev) => {
          const label = eventLabel(ev)
          const at = eventAt(ev)
          const glyph = ev.kind === 'inject' ? <IconPlus />
            : ev.kind === 'model' ? <IconBranch />
              : EVENT_ICONS[ev.kind] || '•'
          // 只以持久的 seq 作 key：列表最新在前，所以新事件落在下标 0，
          // 而带下标的 key 会让每一行的 key 都位移——每次推送都整表重新挂载。
          // 窄卡片（手机分栏）：单行会把标签挤扁、把后面的元信息尾巴推进滚动条，
          // 所以该行允许换行——标签用接近整宽的基准把第 1 行留给
          // 图标 + 种类 + 标签，元信息尾巴折到第 2 行。那 92px 的基准预留量
          // 覆盖图标 + 间隙 + 最宽的种类徽标（两种语言）+ 间隙。
          return (
            <div key={ev.seq} className="lc-event @max-[380px]/lc-card:flex-wrap">
              <span className={'lc-event-icon lc-event-' + ev.kind}>{glyph}</span>
              <span className={'lc-kind lc-kind-' + ev.kind}>{t('kind.' + ev.kind)}</span>
              <span className="lc-event-label flex-1 @max-[380px]/lc-card:basis-[calc(100%-92px)]">{label}</span>
              {at !== null ? <span className="lc-event-at">{at}</span> : null}
              {ev.tokens ? (
                <span className={'lc-event-tokens' + (ev.kind === 'inject' ? ' lc-up' : ' lc-down')}>
                  {(ev.kind === 'inject' ? '+' : '−') + fmt(ev.tokens)}
                </span>
              ) : null}
              <span className="lc-event-time">{fmtTime(ev.time)}</span>
            </div>
          )
        })}
      </div>
    )
  }
}
