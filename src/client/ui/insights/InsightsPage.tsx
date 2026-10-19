/**
 * The Insights page: every session's tokens and spend, in one scrollable surface.
 *
 * The page answers two questions that must never be merged into one figure:
 *   - **how many tokens** the corpus used, split by stage and by billed bucket;
 *   - **what each platform charged**, in that platform's own unit.
 *
 * There is deliberately **no grand total for spend**: adding a credit count to yuan produces a number
 * that is not money. Token and cost sections are separate bands for the same reason.
 */

import { useEffect, useMemo, useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { ClientContext, SessionSeatProps } from '../../shell/contracts'
import { serviceOf, openSessionWith } from '../../shell/contracts'
import type { Translate } from '../../i18n/dict'
import { formatCount, formatDuration } from '../../i18n/format'
import { usePriceBook } from './priceBook'
import type { PreferencesStore } from '../../shell/preferences'
import {
  OVERVIEW_RANGES, aggregateDays, billedTotalsOf, dayKeyRange, filterRows,
  groupCountsOf, inGroup, kpisOf, mergeCreditRatesAll, pageOf, rangeWindowOf, requestActivityBackfill,
  skillLoadsOf, sortRows, windowOfDayRange, type OverviewRange, type OverviewSort, type SkillSort,
} from '../../data/aggregate'
import { rowsOfSnapshot, type OverviewRow } from '../../data/overview'
import { readCatalogue } from '../../data/skills'
import { SkillsCard } from './skills'
import type { SkillEntry } from '../../../wire/model'
import { snapshotOf, activityOf } from '../../shell/washers'
import { moneyRates } from '../../shell/rateTables'
import { formatCost, moneyOnly, type Currency } from '../../data/cost'
import { BilledCard, StageCard, TimingCard, cacheHitOf } from './cards'
import { UsageBars } from './bars'
import { Heatmap } from './heatmap'
import { DateRange } from './dateRange'
import { PlatformCards, platformDisplayName } from './spend'
import { SessionCard } from './sessionCard'
import { PluginInfoCard } from './pluginInfo'
import { UpgradeGate } from './upgradeGate'
import type { DayRange } from '../../data/aggregate'

/** The page's props. */
export interface InsightsProps extends SessionSeatProps {
  t: Translate
  ctx: ClientContext
  preferences: PreferencesStore
  useSessions?: unknown
  useWorkspaces?: unknown
}

/** The page. */
export function InsightsPage(props: InsightsProps): ReactElement {
  const { t, ctx } = props
  const sessions = useSnapshotSeat(props.useSessions)
  const workspaces = useSnapshotSeat(props.useWorkspaces)
  const rows = useMemo(
    () => rowsOfSnapshot(sessions, snapshotOf, activityOf) ?? [],
    [sessions],
  )
  const book = usePriceBook()
  const now = useMemo(() => Date.now(), [])
  const [range, setRange] = useState<OverviewRange>('7d')
  const [custom, setCustom] = useState<DayRange | null>(null)
  const [day, setDay] = useState<string | null>(null)
  const [skill, setSkill] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<OverviewSort>('recent')
  const [group, setGroup] = useState<string | null>(null)
  const [skillSort, setSkillSort] = useState<SkillSort>('loads')
  const [catalog, setCatalog] = useState<ReadonlyMap<string, SkillEntry> | null>(null)
  const [page, setPage] = useState(0)
  const currency: Currency = 'usd'

  // Opening the page asks the host to prewarm the corpus and to refresh the session baseline, so
  // backfilled rows reach a long-lived browser.
  useEffect(() => {
    requestActivityBackfill()
    const sessionsFace = serviceOf<{ refresh?(): Promise<unknown> }>(ctx, 'sessions')
    void sessionsFace?.refresh?.().catch(() => {})
  }, [ctx])

  // Any filter change resets the pager: a page index that no longer exists would render an empty grid.
  useEffect(() => { setPage(0) }, [range, custom, day, skill, query, sort, group, skillSort])

  const window = custom !== null ? windowOfDayRange(custom) ?? rangeWindowOf(range, now) : rangeWindowOf(range, now)
  const credits = mergeCreditRatesAll(rows)
  const money = moneyRates()
  const ranged = useMemo(() => filterRows(rows, { window, day: null, query: '' }), [rows, window])
  const scopedAll = useMemo(() => filterRows(ranged, { window, day, query, skill }), [ranged, window, day, query, skill])
  // A workspace chip narrows the list further; the chips themselves are counted over the unpinned scope so a
  // pinned group keeps its own chip visible (and one click away from being released).
  const scoped = useMemo(
    () => (group === null ? scopedAll : scopedAll.filter(row => inGroup(row, group, workspaces))),
    [scopedAll, group, workspaces],
  )
  const kpis = useMemo(() => kpisOf(ranged, rows.length, book, credits, money, currency), [ranged, rows.length, book, credits, money])
  const days = useMemo(() => aggregateDays(ranged, book, credits, money, currency, now, 7), [ranged, book, credits, money, now])
  const sorted = useMemo(() => sortRows(scoped, sort), [scoped, sort])
  const paged = pageOf(sorted, page)
  const chips = groupCountsOf(scopedAll, workspaces)
  const skills = useMemo(() => skillLoadsOf(ranged, { window, day, sort: skillSort }), [ranged, window, day, skillSort])

  // The catalogue is fetched per (session, workspace): discovery hangs off the agent preset, so the session
  // id is what resolves the full layer set. A stale catalogue for another session is worse than none, so the
  // read clears the old one first.
  const currentId = props.sessionId ?? ''
  const currentCwd = rows.find(row => row.id === currentId)?.cwd
  useEffect(() => {
    setCatalog(null)
    let live = true
    void readCatalogue(currentCwd, currentId === '' ? undefined : currentId).then((next) => {
      if (live) setCatalog(next)
    })
    return () => { live = false }
  }, [currentCwd, currentId])
  const dayMap = useMemo(() => new Map(days.map(entry => [entry.day, entry])), [days])
  const today = todayKey(now)
  const span = custom ?? dayKeyRange(window)

  if (sessions === undefined) {
    return h('div', { className: 'cb-ov-page' }, h('div', { className: 'cb-ov-pagescroll' }, h('div', { className: 'cb-ov-pagecontent' }, h('div', { className: 'cb-empty' }, t('ov.unavailable')))))
  }

  return h('div', { className: 'cb-ov-page' },
    h('div', { className: 'cb-ov-pagescroll' },
    h('div', { className: 'cb-ov-pagecontent' },
    h('div', { className: 'cb-ov-head' },
      h('h1', { className: 'cb-ov-pagetitle' }, t('ov.title')),
      h('div', { className: 'cb-ov-headctl' },
        h(DateRange, {
          value: span,
          picked: custom !== null,
          today,
          locale: 'en-GB',
          t,
          onChange: (next: DayRange | null) => { setCustom(next); if (next !== null) setRange('all') },
        }),
        h('div', { className: 'cb-gran cb-ov-range', role: 'group', 'aria-label': t('ov.range.label') },
          OVERVIEW_RANGES.map(key => h('button', {
            key,
            type: 'button',
            className: `cb-gran-btn${custom === null && range === key ? ' cb-gran-on' : ''}`,
            'aria-pressed': custom === null && range === key,
            onClick: () => { setCustom(null); setRange(key) },
          }, t(`ov.range.${key}`)))))),
    h('div', { className: 'cb-ov-kpis' },
      kpi(t('ov.kpi.sessions'), formatCount(kpis.sessions), t('ov.kpi.ofTotal', { n: kpis.listed })),
      kpi(t('ov.kpi.tokens'), formatCount(kpis.tokens), `${t('stats.turns')} ${formatCount(kpis.turns)}`),
      kpi(t('stats.cacheHit'), cacheHitOf(kpis.billed?.tokens ?? null) === null ? '—' : `${cacheHitOf(kpis.billed?.tokens ?? null) ?? '—'}%`, t('ov.kpi.sessionsSub', { n: kpis.usageSessions })),
      kpi(t('stats.toolCalls'), formatCount(kpis.toolCalls), t('ov.kpi.toolSub', { dur: formatDuration(kpis.toolsMs) })),
      kpi(t('timing.total'), formatDuration(kpis.wallMs), t('ov.kpi.wallSub', { n: formatCount(kpis.calls) })),
      kpi(t('ov.kpi.modelCalls'), formatCount(kpis.calls), t('ov.kpi.pricedSub', { n: kpis.costSessions, total: kpis.sessions }))),
    h('div', { className: 'cb-ov-first' },
      h(UsageBars, { days, today, t })),
    h('div', { className: 'cb-ov-stats' },
      h(BilledCard, { billed: kpis.billed, t }),
      h(StageCard, { parts: kpis.tokenParts, t }),
      h(TimingCard, { timing: kpis.timing, t })),
    h('div', { className: 'cb-ov-spend' },
      h('div', { className: 'cb-ov-spend-head' },
        h('span', { className: 'cb-ov-spend-title' }, t('ov.spend.title')),
        h('span', { className: 'cb-card-sub' }, t('ov.spend.sub'))),
      kpis.billed === null || kpis.billed.platforms.length === 0
        ? h('div', { className: 'cb-empty' }, t('ov.spend.empty'))
        : h(PlatformCards, { rows: kpis.billed.platforms, currency, t })),
    h('div', { className: 'cb-ov-body' },
      h('div', { className: 'cb-ov-left' },
        h('div', { className: 'cb-card cb-ov-heat-card' },
          h('div', { className: 'cb-card-title' },
            h('span', { className: 'cb-card-title-text' }, t('ov.heat.title')),
            h('span', { className: 'cb-card-sub' }, t('ov.heat.sub'))),
          h(Heatmap, { days: dayMap, today, selected: day, onSelect: setDay, t })),
        h(SkillsCard, {
          t,
          stats: skills,
          catalog,
          selected: skill,
          onSelect: setSkill,
          sort: skillSort,
          onSort: setSkillSort,
          now,
        })),
      h('div', { className: 'cb-ov-right' },
        h('div', { className: 'cb-ov-list-head' },
          h('span', { className: 'cb-ov-list-title' }, t('ov.list.title')),
          h('span', { className: 'cb-ov-list-count' }, String(scoped.length)),
          day !== null ? h('button', { type: 'button', className: 'cb-ov-chip', title: t('ov.list.dayClear'), onClick: () => { setDay(null) } }, `${t('ov.list.dayFilter', { day })} ×`) : null,
          skill !== null ? h('button', { type: 'button', className: 'cb-ov-chip', title: t('ov.list.skillClear'), onClick: () => { setSkill(null) } }, `${t('node.skillTag', { name: skill })} ×`) : null,
          h('input', {
            className: 'cb-ov-search',
            type: 'search',
            placeholder: t('ov.list.search'),
            'aria-label': t('ov.list.search'),
            value: query,
            onInput: (event: Event) => { setQuery((event.target as HTMLInputElement).value) },
          }),
          h('div', { className: 'cb-gran', role: 'group', 'aria-label': t('ov.list.sortLabel') },
            (['recent', 'tokens', 'context'] as const).map(key => h('button', {
              key,
              type: 'button',
              className: `cb-gran-btn${sort === key ? ' cb-gran-on' : ''}`,
              'aria-pressed': sort === key,
              onClick: () => { setSort(key) },
            }, t(`ov.list.sort.${key}`))))),
        chips.length > 0
          ? h('div', { className: 'cb-ov-groups' }, chips.map(chip => h('button', {
            key: chip.key,
            type: 'button',
            className: `cb-ov-group${chip.key === group ? ' cb-ov-group-on' : ''}`,
            'aria-pressed': chip.key === group,
            title: t('ov.group.label'),
            onClick: () => { setGroup(chip.key === group ? null : chip.key) },
          }, `${chip.key === '__ungrouped__' ? t('ov.group.ungrouped') : chip.key} ${chip.count}`)))
          : null,
        h('div', { className: 'cb-ov-grid' },
          paged.rows.map(row => h(SessionCard, {
            key: row.id,
            row,
            costLabel: costLabelOf(row, book, credits, money, currency),
            now,
            t,
            onOpen: (id: string) => { openSessionWith(ctx, id) },
          }))),
        sorted.length === 0
          ? h('div', { className: 'cb-empty' }, t(rows.length === 0 ? 'ov.list.empty' : 'ov.list.noMatch'))
          : null,
        paged.count > 1
          ? h('div', { className: 'cb-ov-pager' },
            h('button', { type: 'button', className: 'cb-gran-btn', disabled: paged.index === 0, onClick: () => { setPage(paged.index - 1) } }, '‹'),
            h('span', { className: 'cb-ov-page-label' }, t('ov.list.page', { n: paged.index + 1, total: paged.count })),
            h('button', { type: 'button', className: 'cb-gran-btn', disabled: paged.index >= paged.count - 1, onClick: () => { setPage(paged.index + 1) } }, '›'))
          : null)),
    h(PluginInfoCard, { t }),
    h(UpgradeGate, { t, sessionId: props.sessionId, current: '', minimum: '' }))))
}

/** One KPI cell. */
function kpi(label: string, value: string, sub: string): ReactElement {
  return h('div', { className: 'cb-ov-kpi' },
    h('div', { className: 'cb-ov-kpi-label' }, label),
    h('div', { className: 'cb-ov-kpi-value' }, value),
    h('div', { className: 'cb-ov-kpi-sub' }, sub))
}

/** The session card's cost label: a dash when the family cannot be priced, never a zero. */
function costLabelOf(row: OverviewRow, book: ReturnType<typeof usePriceBook>, credits: ReturnType<typeof mergeCreditRatesAll>, money: ReturnType<typeof moneyRates>, currency: Currency): string {
  if (row.familyCost === null) return '—'
  const usable = moneyOnly(row.familyCost, credits)
  if (usable === null) return '—'
  const totals = billedTotalsOf([row], book, credits, money)
  if (!totals.costByBucket.any) return '—'
  void currency
  return formatCost(totals.costByBucket.total, 'usd')
}

/** Local `YYYY-MM-DD` of an instant. */
function todayKey(now: number): string {
  const date = new Date(now)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Read a root-scope seat snapshot without letting a throwing selector take the page down. */
function useSnapshotSeat(seat: unknown): unknown {
  if (typeof seat !== 'function') return undefined
  try {
    return (seat as (selector: (snapshot: unknown) => unknown) => unknown)((snapshot: unknown) => snapshot)
  } catch {
    return undefined
  }
}

export { platformDisplayName }
