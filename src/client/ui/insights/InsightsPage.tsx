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
import { formatCount, formatDuration, formatPercent } from '../../i18n/format'
import { usePriceBook } from './priceBook'
import type { PreferencesStore } from '../../shell/preferences'
import {
  OVERVIEW_PAGE_SIZE, OVERVIEW_RANGES, aggregateDays, billedTotalsOf, dayKeyRange, daysOfWindow, filterRows,
  groupCountsOf, kpisOf, mergeCreditRatesAll, pageOf, rangeWindowOf, relativeTime, requestActivityBackfill,
  sessionGroupsOf, skillLoadsOf, sortRows, windowOfDayRange, type OverviewRange, type OverviewSort, type SkillSort,
} from '../../data/aggregate'
import { rowsOfSnapshot, type OverviewRow } from '../../data/overview'
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
  const { t, ctx, preferences } = props
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
  useEffect(() => { setPage(0) }, [range, custom, day, skill, query, sort])

  const window = custom !== null ? windowOfDayRange(custom) ?? rangeWindowOf(range, now) : rangeWindowOf(range, now)
  const credits = mergeCreditRatesAll(rows)
  const money = moneyRates()
  const ranged = useMemo(() => filterRows(rows, { window, day: null, query: '' }), [rows, window])
  const scoped = useMemo(() => filterRows(ranged, { window, day, query, skill }), [ranged, window, day, query, skill])
  const kpis = useMemo(() => kpisOf(ranged, rows.length, book, credits, money, currency), [ranged, rows.length, book, credits, money])
  const days = useMemo(() => aggregateDays(ranged, book, credits, money, currency, now, 7), [ranged, book, credits, money, now])
  const sorted = useMemo(() => sortRows(scoped, sort), [scoped, sort])
  const paged = pageOf(sorted, page)
  const chips = groupCountsOf(scoped, workspaces)
  const skills = useMemo(() => skillLoadsOf(ranged, { window, day, sort: 'loads' as SkillSort }), [ranged, window, day])
  const dayMap = useMemo(() => new Map(days.map(entry => [entry.day, entry])), [days])
  const groups = useMemo(() => sessionGroupsOf(scoped, workspaces), [scoped, workspaces])
  const today = todayKey(now)
  const span = custom ?? dayKeyRange(window)

  if (sessions === undefined) {
    return h('div', { className: 'cb-ov-page' }, h('div', { className: 'cb-empty' }, t('ov.unavailable')))
  }

  return h('div', { className: 'cb-ov-page' },
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
        skillCard(t, skills, skill, setSkill)),
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
            className: `cb-ov-group${chip.key === day ? ' cb-ov-group-on' : ''}`,
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
    h(UpgradeGate, { t, sessionId: props.sessionId, current: '', minimum: '' }))
}

/** One KPI cell. */
function kpi(label: string, value: string, sub: string): ReactElement {
  return h('div', { className: 'cb-ov-kpi' },
    h('div', { className: 'cb-ov-kpi-label' }, label),
    h('div', { className: 'cb-ov-kpi-value' }, value),
    h('div', { className: 'cb-ov-kpi-sub' }, sub))
}

/** The skills card: loads, sessions, last load; a click pins the filter. */
function skillCard(t: Translate, skills: ReturnType<typeof skillLoadsOf>, selected: string | null, onSelect: (value: string | null) => void): ReactElement {
  return h('div', { className: 'cb-card cb-ov-skills' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('ov.skills.summary')),
      h('span', { className: 'cb-card-sub' }, t('ov.skills.k.usage'))),
    skills.length === 0
      ? h('div', { className: 'cb-empty' }, t('ov.skills.empty'))
      : h('ul', { className: 'cb-ov-skill-list' }, skills.slice(0, 20).map(entry => h('li', {
        key: entry.name,
        className: `cb-ov-skill${entry.name === selected ? ' cb-ov-skill-on' : ''}`,
        onClick: () => { onSelect(entry.name === selected ? null : entry.name) },
        role: 'button',
        tabIndex: 0,
      },
        h('span', { className: 'cb-ov-skill-name' }, entry.name),
        h('span', { className: 'cb-ov-skill-loads' }, `${t('ov.skills.loads')} ${formatCount(entry.loads)}`),
        h('span', { className: 'cb-ov-skill-sessions' }, `${t('ov.skills.sessions')} ${formatCount(entry.sessions)}`)))))
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

export { formatPercent, relativeTime, sessionGroupsOf, platformDisplayName, OVERVIEW_PAGE_SIZE }
