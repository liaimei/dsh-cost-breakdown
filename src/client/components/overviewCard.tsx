import type { ReactElement } from 'react'
import { billedOf, createdDayOf, projectOf, relativeTime, turnsOf, type OverviewRow } from '../overview'
import { partsOf } from '../categories'
import { fmt, fmtShare } from '../format'
import type { ViewKit } from '../viewkit'
import { Donut } from './donut'

/** 单张会话卡片的输入：该行确实处在某个父工作区下时，`group` 是那个名字；
 *  `costLabel` 则已预格式化传入，因为货币由调用方决定。 */
export interface OverviewCardProps {
  row: OverviewRow
  group?: string
  costLabel: string
  now: number
  onOpen(id: string): void
}

/** 绑定 `kit`，返回会话列表卡片。卡片上的金额取的是 TEAM 口径（整棵子树），
 *  而环图与轮次仍算会话自身，所以卡片两半回答的是不同问题，
 *  不能交叉读。 */
export function makeOverviewCard(kit: ViewKit): (props: OverviewCardProps) => ReactElement {
  const { t } = kit
  return function OverviewCard(props: OverviewCardProps): ReactElement {
    const { row } = props
    const timeline = row.timeline
    // 两个金额都取 TEAM 口径（整棵子树）；环图与轮次仍算会话自身——
    // 环图读的是会话当前那一刻的上下文。
    const billed = billedOf(row)
    const occupancy = timeline !== null && typeof timeline.contextWindow === 'number' && timeline.contextWindow > 0
      ? fmtShare(timeline.current.total, timeline.contextWindow)
      : null
    const turns = turnsOf(timeline)
    const steps = timeline?.counts?.steps
    const turnsLabel = steps === undefined ? String(turns) : t('ov.card.turns', { n: turns, s: steps })
    // 标题本身就等于项目名的工作区（单仓库的常见情形）只显示一次名字，绝不出现「dsh-cost-breakdown / dsh-cost-breakdown」。
    const project = projectOf(row.cwd)
    const group = props.group !== undefined && props.group !== project ? props.group : undefined
    const created = createdDayOf(row.activity)
    const lastUser = timeline?.lastUser
    return (
      <button
        type="button"
        className={'lc-ov-session' + (row.current ? ' lc-ov-session-current' : '')}
        onClick={() => { props.onOpen(row.id) }}
      >
        <span className="lc-ov-session-head">
          {row.running && <span className="lc-ov-running" title={t('ov.running')} />}
          <span className="lc-ov-session-title" title={row.title}>{row.title}</span>
          {row.current && <span className="lc-ov-current">{t('ov.current')}</span>}
          <span className="lc-ov-session-times">
            <span className="lc-ov-session-time">{relativeTime(t, row.updatedAt, props.now)}</span>
            {created !== undefined && <span className="lc-ov-session-created">{created}</span>}
          </span>
        </span>
        {(group !== undefined || project !== undefined) && (
          <span className="lc-ov-session-crumb" title={row.cwd}>
            {group !== undefined && <span className="lc-ov-crumb-group">{group}</span>}
            {group !== undefined && project !== undefined && <span className="lc-ov-crumb-sep">/</span>}
            {project !== undefined && <span className="lc-ov-crumb-project">{project}</span>}
          </span>
        )}
        {timeline === null ? (
          <span className="lc-ov-session-empty">{t('ov.list.noData')}</span>
        ) : (
          <span className="lc-ov-session-body">
            <Donut
              size={64}
              segments={partsOf(timeline.current)}
              centerTop={fmt(timeline.current.total)}
              centerSub={occupancy ?? undefined}
            />
            <span className="lc-ov-mini-stats">
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('stats.turns')}</span>
                <span className="lc-ov-mini-value">{turnsLabel}</span>
              </span>
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('ov.card.teamUsage')}</span>
                <span className="lc-ov-mini-value">{billed === null ? '—' : fmt(billed)}</span>
              </span>
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('ov.card.teamCost')}</span>
                <span className="lc-ov-mini-value">{props.costLabel}</span>
              </span>
            </span>
          </span>
        )}
        {lastUser !== undefined && (
          <span className="lc-ov-session-preview" title={lastUser}>
            <span className="lc-ov-session-preview-label">{t('ov.card.lastUser')}</span>
            <span className="lc-ov-session-preview-text">{lastUser}</span>
          </span>
        )}
      </button>
    )
  }
}
