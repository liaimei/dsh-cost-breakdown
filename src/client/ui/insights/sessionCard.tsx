/**
 * One session card in the Insights grid.
 *
 * The card answers two different questions on purpose, and they must not be cross-read:
 *   - the ring and the turn count describe the session **itself** (its live context right now);
 *   - the two money/token figures are **team scope** — the session plus every descendant sub-agent,
 *     because a sub-agent's spend belongs to the run that spawned it.
 *
 * The cost label arrives pre-formatted because the currency belongs to the caller. `—` (never `0`)
 * means the family ledger could not be priced; a `0` would claim the run spent nothing when the
 * truth is that no rate applies.
 */

import type { ReactElement } from 'react'
import type { Snapshot } from '../../../wire/model'
import type { OverviewRow } from '../../data/overview'
import { billedOf, createdDayOf, relativeTime, turnsOf } from '../../data/aggregate'
import { formatCount, formatShare } from '../../i18n/format'
import type { Translate } from '../../i18n/dict'
import { Donut, STAGE_COLORS } from './donut'

/** A row of the ring from the live context composition. Zero-valued stages are dropped: an empty arc
 * says nothing, and the ring already carries the total in its hole. */
function contextSegments(current: Snapshot['current']): Array<{ key: string; color: string; value: number }> {
  const keys = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool'] as const
  const out: Array<{ key: string; color: string; value: number }> = []
  for (const key of keys) {
    const value = current[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out.push({ key, color: STAGE_COLORS[key] ?? 'var(--cb-ov-slate)', value })
    }
  }
  return out
}

/** The workspace's short project name from its cwd: the tail path segment, for either separator. */
export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const parts = cwd.split(/[\\/]+/).filter(part => part !== '')
  const tail = parts.length > 0 ? parts[parts.length - 1] : undefined
  return tail === undefined || tail === '' ? undefined : tail
}

export interface SessionCardProps {
  row: OverviewRow
  /** The workspace title claiming this row, when a chip pin exists for it. */
  group?: string
  /** Pre-formatted cost label, or an em dash when the family cannot be priced. */
  costLabel: string
  /** Render instant, injected so relative times are deterministic under test. */
  now: number
  /** Open the session in the centre column. */
  onOpen: (id: string) => void
  t: Translate
}

/** One card. The whole card is a button: the list's only action is opening the session, and the
 * harness's own navigation returns the centre column to the conversation. */
export function SessionCard(props: SessionCardProps): ReactElement {
  const { row, t } = props
  const timeline = row.timeline
  // The group is only worth a breadcrumb when it differs from the project name — a single-repo
  // workspace must not print its own name twice.
  const project = projectOf(row.cwd)
  const group = props.group !== undefined && props.group !== project ? props.group : undefined
  const created = createdDayOf(row)
  const billed = billedOf(row)
  const occupancy = timeline !== null
    && typeof timeline.contextWindow === 'number' && timeline.contextWindow > 0
    ? formatShare(timeline.current.total, timeline.contextWindow)
    : null
  const turns = turnsOf(row)
  const steps = timeline?.counts?.steps
  const turnsLabel = steps === undefined
    ? formatCount(turns)
    : t('ov.card.turns', { n: formatCount(turns), s: formatCount(steps) })
  const lastUser = timeline?.lastUser
  return (
    <button
      type="button"
      className={'cb-ov-session' + (row.running ? ' cb-ov-session-running' : '')}
      onClick={() => { props.onOpen(row.id) }}
    >
      <span className="cb-ov-session-head">
        {row.running && <span className="cb-ov-running" title={t('ov.running')} />}
        <span className="cb-ov-session-title" title={row.title}>{row.title}</span>
        <span className="cb-ov-session-times">
          <span className="cb-ov-session-time">{relativeTime(row.updatedAt, props.now, t)}</span>
          {created !== null && <span className="cb-ov-session-created">{created}</span>}
        </span>
      </span>
      {(group !== undefined || project !== undefined) && (
        <span className="cb-ov-session-crumb" title={row.cwd}>
          {group !== undefined && <span className="cb-ov-crumb-group">{group}</span>}
          {group !== undefined && project !== undefined && <span className="cb-ov-crumb-sep">/</span>}
          {project !== undefined && <span className="cb-ov-crumb-project">{project}</span>}
        </span>
      )}
      {timeline === null ? (
        <span className="cb-ov-session-empty">{t('ov.list.noData')}</span>
      ) : (
        <span className="cb-ov-session-body">
          <Donut
            size={64}
            segments={contextSegments(timeline.current)}
            centerTop={formatCount(timeline.current.total)}
            {...(occupancy !== null ? { centerSub: occupancy } : {})}
          />
          <span className="cb-ov-mini-stats">
            <span className="cb-ov-mini-stat">
              <span className="cb-ov-mini-label">{t('stats.turns')}</span>
              <span className="cb-ov-mini-value">{turnsLabel}</span>
            </span>
            <span className="cb-ov-mini-stat">
              <span className="cb-ov-mini-label">{t('ov.card.teamUsage')}</span>
              <span className="cb-ov-mini-value">{billed === null ? '—' : formatCount(billed)}</span>
            </span>
            <span className="cb-ov-mini-stat">
              <span className="cb-ov-mini-label">{t('ov.card.teamCost')}</span>
              <span className="cb-ov-mini-value">{props.costLabel}</span>
            </span>
          </span>
        </span>
      )}
      {lastUser !== undefined && (
        <span className="cb-ov-session-preview" title={lastUser}>
          <span className="cb-ov-session-preview-label">{t('ov.card.lastUser')}</span>
          <span className="cb-ov-session-preview-text">{lastUser}</span>
        </span>
      )}
    </button>
  )
}
