/**
 * Context Insights 页面：插件的第一级面板，注册在布局那个带 key 的 `main` 槽位上，所以它的
 * 挂载就是它的打开。数据来自根作用域的 sessions/workspaces 标准套件——每个列表行都由宿主缓存的
 * projection 值——因此这个页面不打开任何日志就能画出每个会话的洞察。
 *
 * 与自带一级页面那套居中的 960px 框架不同，这里的内容列铺满整个窗格，好让网格与
 * 图例随之自适应，而页面元素就是各 fold 据以取键的 `lc-ov` 查询容器。悬停提示 portal 到
 * <body>，否则那个容器会捕获它们的固定定位。
 *
 * 这一簇只持有「一个」作用域：选定的日历区间取代滚动预设，点一下预设又把它交还，
 * 所以两者绝不会同时占用它，而预设作用域的一切都读那同一个已解析的窗口。在 KPI 带与用量图之下，
 * 热力图把它的两个同列伙伴一起钉到选中的某天，而技能卡片行的一次点击
 * 把会话列收窄到同一作用域内加载该技能的会话。会话卡片通过
 * harness 自己的 `openSessionVia` 跳转，它的导航会把中间那列交还给对话。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { estimateSessionCost, formatCost, type CostCurrency, type ModelBook } from '../cost'
import { fmt } from '../format'
import { useModelPrices } from '../modelPrices'
import {
  aggregateDays, dayRangeWindow, filterRows, groupCountsOf, inGroup, kpisOf,
  pageOf, rangeWindowOf, refreshSessions, requestActivityBackfill, rowsOfSnapshot,
  rowLoadedSkill, sessionGroupsOf, sessionsSnapshotOf, skillLoadsOf, sortRows,
  UNGROUPED_KEY, workspacesSnapshotOf,
  type DayRange, type OverviewRange, type OverviewRow, type OverviewSort, type SkillSort,
} from '../overview'
import { openSessionVia, type ClientCtx } from '../services'
import { readSkillCatalog } from '../skills'
import { openPluginSettings } from '../settingsJump'
import type { SkillInfo } from '../../shared/types'
import { dayKeyOf } from '../../shared/days'
import type { ViewKit } from '../viewkit'
import { makeBalanceCapsule } from './balanceCapsule'
import { makeDateRange } from './dateRange'
import { makeErrorBoundary } from './errorBoundary'
import { makeHeatmap, todayKey, type HeatMetric } from './heatmap'
import { Donut } from './donut'
import { useHoverTip } from './hoverTip'
import { makeOverviewTokens } from './overviewTokens'
import { makeOverviewBilled } from './overviewBilled'
import { makeStatsPlatforms } from './statsPlatforms'
import { makeOverviewUsage } from './overviewUsage'
import { makeStatsTiming } from './statsTiming'
import { makeOverviewCard } from './overviewCard'
import { makeOverviewSkills } from './overviewSkills'
import { IconSettings } from '../primitives'

/** 该槽位的 props：两个快照 hook 以标准套件成员的身份进来，
 *  并在 overview 模块内部被重新校验成确切的 hook 形态，所以这里是 `unknown`。 */
export interface OverviewPanelProps {
  useSessions?: unknown
  useWorkspaces?: unknown
}

/** 滚动预设，按切换顺序排列；第一个是默认值，而选定的日历区间
 *  会覆盖当前生效的那个。 */
const RANGES: readonly OverviewRange[] = ['today', '7d', '30d', 'all']
/** 会话列表的排序模式；`recent` 是默认值，所以新开的页面最新在前。 */
const SORTS: readonly OverviewSort[] = ['recent', 'tokens', 'context']
/** 热力图的深浅指标，按切换顺序排列（steps 是默认值）。 */
const METRICS: readonly HeatMetric[] = ['sessions', 'steps']

/**
 * 绑定 `ctx`（会话导航、设置跳转）与 `kit`，把每张子卡片都只构建一次，
 * 使它们在过滤条件变化时都不重新挂载。返回的组件把正文渲染在错误边界内：
 * 一个抛异常的投影只会留下一张可重试的卡片，
 * 而不是一片空白页。
 */
export function makeOverviewPanel(ctx: ClientCtx, kit: ViewKit): (props: OverviewPanelProps) => ReactElement | null {
  const { t, fmtDuration } = kit
  const Heatmap = makeHeatmap(kit)
  const OverviewCard = makeOverviewCard(kit)
  const BalanceCapsule = makeBalanceCapsule(ctx, kit)
  const DateRange = makeDateRange(kit)
  const OverviewBilled = makeOverviewBilled(kit, Donut)
  const StatsPlatforms = makeStatsPlatforms(kit, Donut)
  const OverviewTokens = makeOverviewTokens(kit, Donut)
  const StatsTiming = makeStatsTiming(kit, Donut)
  const OverviewUsage = makeOverviewUsage(kit)
  const OverviewSkills = makeOverviewSkills(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  // 每次渲染都读：槽位出口在语言切换时会重新渲染。
  function activeLocale(): string {
    const locale = ctx.locale
    return typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
  }

  /** 展示货币跟随当前语言。 */
  function activeCurrency(): CostCurrency {
    return activeLocale() === 'zh' ? 'cny' : 'usd'
  }

  function OverviewBody(props: OverviewPanelProps): ReactElement | null {
    const { book } = useModelPrices()
    const snapshot = sessionsSnapshotOf(props)
    const wsSnapshot = workspacesSnapshotOf(props)
    const [preset, setPreset] = useState<OverviewRange>('30d')
    const [custom, setCustom] = useState<DayRange | null>(null)
    const [day, setDay] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [group, setGroup] = useState<string | null>(null)
    const [skill, setSkill] = useState<string | null>(null)
    const [skillSort, setSkillSort] = useState<SkillSort>('loads')
    const [sort, setSort] = useState<OverviewSort>('recent')
    const [metric, setMetric] = useState<HeatMetric>('steps')
    const [page, setPage] = useState(0)
    const { zoneProps, bubble } = useHoverTip()

    const rows = useMemo(() => rowsOfSnapshot(snapshot, wsSnapshot), [snapshot, wsSnapshot])
    const groups = useMemo(() => sessionGroupsOf(wsSnapshot), [wsSnapshot])
    const [catalog, setCatalog] = useState<ReadonlyMap<string, SkillInfo> | null>(null)

    // 技能卡片的元数据读取：registry 是按「会话」解析的（工作区
    // 选择项目层，预设选择发现范围），
    // 所以用当前会话来锚定它；没有会话的列表仍然
    // 能读全局层。切换会话会重读；读取失败让卡片保持未富集，而不是留一份过期数据。
    const currentRow = (rows ?? []).find(row => row.current)
    const currentCwd = currentRow?.cwd
    const currentId = currentRow?.id
    useEffect(() => {
      let alive = true
      // 先把目录置为 null：这个 effect 以当前行为 key，而上一个会话的
      // registry 条目对这个会话可能根本不存在——过期的明细比没有更糟。
      setCatalog(null)
      void readSkillCatalog(currentCwd, currentId).then((next) => { if (alive && next !== null) setCatalog(next) })
      return () => { alive = false }
    }, [currentCwd, currentId])

    // 挂载时（即面板打开时）：召唤宿主的 projection 预热（这个
    // 页面是这些行的唯一读者——每个宿主进程一趟），并把列表重新拉一次，
    // 好让回填出来的行也能到达一个连接很久的页面。
    useEffect(() => {
      requestActivityBackfill()
      refreshSessions(ctx)
    }, [])

    // 任何过滤条件变化都把分页器重新锚回第一页；放着页码不管
    // 会让读者困在一个收窄过滤后已不存在的页上。
    useEffect(() => { setPage(0) }, [preset, custom, day, query, group, skill, sort])

    const currency = activeCurrency()
    const now = Date.now()
    const allRows = rows ?? []
    // 下面每个数字都读的那个作用域窗口：设定了日历区间时就用它自己选定的
    // 区间（畸形的 key 保持预设，绝不产生一个无法证明的窗口），否则用预设的滚动下界。
    const scope = (custom !== null ? dayRangeWindow(custom) : null) ?? rangeWindowOf(preset, now)
    // 头部的日期跨度，读自同一个窗口，所以选择器与
    // 预设永远不会互相矛盾：选定区间用它自己的两天，预设用它
    // 的下界到今天（它的末端是开口的），"all" 之下则什么都没有。
    const spanFrom = scope.start === null ? null : dayKeyOf(scope.start)
    const spanTo = scope.start === null ? null : dayKeyOf(scope.end ?? now)
    const span = spanFrom !== null && spanTo !== null ? { from: spanFrom, to: spanTo } : null
    // 作用域约束的是 KPI 带、组成环图与网格；
    // 热力图则在整个列表上保留它自己固定的窗口。
    const ranged = filterRows(allRows, { scope, day: null, query: '' })
    // 分组徽标统计的是「分组过滤生效之前」、已被日/查询约束的行，
    // 所以选中一个徽标绝不会把那一行本身弄没。
    const scoped = filterRows(ranged, { scope, day, query })
    const counts = groupCountsOf(scoped, wsSnapshot)
    // 所选分组掉出作用域时仍保留一个幻影徽标（计数
    // 为 0），好让生效中的过滤始终可见、点一下就能退出。
    const chips = group !== null && !counts.some(c => c.key === group)
      ? [...counts, { key: group, count: 0 }]
      : counts
    const visible = sortRows(
      (group === null ? scoped : scoped.filter(row => inGroup(row, group, groups)))
        // 技能卡片的行钉选把列表收窄到该技能的加载者，
        // 范围限定在卡片自己的作用域内（作用域窗口加上被钉住的日期）。
        .filter(row => skill === null || rowLoadedSkill(row, skill, { scope, day })),
      sort,
    )
    const paged = pageOf(visible, page)
    const kpi = kpisOf(ranged, allRows.length, book, currency)
    const days = aggregateDays(allRows, book, currency)
    const openOne = (id: string): void => {
      // 视图主人的动词会把中间那列导航回
      // 对话本身（selectPanel(null)），所以这个页面无需自己关闭。
      openSessionVia(ctx, id)
    }

    return (
      <section className="lc-ov-page" aria-label={t('ov.title')} {...zoneProps}>
        {bubble}
        {/* 页面唯一的滚动区域。 */}
        <div className="lc-ov-pagescroll">
          <div className="lc-ov-pagecontent">
            <div className="lc-ov-pagehead">
              <h1 className="lc-ov-pagetitle">{t('ov.title')}</h1>
              <button type="button" className="lc-ov-settings" title={t('plugin.settingsOpen')} onClick={() => { openPluginSettings() }}>
                <IconSettings size={14} />{t('plugin.settings')}
              </button>
              {/* 在实时数字落地之前什么都不渲染，所以标题行永远不会因它而重排。 */}
              <BalanceCapsule />
              {/* 用一个包裹层，好让头部右侧那一簇只推挤一次；一个裸的 `.lc-gran` 兄弟节点会把这块自由空间劈开。 */}
              <div className="lc-ov-headctl">
                <DateRange
                  value={span}
                  picked={custom !== null}
                  onChange={(next) => { setCustom(next) }}
                  today={todayKey()}
                  locale={activeLocale()}
                />
                <div className="lc-gran lc-ov-range" role="group" aria-label={t('ov.range.label')}>
                  {RANGES.map(r => (
                    <button
                      key={r}
                      type="button"
                      className={'lc-gran-btn' + (custom === null && preset === r ? ' lc-gran-on' : '')}
                      onClick={() => { setPreset(r); setCustom(null) }}
                    >{t('ov.range.' + r)}</button>
                  ))}
                </div>
              </div>
            </div>

            {rows === null ? (
              <div className="lc-empty">{t('ov.unavailable')}</div>
            ) : (
              <>
                {/* 区间选择器不约束用法图；后者读的是合并后的每日台账。 */}
                <div className="lc-ov-first">
                  <div className="lc-ov-kpis">
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('ov.kpi.sessions')}</span>
                      <span className="lc-stat-value">{kpi.sessions}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.ofTotal', { n: kpi.listed })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('ov.kpi.tokens')}</span>
                      <span className="lc-stat-value">{fmt(kpi.tokens)}</span>
                      <span className="lc-stat-sub">{t('stats.turns')} {fmt(kpi.turns)}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.cost')}</span>
                      <span className="lc-stat-value">{kpi.cost === null ? '—' : formatCost(kpi.cost, currency)}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.pricedSub', { n: kpi.costSessions, total: kpi.sessions })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.cacheHit')}</span>
                      <span className="lc-stat-value">{kpi.cacheHit === null ? '—' : kpi.cacheHit + '%'}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.sessionsSub', { n: kpi.usageSessions })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('stats.toolCalls')}</span>
                      <span className="lc-stat-value">{fmt(kpi.toolCalls)}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.toolSub', { dur: fmtDuration(kpi.toolsMs) })}</span>
                    </div>
                    <div className="lc-stat lc-ov-kpi">
                      <span className="lc-stat-label">{t('timing.total')}</span>
                      <span className="lc-stat-value">{fmtDuration(kpi.wallMs)}</span>
                      <span className="lc-stat-sub">{t('ov.kpi.wallSub', { n: fmt(kpi.calls) })}</span>
                    </div>
                  </div>
                  <OverviewUsage days={days} currency={currency} today={todayKey()} />
                </div>
                <div className="lc-ov-stats">
                  <OverviewBilled billed={kpi.billed} currency={currency} />
                  {/* 每个平台一张卡：跨会话按平台汇总，与单会话页同一个组件。 */}
                  <StatsPlatforms rows={kpi.billed?.platforms ?? []} currency={currency} />
                  <OverviewTokens tokens={kpi.tokenParts} />
                  <StatsTiming timing={kpi.timing} />
                </div>
                <div className="lc-ov-body">
                  <div className="lc-ov-left">
                    <div className="lc-card lc-ov-heat-card">
                      <div className="lc-card-title">
                        <span className="lc-card-title-text">{t('ov.heat.title')}</span>
                        <span className="lc-heat-ctl">
                          <span className="lc-card-sub">{t('ov.heat.sub')}</span>
                          <div className="lc-gran" role="group" aria-label={t('ov.heat.metric')}>
                            {METRICS.map(m => (
                              <button
                                key={m}
                                type="button"
                                className={'lc-gran-btn' + (metric === m ? ' lc-gran-on' : '')}
                                onClick={() => { setMetric(m) }}
                              >{t('ov.heat.metric.' + m)}</button>
                            ))}
                          </div>
                        </span>
                      </div>
                      <Heatmap days={days} metric={metric} selected={day} onSelect={setDay} today={todayKey()} />
                    </div>
                    {/* 作用域：区间分组加上热力图钉住的日期；列表的搜索与分组徽标是列表本地的。 */}
                    <OverviewSkills
                      stats={skillLoadsOf(ranged, { scope, day, sort: skillSort })}
                      day={day}
                      selected={skill}
                      onSelect={setSkill}
                      sort={skillSort}
                      onSort={setSkillSort}
                      catalog={catalog}
                      now={now}
                    />
                  </div>

                  <div className="lc-ov-right">
                    <div className="lc-ov-list-head">
                      <span className="lc-ov-list-title">{t('ov.list.title')}</span>
                      <span className="lc-ov-list-count">{visible.length}</span>
                      {day !== null && (
                        <button type="button" className="lc-ov-day-chip" title={t('ov.list.dayClear')} onClick={() => { setDay(null) }}>
                          {t('ov.list.dayFilter', { day })} ×
                        </button>
                      )}
                      {skill !== null && (
                        <button type="button" className="lc-ov-day-chip" title={t('ov.list.skillClear')} onClick={() => { setSkill(null) }}>
                          {t('node.skillTag', { name: skill })} ×
                        </button>
                      )}
                      <input
                        className="lc-ov-search"
                        type="search"
                        value={query}
                        placeholder={t('ov.list.search')}
                        aria-label={t('ov.list.search')}
                        onChange={(ev) => { setQuery(ev.target.value) }}
                      />
                      <div className="lc-gran" role="group" aria-label={t('ov.list.sortLabel')}>
                        {SORTS.map(s => (
                          <button
                            key={s}
                            type="button"
                            className={'lc-gran-btn' + (sort === s ? ' lc-gran-on' : '')}
                            onClick={() => { setSort(s) }}
                          >{t('ov.list.sort.' + s)}</button>
                        ))}
                      </div>
                    </div>

                    {chips.length > 0 && (
                      <div className="lc-ov-groups" role="group" aria-label={t('ov.group.label')}>
                        <button
                          type="button"
                          className={'lc-ov-chip' + (group === null ? ' lc-ov-chip-on' : '')}
                          onClick={() => { setGroup(null) }}
                        >{t('ov.range.all')}<span className="lc-ov-chip-n">{scoped.length}</span></button>
                        {chips.map(c => (
                          <button
                            key={c.key}
                            type="button"
                            className={'lc-ov-chip' + (group === c.key ? ' lc-ov-chip-on' : '')}
                            onClick={() => { setGroup(group === c.key ? null : c.key) }}
                          >{c.key === UNGROUPED_KEY ? t('ov.group.ungrouped') : c.key}<span className="lc-ov-chip-n">{c.count}</span></button>
                        ))}
                      </div>
                    )}

                    {visible.length === 0 ? (
                      <div className="lc-empty">{t(allRows.length === 0 ? 'ov.list.empty' : 'ov.list.noMatch')}</div>
                    ) : (
                      <>
                        <div className="lc-ov-grid">
                          {paged.items.map(row => (
                            <OverviewCard
                              key={row.id}
                              row={row}
                              {...(groups?.[row.id] !== undefined ? { group: groups[row.id] } : {})}
                              costLabel={cardCostOf(row, book, currency)}
                              now={now}
                              onOpen={openOne}
                            />
                          ))}
                        </div>
                        {paged.count > 1 && (
                          <div className="lc-ov-pager" role="navigation" aria-label={t('ov.list.pager')}>
                            <button
                              type="button"
                              className="lc-ov-pager-btn"
                              disabled={paged.index === 0}
                              aria-label={t('ov.list.prev')}
                              onClick={() => { setPage(paged.index - 1) }}
                            >‹</button>
                            <span className="lc-ov-pager-n">{t('ov.list.page', { n: paged.index + 1, total: paged.count })}</span>
                            <button
                              type="button"
                              className="lc-ov-pager-btn"
                              disabled={paged.index === paged.count - 1}
                              aria-label={t('ov.list.next')}
                              onClick={() => { setPage(paged.index + 1) }}
                            >›</button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    )
  }

  return function OverviewPanel(props: OverviewPanelProps): ReactElement | null {
    return <ErrorBoundary><OverviewBody {...props} /></ErrorBoundary>
  }
}

/** 某张卡片在团队作用域下已计价的成本标签，或一条短横线（还没有价目表、没有任何计费、
 *  或模型无法计价）。这条短横线是刻意的：渲染成 `0` 会声称这个家族一分钱都没花，
 *  而事实是这个数字无法计价。 */
function cardCostOf(row: OverviewRow, book: ModelBook | null, currency: CostCurrency): string {
  if (row.familyCost === null) return '—'
  const cost = estimateSessionCost(row.familyCost, book, currency)
  return cost === null ? '—' : formatCost(cost, currency)
}
