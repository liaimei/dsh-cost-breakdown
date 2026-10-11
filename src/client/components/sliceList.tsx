/** 统计卡片的条状图例行——即环图的图例：悬停某一行会同时点亮该行与它的环图分段，反之亦然。
 * 输入是已格式化的字符串，输出是不带逻辑的标记。 */

import { type ReactElement } from 'react'

/** 一条图例行；每个字符串都是预格式化传入的，因为卡片的主人对货币、
 *  ≈ 标记与 '-' 占位符各有自己的约定。 */
export interface SliceRow {
  key: string
  color: string
  label: string
  /** 预格式化的首位占比（'84%'、'<1%'、'—'）。 */
  pct: string
  /** 预格式化的次行；为空则不渲染这一行。 */
  count: string
  /** 数值为零的分段整体变暗——环图本身已经携带了它的占比。 */
  dim?: boolean
}

/** `rows` 与悬停 key 都由卡片控制，这样一个环图分段与它的行才能一起点亮；
 *  不传 `onHoverKey` 则整列不响应。 */
export interface SliceListProps {
  rows: SliceRow[]
  hoverKey?: string | null
  /** 不传则各行都不响应。 */
  onHoverKey?: (key: string | null) => void
}

/** 环图的图例。清空共享 key 的是容器上的 `mouseleave`（不是逐行的），
 *  这样从某一行移到行间空隙时，环图不会被熄灭。 */
export function SliceList(props: SliceListProps): ReactElement {
  return (
    <div className="lc-sl flex-auto @max-[240px]/lc-card:basis-full" onMouseLeave={() => { if (props.onHoverKey !== undefined) props.onHoverKey(null) }}>
      {props.rows.map(r => (
        <div
          key={r.key}
          className={'lc-sl-row'
            + (r.dim ? ' lc-sl-row-dim' : '')
            + (props.hoverKey !== undefined && props.hoverKey === r.key ? ' lc-sl-row-on' : '')}
          onMouseEnter={() => { if (props.onHoverKey !== undefined) props.onHoverKey(r.key) }}
        >
          <div className="lc-sl-main">
            <i className="lc-sl-dot" style={{ background: r.color }} />
            <span className="lc-sl-label" title={r.label}>{r.label}</span>
            <span className="lc-sl-pct">{r.pct}</span>
          </div>
          {r.count !== '' ? <div className="lc-sl-sub" title={r.count}>{r.count}</div> : null}
        </div>
      ))}
    </div>
  )
}
