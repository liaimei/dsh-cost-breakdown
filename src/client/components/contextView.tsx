import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Category, ContextEventRecord, RequestRecord, SurfaceNode } from '../../shared/types'
import { briefNodes, briefOf } from '../brief'
import { headlineOf } from '../headline'
import type { ContextViewProps } from '../services'
import { contextBreakdownOf, contextPressureOf, conversationNodesOf, headersOf, imageLoaderOf, numOf, projectionOf, tokenUsageOf, unsupportedOf } from '../services'
import type { ClientCtx, ConversationNodeLike } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useTimelineSource } from '../timelineSource'
import { makeDetailNote } from './detailNote'
import { canOpenPathsOf, openPathVia, openResourceVia, workspaceOf } from '../services'
import { activityOf, activityOfOps, locateStepOf, previewAddressOf } from '../fileActivity'
import type { FileEntry, FileOp } from '../fileActivity'
import type { ContextSettings } from '../settings'
import type { ViewKit } from '../viewkit'
import { makeAgentHeads } from '../agentHeads'
import { makeContextBrowser } from './browser'
import type { CatFocus } from './browser'
import { makeAgentGraph } from './agentGraph'
import { Donut } from './donut'
import { makeCurrentComposition } from './currentComposition'
import { makeEventList } from './events'
import { makeFileCard } from './fileCard'
import { makePluginInfo } from './pluginInfo'
import { makeUpgradeGate } from './upgradeGate'
import { makeRequestDetail } from './requestDetail'
import { countsOfRecords, makeStatsContext, makeSubagentCost, toolTallyOf } from './statsContext'
import { makeStatsTiming } from './statsTiming'
import { makeStatsTokens } from './statsTokens'
import { makeLegend, makeStackedBar } from './stackedBar'
import { aggregateByTurn, attachMarkers, jumpTargetOf, makeTrendChart, turnStepsOf } from './trendChart'
import { assemble } from '../assemble'
import { trendBandsOf } from '../dna'

import { subscribeContextFocus, takeContextFocus } from '../viewFocus'
import { revealInScrollParent } from '../revealScroll'
import { makeErrorBoundary } from './errorBoundary'

// 页面在对话共享的 `[data-conversation-scroll]` 容器里滚动，那个容器由聊天底部锚定；
// 模块级的逐会话台账能扛过标签页重新挂载，并在内容渲染出来后恢复位置。
const viewScroll = new Map<string, number>()

const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const

/**
 * 绑定 `ctx`、`kit` 与 `settings`，每次 apply 时把每张卡片都构建一次。返回的视图
 * 把正文渲染在错误边界内；有两个存储刻意做成页面级而非逐卡片级：
 * `heads`（好让网络图与统计板对每个亲属共享一次取数）
 * 以及下面那个模块级 `viewScroll` 台账。
 */
export function makeContextView(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
): (props: ContextViewProps) => ReactElement {
  const { t } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const TrendChart = makeTrendChart(kit)
  const RequestDetail = makeRequestDetail(kit, StackedBar)
  const EventList = makeEventList(kit)
  const FileCard = makeFileCard(kit, settings)
  // 一个页面级的冷头缓存同时服务两个子代理数据读者：
  // Agent network 卡片的组成环与统计板的子代理成本单元格，对每个亲属都只取一次。
  const heads = makeAgentHeads()
  const StatsContext = makeStatsContext(kit, makeSubagentCost(ctx, heads))
  const StatsTiming = makeStatsTiming(kit, Donut)
  const StatsTokens = makeStatsTokens(kit, Donut)
  const PluginInfo = makePluginInfo(kit)
  const UpgradeGate = makeUpgradeGate(kit)
  const DetailNote = makeDetailNote(kit)
  const ContextBrowser = makeContextBrowser(kit, StackedBar, settings)
  const AgentGraph = makeAgentGraph(ctx, kit, heads)
  const ErrorBoundary = makeErrorBoundary(t)

  function ContextViewBody(props: ContextViewProps): ReactElement {
    const sessionId = props.sessionId
    const inSidebar = props.host === 'sidebar'
    // 标签页与 /context 弹窗共享这份逐会话明细存储，所以已打开的标签页
    // 能直接服务该弹窗，无需重复取数。
    const source = useTimelineSource(props)
    const data = source.data
    // token-meter 的 `contextPressure`——聊天里那个环读的 key；缺失 → 派生兜底。
    const pressure = projectionOf(props, 'contextPressure', contextPressureOf)
    // token-meter 的 `tokenUsage`——聊天统计行读的同一份数据，所以数字按构造一致。
    const usage = projectionOf(props, 'tokenUsage', tokenUsageOf)
    // token-meter 的 `contextBreakdown`——聊天里那个环点击展开的面板所显示的同一批行。
    const breakdown = projectionOf(props, 'contextBreakdown', contextBreakdownOf)
    // 给上下文浏览器用的 `contextHeaders`（完整系统提示词 + 工具 schema）；较旧的 Host 半边缺失时 →
    // 只给 token 的分区，外加一条说明。
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = useState<number | null>(null)
    // 挂载时的默认值来自插件设置卡片；图表内的切换保持挂载本地，绝不写回。
    const [granularity, setGranularity] = useState<'step' | 'turn'>(() => settings.defaultGranularity())
    const [trendMode, setTrendMode] = useState<'total' | 'delta'>(() => settings.defaultTrendMode())
    // DNA 模式：每个请求上下文的逐项指纹（dna.ts）。
    const [dna, setDna] = useState(false)
    const [adaptive, setAdaptive] = useState(false)
    const [durationCurve, setDurationCurve] = useState(() => settings.defaultDurationCurve() === 'show')
    const [focusTurn, setFocusTurn] = useState<number | null>(null)
    const [jumpSeq, setJumpSeq] = useState<number | null>(null)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    const [focusCat, setFocusCat] = useState<string | null>(null)
    const [pickedKinds, setPickedKinds] = useState<string[]>([...EVENT_KINDS])
    const toggleKind = (k: string) => {
      setPickedKinds((p) => {
        if (p.length === EVENT_KINDS.length) return [k]
        if (!p.includes(k)) return [...p, k]
        return p.length === 1 ? [...EVENT_KINDS] : p.filter(x => x !== k)
      })
    }
    // 一次性揭示桥；`key` 是两个 DNA 表面共享的带 key（'sys' / 'tool:<name>' / 'n<seq>'）。
    const [nodeFocus, setNodeFocus] = useState<{ step: number | 'live'; key: string; cat: Category | 'system' | 'tools' } | null>(null)
    const clearNodeFocus = useCallback(() => { setNodeFocus(null) }, [])

    const loadImage = useMemo(
      () => imageLoaderOf(ctx, typeof sessionId === 'string' ? sessionId : undefined),
      [ctx, sessionId],
    )

    // 网关 page face 可能在首次渲染之后才落地（watch 重建会在 fiber
    // 重新触发之前重新挂载这个视图）：下面两个取数器必须在它落地或被撤销时重建。
    const historyFace = useHistoryFace()

    const fetchContent = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' && historyFace !== undefined
        ? makeContentFetcher(sessionId)
        : undefined),
      [sessionId, historyFace],
    )
    const fetchHeader = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' && historyFace !== undefined
        ? makeHeaderFetcher(sessionId)
        : undefined),
      [sessionId, historyFace],
    )

    const rootRef = useRef<HTMLDivElement | null>(null)
    const scrollerRef = useRef<HTMLElement | null>(null)
    // 本次挂载已经应用过位置的那个会话——在重渲染时重复应用会把读者的滚动位置拽走。
    const restoredRef = useRef<string | null>(null)
    const [catFocus, setCatFocus] = useState<CatFocus | null>(null)
    const clearCatFocus = useCallback(() => { setCatFocus(null) }, [])
    const onFigureClick = useCallback((figure: 'skills' | 'answers'): void => {
      setCatFocus(figure === 'skills' ? { cat: 'skill' } : { cat: 'assistant', kind: 'answer' })
      /** 统计卡片与浏览器卡片渲染在同一个
       * 视图里，所以目标在这里总能解析；留着这个守卫是为了与 revealAgents 保持防御性对齐。 */
      const browser = rootRef.current?.querySelector('.lc-col-browser') ?? null
      if (browser !== null) revealInScrollParent(browser)
      /* v8 ignore stop */
    }, [])

    // 在布局 effect 里恢复保存的位置，好让聊天那个底部锚定的位置永远不先闪一下。
    useLayoutEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '' || data === null) return
      if (restoredRef.current === sessionId) return
      restoredRef.current = sessionId
      /* 布局 effect 的函数体只在挂载期间运行，而且两条渲染路径都会挂上
         * rootRef，所以 null 那一支不可能触发。 */
      const scroller = rootRef.current !== null
        ? rootRef.current.closest('[data-conversation-scroll]')
        : null
      if (scroller === null) return
      scrollerRef.current = scroller as HTMLElement
      scroller.scrollTop = viewScroll.get(sessionId) ?? 0
    }, [sessionId, data])

    // 在布局 effect 的清理函数里保存位置，好让它在即将进入的视图的布局 effect 重新滚动共享容器之前先触发。
    useLayoutEffect(() => {
      return () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const scroller = scrollerRef.current
        if (scroller === null) return
        viewScroll.set(sessionId, scroller.scrollTop)
      }
    }, [sessionId])

    // 这里不做语言订阅：harness 的槽位出口在切换语言时会重新渲染每个入口，
    // 而套件里绑定的 `t` 在调用时读取当前语言。

    const requests = data ? data.requests : []
    const events = data ? data.events : []
    const counts = data?.counts ?? countsOfRecords(requests, events)
    // 只统计宿主真正记账的三种；model/mode 切换不携带计数。
    const kindCounts: Record<string, number | undefined> = { inject: counts.injects, compaction: counts.compactions, prune: counts.prunes }
    const shownEvents = pickedKinds.length === EVENT_KINDS.length ? events : events.filter(e => pickedKinds.includes(e.kind))
    // 逐步的柱子，或每轮一根（每轮「最后」一步的记录）；做了 memo，好让悬停驱动的重渲染保持柱子 props 身份稳定。
    const displayRequests = useMemo(
      () => (granularity === 'turn' ? aggregateByTurn(requests) : requests),
      [requests, granularity],
    )
    // 在「原始」步骤记录上统计——轮次模式的聚合读自己的 stepCount 而不读它。
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const markers = useMemo(() => attachMarkers(displayRequests, events), [displayRequests, events])
    // 每条显示出来的记录一次 assemble()——与浏览器用的是同一种纯重建——做了 memo，
    // 好让悬停驱动的重渲染永不重新组装。
    /* 缺失的 projection 会在趋势卡片
       * （及其 DNA 开关）渲染之前返回加载画面，所以 `dna && data === null` 不可能发生。 */
    const dnaBands = useMemo(
      () => (dna && data !== null ? displayRequests.map(req => trendBandsOf(assemble(data, headers, req.seq))) : null),
      [dna, data, headers, displayRequests],
    )
    const revealBand = useCallback((seq: number, band: { key: string; cat: Category | 'system' | 'tools' }): void => {
      setNodeFocus({ step: seq, key: band.key, cat: band.cat })
    }, [])

    // 聊天 → Context 跳转，第一步：每次挂载以及之后每一条记录时接住中继的请求（侧边栏
    // 落地后这个视图保持挂载）。
    useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const take = (): void => {
        const seq = takeContextFocus(sessionId)
        if (seq !== null) setJumpSeq(seq)
      }
      take()
      return subscribeContextFocus(take)
    }, [sessionId])

    // 第二步：中继过来的 seq 是该轮「最后」一条请求——正好是聚合出来的那条记录——所以跳转钉住那一根轮次柱；
    // 拆分代际的各集合还处在等待中时，这个一次性请求不能被消耗（它们落地时它会重新触发）。
    const detailReady = source.detailState === 'ready' || source.detailState === 'legacy'
    useEffect(() => {
      if (jumpSeq === null || data === null || !detailReady) return
      setJumpSeq(null)
      const target = jumpTargetOf(aggregateByTurn(requests), jumpSeq)
      if (target === null) return
      setGranularity('turn')
      setSelectedSeq(target.seq)
      setFocusTurn(target.turn ?? 0)
      /* 这个 effect 只在挂载期间触发，而且两条渲染路径都会挂上
         * rootRef 并渲染组成卡片。 */
      const anchor = rootRef.current?.querySelector('[data-lc-current]') ?? null
      if (anchor !== null) revealInScrollParent(anchor)
    }, [jumpSeq, data, requests, detailReady])

    const briefList = useMemo(() => (data ? briefNodes(data) : []), [data])
    const convNodes = conversationNodesOf(props)
    const bySeq = useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    let pinnedIdx = -1
    for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i].seq === selectedSeq) pinnedIdx = i
    const pinnedReq = pinnedIdx >= 0 ? displayRequests[pinnedIdx] : null
    let activeIdx = -1
    if (hoveredSeq !== null) {
      for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i].seq === hoveredSeq) { activeIdx = i; break }
    }
    if (activeIdx < 0) activeIdx = pinnedIdx
    if (activeIdx < 0 && displayRequests.length > 0) activeIdx = displayRequests.length - 1
    const activeReq = activeIdx >= 0 ? displayRequests[activeIdx] : null
    // 文件活动跟随同一根活动柱：这个「开区间」上界是下一条「原始」请求的 seq（被选中步骤自己的
    // 工具调用也算在内）；最后一根柱子的 null 上界则服务全部。
    let filesBefore: number | null = null
    if (activeReq !== null) {
      const ri = requests.findIndex(r => r.seq === activeReq.seq)
      filesBefore = ri + 1 < requests.length ? requests[ri + 1].seq : null
    }
    const brief = useMemo(
      () => (activeReq !== null ? briefOf(briefList, displayRequests, activeIdx) : null),
      [activeReq, briefList, displayRequests, activeIdx],
    )
    const convOf = useCallback((seq: number): ConversationNodeLike | undefined => bySeq.get(seq), [bySeq])

    // 只按这次遍历的输入做 memo：别处的悬停/选中渲染不会碰任何输入引用，所以这次遍历被跳过。
    const fileActivity = useMemo(
      () => {
        if (data !== null && data.fileOps !== undefined) {
          return activityOfOps(data.fileOps, data.archive, filesBefore)
        }
        return activityOf(briefList, convOf, filesBefore)
      },
      [data, briefList, convOf, filesBefore],
    )
    // 统计卡片的药丸计数；null 上界表示「整个」会话。
    const ioTotals = useMemo(
      () => {
        const totals = (data !== null && data.fileOps !== undefined
          ? activityOfOps(data.fileOps, data.archive, null)
          : activityOf(briefList, convOf, null)).totals
        return { reads: totals.read.ops, writes: totals.write.ops, searches: totals.search.ops, images: totals.image.ops }
      },
      [data, briefList, convOf],
    )
    const toolTally = useMemo(() => (data ? toolTallyOf(data.nodes) : []), [data])
    // 每次渲染都从可观察快照读取，好让下一次 projection 推送时用当前的工作区根重新渲染。
    const workspace = typeof ctx.get === 'function' ? workspaceOf(ctx, typeof sessionId === 'string' ? sessionId : undefined) : undefined
    // 这项能力是异步 RPC 的应答，所以在探测落定之前文件名不响应。
    const [canOpenPaths, setCanOpenPaths] = useState(false)
    useEffect(() => {
      let live = true
      void canOpenPathsOf(ctx).then((can) => { if (live) setCanOpenPaths(can) })
      return () => { live = false }
    }, [ctx])
    const fileOpener = useMemo(
      () => (canOpenPaths ? openPathVia(ctx) : undefined),
      [canOpenPaths, ctx],
    )
    // 这个标签页注册进去的预览列；face 每次调用都重新校验，所以一次 HMR 撤销不会留下过期的打开器。
    const previewOpener = useMemo(() => openResourceVia(ctx), [ctx])
    const sessionKey = typeof sessionId === 'string' ? sessionId : undefined
    const previewFile = useMemo(
      () => previewOpener === undefined
        ? undefined
        : (entry: FileEntry): boolean => {
          const address = previewAddressOf(entry.path, entry.form, entry.pattern, sessionKey, workspace)
          return address !== undefined && previewOpener(address)
        },
      [previewOpener, sessionKey, workspace],
    )
    const locateFileOp = useCallback((op: FileOp): void => {
      // 嵌套的 Code-Mode 操作没有自己的 surface 行——它揭示在父级 run_code 的结果上。
      const seq = op.parent ?? op.seq
      const step = locateStepOf(requests, seq, op.gone)
      if (step === null) return
      setNodeFocus({ step, key: 'n' + String(seq), cat: 'tool' })
    }, [requests])
    // 响应节点（seq === 请求自己的）最早出现在「下一步」的 surface 里，最后一根柱子上则出现在实时 surface。
    const locateNode = useCallback((node: SurfaceNode, isResponse: boolean): void => {
      /* locateNode 只接到 brief 行上，而
         * 同一个闭包里 brief !== null 已保证 activeReq !== null。 */
      if (activeReq === null) return
      const next = isResponse && activeIdx + 1 < displayRequests.length ? displayRequests[activeIdx + 1] : null
      const step: number | 'live' = isResponse ? (next !== null ? next.seq : 'live') : activeReq.seq
      setNodeFocus({ step, key: 'n' + String(node.seq), cat: node.cat })
    }, [activeReq, activeIdx, displayRequests])

    if (!data) {
      return (
        <div className="lc-root" ref={rootRef}>
          {source.detailState === 'failed'
            ? <DetailNote state="failed" onRetry={source.retryDetail} />
            : <div className="lc-empty">{t('loading')}</div>}
        </div>
      )
    }

    const markerOf = (req: RequestRecord): ContextEventRecord | undefined => {
      const i = displayRequests.indexOf(req)
      /** 唯一的调用方传入的是 displayRequests[activeIdx]，正是 indexOf 所扫描的数组里的一个元素。 */
      return i >= 0 ? markers[i] : undefined
    }

    // 按 provider 锚定的占用率：每 token 4 字符的启发式会把 CJK 少算约 10–15%，所以头条数字锚定在计费总量上。
    const head = headlineOf(data, pressure, breakdown)
    let fileScope = t('files.scopeLatest')
    if (activeReq !== null && filesBefore !== null) {
      fileScope = activeReq.stepCount !== undefined && activeReq.stepCount > 1
        ? t('detail.turn', { t: activeReq.turn ?? 0, n: activeReq.stepCount })
        : t('detail.step', { t: activeReq.turn ?? 0, s: activeReq.step ?? 0, n: stepsOf(activeReq.turn) })
    }

    // 轮次高亮只由悬停触发（条带悬停优先，然后是悬停柱所属的轮次）：没有兜底，所以钉住或
    // 默认选中永远不会发光。
    let activeTurn: number | null = hoverTurn
    if (activeTurn === null && hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) { activeTurn = req.turn ?? null; break }
    }

    // 镜像浏览器的共享类别悬停；overview 的 'free' key 被丢掉——它在图表与明细条里都没有对应分段。
    const trendHoverCat = hoverCat !== null && hoverCat !== 'free' ? hoverCat : null

    const localeSvc = ctx.get('locale')
    const activeLocale = localeSvc !== undefined && typeof localeSvc.getLocale === 'function'
      ? localeSvc.getLocale().active
      : 'en'
    const subtitle = (data.model ?? '') + (data.provider ? ' · ' + data.provider : '')
    const gate = unsupportedOf(data.unsupported)

    const compositionCard = (
      <CurrentComposition
        head={head}
        subtitle={subtitle}
        hoverKey={hoverCat}
        onHoverKey={setHoverCat}
      />
    )
    const trendCard = (
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('trend.title')}</span>
          <span className="lc-gran lc-trend-mods" role="group">
            <button
              type="button"
              className={'lc-gran-btn' + (dna ? ' lc-gran-on' : '')}
              title={t('trend.dnaTip')}
              onClick={() => { setDna(v => !v) }}
            >{t('trend.dna')}</button>
            <button
              type="button"
              className={'lc-gran-btn' + (adaptive ? ' lc-gran-on' : '')}
              title={t('trend.adaptiveHint')}
              onClick={() => { setAdaptive(on => !on) }}
            >{t('trend.adaptive')}</button>
            <button
              type="button"
              className={'lc-gran-btn' + (durationCurve ? ' lc-gran-on' : '')}
              title={t('trend.durationTip')}
              onClick={() => { setDurationCurve(on => !on) }}
            >{t('trend.duration')}</button>
          </span>
          <div className="lc-trend-ctl">
            <div className="lc-gran">
              <button
                className={'lc-gran-btn' + (granularity === 'step' ? ' lc-gran-on' : '')}
                onClick={() => { setGranularity('step') }}
              >{t('gran.step')}</button>
              <button
                className={'lc-gran-btn' + (granularity === 'turn' ? ' lc-gran-on' : '')}
                onClick={() => { setGranularity('turn') }}
              >{t('gran.turn')}</button>
            </div>
            <div className="lc-gran" title={t('gran.modeHint')}>
              <button
                className={'lc-gran-btn' + (trendMode === 'total' ? ' lc-gran-on' : '')}
                onClick={() => { setTrendMode('total') }}
              >{t('gran.total')}</button>
              <button
                className={'lc-gran-btn' + (trendMode === 'delta' ? ' lc-gran-on' : '')}
                onClick={() => { setTrendMode('delta') }}
              >{t('gran.delta')}</button>
            </div>
          </div>
        </div>
        {displayRequests.length === 0
          // 拆分代际，第一次明细读取还在等待或已失败：如实说明，而不是声称没有历史。
          ? (detailReady
            ? <div className="lc-empty">{t('trend.empty')}</div>
            : <DetailNote state={source.detailState === 'failed' ? 'failed' : 'loading'} onRetry={source.retryDetail} />)
          : (
            <div>
              <TrendChart
                // 逐会话重新挂载：重新锚定到最新的柱子上，而不是继承过期的滚动状态。
                key={sessionId}
                // 「全部」保留的请求（受宿主的 maxKeptTurns/maxRequestSteps 配置限制）：更早的轮次/步骤
                // 仍然可以滚到。
                requests={displayRequests}
                markers={markers}
                selectedSeq={pinnedReq ? pinnedReq.seq : null}
                hoveredSeq={hoveredSeq}
                activeTurn={activeTurn}
                granularity={granularity}
                mode={trendMode}
                focusTurn={focusTurn}
                hoverCat={trendHoverCat}
                focusCat={focusCat}
                adaptive={adaptive}
                durationCurve={durationCurve}
                dna={dnaBands}
                onPickBand={revealBand}
                onSelect={setSelectedSeq}
                onHover={setHoveredSeq}
                onHoverTurn={setHoverTurn}
                onPickTurn={(turn) => { setGranularity('turn'); setFocusTurn(turn) }}
                onFocusTurnHandled={() => { setFocusTurn(null) }}
              />
              <RequestDetail
                request={activeReq}
                // 增量模式把明细与图表据以取差的那条「同一条」上一条记录配对（第一根柱子：null）。
                prev={trendMode === 'delta' && activeIdx >= 0 ? (activeIdx > 0 ? displayRequests[activeIdx - 1] : null) : undefined}
                /** RequestDetail 只在 displayRequests.length > 0 时渲染，而上面的 activeIdx 兜底
                 * 就此逼出 activeReq 非 null。 */
                marker={activeReq !== null ? markerOf(activeReq) : undefined}
                brief={brief}
                convOf={convOf}
                stepsOf={stepsOf}
                onLocate={locateNode}
                hoverKey={trendHoverCat}
              />
            </div>
          )}
      </div>
    )
    const browserCard = (
      <ContextBrowser
        data={data}
        headers={headers}
        convNodes={convNodes}
        fetchContent={fetchContent}
        fetchHeader={fetchHeader}
        previewSeq={hoveredSeq}
        pinSeq={pinnedReq !== null ? pinnedReq.seq : null}
        hoverKey={hoverCat}
        onHoverKey={setHoverCat}
        onOpenCat={setFocusCat}
        nodeFocus={nodeFocus}
        onNodeFocusHandled={clearNodeFocus}
        loadImage={loadImage}
        detailState={source.detailState}
        onDetailRetry={source.retryDetail}
        catFocus={catFocus}
        onCatFocusHandled={clearCatFocus}
        // DNA 开关与趋势卡片共享：两个开关同步动作。
        dna={dna}
        onDnaChange={setDna}
      />
    )

    return (
      <div className="lc-root" ref={rootRef}>

        {inSidebar ? null : (
          <div className="lc-cols lc-head">
            <StatsContext counts={counts} humanInputs={data.humanInputs} answers={data.answers} toolCalls={data.toolCalls}
              files={ioTotals} tools={toolTally}
              cost={data.cost} locale={activeLocale} sessionId={typeof sessionId === 'string' ? sessionId : undefined}
              onFigureClick={onFigureClick} />
            <PluginInfo />
          </div>
        )}
        <div className="lc-cols lc-head">
          <StatsTokens usage={usage} current={data.current} breakdown={breakdown} />
          <StatsTiming timing={data.timing ?? null} spans={data.spans} />
        </div>

        <div className="lc-cols lc-cols-main">
          <div className="lc-col flex-1 min-w-[min(360px,100%)]">{compositionCard}{trendCard}</div>
          {/* 把浏览器卡片撑到左列的高度；/context 弹窗画自己那一摞，且高度随内容。 */}
          <div className="lc-col lc-col-browser flex-1 min-w-[min(360px,100%)]">{browserCard}</div>
        </div>

        <div className="lc-cols">
          <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)]">
            <div className="lc-card-title">
              <span className="lc-card-title-text">{t('events.title')}</span>
              <div className="lc-kinds @max-[380px]/lc-card:flex-wrap">
                {EVENT_KINDS.map((k) => {
                  const n = kindCounts[k]
                  return (
                    <button
                      key={k}
                      data-kind={k}
                      className={'lc-gran-btn' + (pickedKinds.includes(k) ? ' lc-gran-on lc-kind-' + k : '')}
                      onClick={() => { toggleKind(k) }}
                    >
                      {t('kind.' + k)}
                      {n !== undefined ? <span className="lc-kind-n">{kit.fmt(n)}</span> : null}
                    </button>
                  )
                })}
              </div>
            </div>
            <EventList events={shownEvents} state={source.detailState} onRetry={source.retryDetail} />
          </div>
          <FileCard activity={fileActivity} scope={fileScope} workspace={workspace}
            onPreview={previewFile} onOpen={fileOpener} onLocate={locateFileOp}
            state={source.detailState} onRetry={source.retryDetail} />
        </div>

        <AgentGraph
          sessionId={typeof sessionId === 'string' ? sessionId : undefined}
          self={{
            head,
            billed: usage !== null ? numOf(usage.uncachedInputTokens) + numOf(usage.outputTokens)
              + numOf(usage.cacheReadTokens) + numOf(usage.cacheWriteTokens) : null,
            requests: requests.length,
            costUsage: data.cost ?? null,
            durationMs: data.timing != null && data.timing.wallMs > 0 ? data.timing.wallMs : null,
          }}
        />

        <div className="lc-foot">{t('footer')}</div>

        {gate !== null && (
          <UpgradeGate sessionId={sessionId} current={gate.current} minimum={gate.minimum} />
        )}
      </div>
    )
  }

  return function ContextView(props: ContextViewProps): ReactElement {
    return h(ErrorBoundary, null, h(ContextViewBody, props))
  }
}
