/**
 * Agent 网络卡片——Context 标签页的底部：把当前 agent 的
 * 整个家族（祖先、兄弟、子代理）画成一张节点图，其中每个
 * 节点都是该会话自身上下文的实时卡片——标题、占用率，以及一条
 * 组成条——点击即跳到那个 agent 的会话。连线是从父节点
 * 脚部呈扇形展开的贝塞尔曲线，按一级家族着色；
 * 悬停某张卡片会点亮它的整条血脉（祖先与子树），
 * 下方的检查器则镜像出它的明细。
 *
 * 数据全程走在 harness 现有的平面上——会话列表
 * 快照（`ctx.sessions.list`：血脉行 + 逐会话的 projection
 * 值）以及标签页自己为当前节点持有的 projection。列表块
 * 只从宿主的 projection 缓存提供 projection 值，所以一个自上次
 * 时间线单元变化以来从未挂上的亲属只会列出压力信息
 * （有占用率、没有组成）；这些节点从插件的 `/api` 明细路由
 * 取自己的精简头部（agentHeads.ts——就是统计板的子代理成本单元格所读的
 * 同一个页面级缓存），然后带着组成重新渲染。
 * 没有对外 sessions 服务的 harness 会把
 * 这张卡片藏起来。
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { CATS } from '../categories'
import type { AgentHeads } from '../agentHeads'
import { makeAgentHeads, useSessionsSnapshot } from '../agentHeads'
import { billedTokensOf, estimateSessionCost, formatCost, type CostCurrency, type ModelBook } from '../cost'
import { useModelPrices } from '../modelPrices'
import { containHorizontalOverscroll } from '../overscroll'
import { openSessionVia, type ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'
import type { ContextTimeline } from '../../shared/types'
import type { AgentNode, AgentSelfStats } from '../agentTree'
import {
  agentForestOf,
  barSegments,
  fmtDurationCompact,
  layoutForest,
  lineageOf,
  pressureColorOf,
  sessionsFaceOf,
} from '../agentTree'

/** 卡片的输入；`self` 携带当前会话来自标签页自身
 *  projection 的实时统计，而快照行无法为正在查看的这个会话提供这些。 */
export interface AgentGraphProps {
  sessionId?: string
  /** 当前会话来自标签页自身 projection 的实时统计。 */
  self?: AgentSelfStats
}

/** 卡片及其横条分段的入场错开上限（沿用 stackedBar 那套做法）。 */
const STAGGER_CAP = 8

/** 连线的 S 形曲线：两端卡片边缘处切线竖直，曲率与落差成正比，夹在 [24, 96]。 */
function linkPath(x1: number, y1: number, x2: number, y2: number): string {
  const k = Math.min(96, Math.max(24, (y2 - y1) * 0.5))
  return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`
}

/**
 * 绑定 `ctx`、`kit` 与共享的页面级冷头缓存，返回这张网络卡片。
 * 缓存作为参数传入（默认新建一个），好让统计板的子代理成本单元格
 * 与这张图共享同一批取数；harness 没有对外 sessions 服务时
 * 卡片渲染 null。
 */
export function makeAgentGraph(
  ctx: ClientCtx,
  kit: ViewKit,
  /** 共享的页面级冷头缓存——统计板的子代理成本单元格读的是同一批取数。 */
  heads: AgentHeads = makeAgentHeads(),
): (props: AgentGraphProps) => ReactElement | null {
  const { t, fmt, catLabel } = kit

  /** 展示货币跟随当前语言——每次渲染都读：槽位出口在切换语言时会重新渲染。 */
  function activeCurrency(): CostCurrency {
    const locale = ctx.locale
    return typeof locale.getLocale === 'function' && locale.getLocale().active === 'zh' ? 'cny' : 'usd'
  }

  function AgentGraph(props: AgentGraphProps): ReactElement | null {
    // 在挂载时惰性解析（而不是在 apply 时）：对外 sessions 服务属于客户端运行时
    // 的组装，没有它的部署就让这张卡片保持隐藏。
    const face = useMemo(() => sessionsFaceOf(ctx), [])
    const snapshot = useSessionsSnapshot(face)
    const sessionId = props.sessionId
    const [hoverId, setHoverId] = useState<string | null>(null)
    // 共享的价目表（统计板自己的 store）：卡片的成本估算
    // 等价目表落地后才出现，且从不阻塞卡片的其余部分。
    const { book } = useModelPrices()
    const currency = activeCurrency()

    // 布局是完全自适应的：只要舞台可见宽度变化就重跑一次
    // （侧边栏开关、窗口缩放、分屏）。
    const stageRef = useRef<HTMLDivElement | null>(null)
    const [stageWidth, setStageWidth] = useState(0)
    useEffect(() => {
      /* jsdom 既没有 ResizeObserver 也没有布局；测试走自然间距的兜底路径（stageWidth 0）。 */
      const el = stageRef.current
      if (el === null || typeof ResizeObserver !== 'function') return
      // 用 contentRect 而不是 clientWidth：舞台两侧那 4px 内边距是给
      // 悬停阴影留的呼吸空间，按 clientWidth 定性会让内容盒恰好超出
      // 这么多——只要布局刚好装下，就会凭空多出一条横向滚动条。
      const observer = new ResizeObserver(([entry]) => { setStageWidth(entry.contentRect.width) })
      observer.observe(el)
      return () => { observer.disconnect() }
      /* v8 ignore stop */
    }, [])
    // 横向滑动跑到舞台边缘之外时，绝不能链接进浏览器的历史导航
    // （overscroll.ts）：sheet 的 overscroll-behavior-x 覆盖 Chromium/Firefox，这里补上 WebKit。
    useEffect(() => {
      const el = stageRef.current
      /* 卡片渲染时舞台就渲染，而 React
         在 effect 运行之前挂上 ref；这里 el 永远不是 null。 */
      if (el === null) return
      return containHorizontalOverscroll(el)
    }, [])

    // 每个会话只发现一次当前会话的直系子目录：
    // 由目录推导出的子节点会加入列表行（并获得导航
    // 地址）。发后即忘——卡片单靠列表行就能渲染。
    useEffect(() => {
      if (face === null || typeof sessionId !== 'string' || sessionId === '') return
      if (typeof face.refreshSubagents !== 'function') return
      face.refreshSubagents(sessionId).catch(() => {})
    }, [face, sessionId])

    // 为冷亲属取回的组成头部（见下面的 effect）：
    // 落地的值会把该行缺失的 `contextTimeline` 注入后重新折叠成森林。
    const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())

    const built = useMemo(() => {
      const forest = agentForestOf(snapshot, sessionId, props.self, landed)
      return forest !== null ? { forest, layout: layoutForest(forest, stageWidth) } : null
    }, [snapshot, sessionId, props.self, stageWidth, landed])

    // 没有组成的节点（只有占用率，或压根没被列出——
    // 两种情况投影缓存里都没有时间线行）从明细路由（共享的
    // 页面级缓存）取自己的精简头部，然后带着组成重新渲染。
    // 当前节点被排除在外：标签页自己的 projection
    // 已经在实时喂它。一次重新挂载（切换标签页）会重置这个 state，但不会
    // 重置缓存，所以一次缓存读取会「重放」进新实例——
    // 否则取回来的亲属会在每次重新挂载时又退回绿色，永远如此。
    useEffect(() => {
      if (built === null) return
      const attach = (pending: Promise<ContextTimeline | null>, id: string): void => {
        void pending.then((head) => {
          // 同一个值 → 同一个 state：这个身份退让让每次快照跳动上的已落定重放不会成环。
          if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
        }).catch(() => {})
      }
      for (const n of built.forest.nodes) {
        if (n.isCurrent || (n.head !== null && n.head.parts.length > 0)) continue
        attach(heads.headOf(n.id), n.id)
      }
    }, [built, heads])

    if (built === null) return null
    const { forest, layout } = built
    const byId = new Map(forest.nodes.map(n => [n.id, n]))
    /** agentForestOf 把森林锚定在当前会话上，所以当前节点必定存在。 */
    const current = forest.nodes.find(n => n.isCurrent) ?? forest.nodes[0]
    const inspected = (hoverId !== null ? byId.get(hoverId) : undefined) ?? current
    const runningCount = forest.nodes.filter(n => n.running).length
    let totalTokens = 0
    for (const n of forest.nodes) totalTokens += n.head !== null ? n.head.tokens : 0

    // 被悬停卡片的血脉（祖先链 + 自己的子树）点亮它的连线；其余变暗。
    const lit = lineageOf(forest, hoverId)

    const open = (id: string): void => {
      if (id === current.id) return
      openSessionVia(ctx, id)
    }
    const keyOpen = (id: string) => (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      open(id)
    }

    return (
      <div className="lc-card lc-agents">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('agents.title')}</span>
          <span className="lc-card-sub">{t('agents.sub')}</span>
        </div>

        <div className="lc-agents-chips">
          <span className="lc-agents-chip">{t('agents.chip.count', { n: forest.nodes.length + forest.overflow })}</span>
          <span className={'lc-agents-chip' + (runningCount > 0 ? ' lc-agents-chip-on' : '')}>
            {t('agents.chip.running', { n: runningCount })}
          </span>
          {totalTokens > 0
            ? <span className="lc-agents-chip">{t('agents.chip.tokens', { n: fmt(totalTokens) })}</span>
            : null}
          {forest.overflow > 0
            ? <span className="lc-agents-chip">{t('agents.more', { n: forest.overflow })}</span>
            : null}
        </div>

        <div className="lc-agents-stage" ref={stageRef}>
          <div className="lc-agents-canvas" style={{ width: layout.width, height: layout.height }}>
            <svg
              className={'lc-agents-links' + (lit !== null ? ' lc-agents-focus' : '')}
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
            >
              {layout.links.map((link) => {
                const d = linkPath(link.x1, link.y1, link.x2, link.y2)
                const on = lit !== null && lit.has(link.to)
                return (
                  <g key={link.to} className={on ? 'lc-agents-on' : undefined}>
                    <path
                      className={'lc-agents-link stroke-[1.5px]' + (link.running ? ' lc-agents-link-live' : '')}
                      d={d}
                      stroke={link.color}
                      fill="none"
                    />
                    {link.running
                      ? <path className="lc-agents-flow animate-lc-agent-flow fill-none stroke-2" d={d} stroke={link.color} />
                      : null}
                    <circle className="lc-agents-joint" cx={link.x1} cy={link.y1} r={2} fill={link.color} />
                    <circle className="lc-agents-joint" cx={link.x2} cy={link.y2} r={3} fill={link.color} />
                  </g>
                )
              })}
            </svg>
            {forest.nodes.map((node, index) => {
              const point = layout.points.find(p => p.id === node.id)
              /** layoutForest 会为每一个森林节点定位，所以这次查找绝不会落空。 */
              if (point === undefined) return null
              return (
                <AgentCard
                  key={node.id}
                  node={node}
                  x={point.x}
                  y={point.y}
                  width={layout.cardW}
                  index={index}
                  hovered={hoverId === node.id}
                  onHover={setHoverId}
                  onOpen={open}
                  onKeyOpen={keyOpen(node.id)}
                  book={book}
                  currency={currency}
                  t={t}
                  fmt={fmt}
                />
              )
            })}
          </div>
        </div>

        {forest.solo ? <div className="lc-empty lc-agents-solo">{t('agents.solo')}</div> : null}

        <Inspector node={inspected} t={t} fmt={fmt} catLabel={catLabel} />
        <div className="lc-agents-legend">
          {CATS.map(c => (
            <span key={c.key} className="lc-agents-legend-item">
              <i style={{ background: c.color }} />
              {catLabel(c.key)}
            </span>
          ))}
          <span className="lc-agents-legend-item">
            <i className="lc-agents-legend-free" />
            {t('agents.legend.free')}
          </span>
          <span className="lc-agents-legend-item">
            <i className="lc-agents-legend-edge" />
            {t('agents.running')}
          </span>
        </div>
      </div>
    )
  }

  return AgentGraph
}

/** 一张已安放的 agent 卡片：它的画布锚点、它的入场槽位，以及悬停/打开中继。 */
interface CardProps {
  node: AgentNode
  /** 卡片中心 x 与顶部 y，以画布坐标计；卡片盒由它们推出。 */
  x: number
  y: number
  width: number
  /** DFS 顺序——入场错开的槽位。 */
  index: number
  hovered: boolean
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
  onKeyOpen: (ev: KeyboardEvent) => void
  /** 成本估算所用的价目表与展示货币（book 为 null → 不显示估算）。 */
  book: ModelBook | null
  currency: CostCurrency
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

/** 一个节点卡片。`consumed` 优先取 tokenUsage 计数，缺失时退回 fold 自己的
 *  成本台账，因为一个冷亲属可能只携带其中之一；当前节点上的点击不响应，
 *  它也是唯一一个不带 button role 渲染的节点。 */
function AgentCard(props: CardProps): ReactElement {
  const { node, x, y, width } = props
  const pct = node.head !== null ? node.head.pct : null
  const segs = node.head !== null ? barSegments(node.head.parts, pct, pressureColorOf(pct)) : []
  // 头条数字是这个 agent 的「消耗量」：tokenUsage 计数，
  // 计数缺失（冷亲属）时由 fold 自己的成本台账顶上。
  const consumed = node.billed !== null && node.billed > 0 ? node.billed
    : node.costUsage !== null ? billedTokensOf(node.costUsage) : null
  const cost = estimateSessionCost(node.costUsage, props.book, props.currency)
  const metricBits: string[] = []
  if (consumed !== null && consumed > 0) metricBits.push(props.fmt(consumed))
  if (cost !== null) metricBits.push(formatCost(cost, props.currency))
  // 活动页脚：本次运行的时长，然后是它的步骤数。任一项都可能缺失——
  // 从未运行过的节点没有步骤，冷节点则还没有计时。
  const meta: string[] = []
  if (node.durationMs !== null) meta.push(fmtDurationCompact(node.durationMs))
  if (node.requests > 0) meta.push(props.t('agents.steps', { n: node.requests }))
  const cls = 'lc-agent-card animate-lc-agent-in motion-reduce:animate-none'
    + (node.isCurrent ? ' lc-agent-self' : '')
    // lc-agent-hover 自身不携带任何规则——悬停/聚焦的底色走
    // `:hover`/`:focus-visible`；这个类留作测试的状态锚点。
    + (props.hovered ? ' lc-agent-hover' : '')
    + (node.isCurrent ? '' : ' lc-agent-clickable')
  return (
    <div
      className={cls}
      style={{ left: x - width / 2, top: y, width, '--lc-i': Math.min(props.index, STAGGER_CAP) } as CSSProperties}
      data-agent={node.id}
      role={node.isCurrent ? undefined : 'button'}
      tabIndex={node.isCurrent ? undefined : 0}
      onClick={() => { props.onOpen(node.id) }}
      onKeyDown={props.onKeyOpen}
      onMouseEnter={() => { props.onHover(node.id) }}
      onMouseLeave={() => { props.onHover(null) }}
      onFocus={() => { props.onHover(node.id) }}
      onBlur={() => { props.onHover(null) }}
    >
      <div className="lc-agent-card-head">
        {node.running || node.completed
          ? <StateDot state={node.running ? 'ongoing' : 'done'} size={11} className="lc-agent-state" />
          : null}
        <div className="lc-agent-label">{node.label}</div>
        {/* 徽标坐在被夹住的标签「外面」：内联徽标在
            长标题占满两行时会被裁掉。lc-agent-self-badge 这个类自身不携带
            任何规则——它留作测试中自身标记的锚点。 */}
        {node.isCurrent ? <span className="lc-agents-badge lc-agent-self-badge">{props.t('agents.self')}</span> : null}
      </div>
      <div className="lc-agent-metric">
        <b className="lc-agent-tokens">{metricBits.length > 0 ? metricBits.join(' · ') : '—'}</b>
      </div>
      {/* 空闲的余量就是横条自己的轨道，所以只渲染已占用的分段。 */}
      <div className="lc-agent-bar">
        {segs.filter(seg => !seg.free).map((seg, i) => (
          <i
            key={seg.key}
            className="lc-agent-bar-seg animate-lc-stacked-in motion-reduce:animate-none"
            style={{ width: `${seg.share * 100}%`, background: seg.color, '--lc-i': Math.min(i, STAGGER_CAP) } as CSSProperties}
          />
        ))}
      </div>
      {meta.length > 0 || pct !== null ? (
        <div className="lc-agent-meta">
          <span className="lc-agent-meta-text">{meta.join(' · ')}</span>
          {pct !== null ? <span className="lc-agent-pct" style={{ color: pressureColorOf(pct) }}>{pct}%</span> : null}
        </div>
      ) : null}
    </div>
  )
}

/** 镜像被悬停（或当前）节点的明细条：身份、占用率、活动、组成，以及打开提示。 */
function Inspector(props: { node: AgentNode; t: ViewKit['t']; fmt: ViewKit['fmt']; catLabel: ViewKit['catLabel'] }): ReactElement {
  const { node, t, fmt, catLabel } = props
  const bits: string[] = []
  if (node.head !== null) {
    const head = node.head
    const window = head.window !== undefined ? ` / ${fmt(head.window)}` : ''
    const pct = head.pct !== null ? ` · ${head.pct}%` : ''
    bits.push(`${fmt(head.tokens)}${window}${pct}`)
  }
  if (node.requests > 0) bits.push(t('agents.steps', { n: node.requests }))
  if (node.billed !== null && node.billed > 0) bits.push(t('agents.billed', { n: fmt(node.billed) }))
  if (node.durationMs !== null) bits.push(fmtDurationCompact(node.durationMs))
  const parts = node.head !== null ? node.head.parts.filter(p => (p.raw ?? p.value) > 0) : []
  let rawTotal = 0
  for (const p of parts) rawTotal += p.raw ?? p.value
  return (
    <div className="lc-agents-inspector">
      <div className="lc-agents-inspector-row">
        <b className="lc-agents-inspector-name">{node.label}</b>
        {node.isCurrent ? <span className="lc-agents-badge">{t('agents.self')}</span> : null}
        {node.running ? <span className="lc-agents-badge lc-agents-badge-on">{t('agents.running')}</span> : null}
        {node.identity !== null
          ? <span className="lc-agents-badge">{t(node.identity.mode === 'one-shot' ? 'agents.oneshot' : 'agents.continuable')}</span>
          : null}
        <span className="lc-agents-inspector-stats">{bits.join(' · ')}</span>
        {!node.isCurrent ? <span className="lc-agents-inspector-open">{t('agents.open')}</span> : null}
      </div>
      {parts.length > 0 ? (
        <div className="lc-agents-inspector-parts">
          {parts.map((p) => {
            const count = p.raw ?? p.value
            return (
              <span key={p.key} className="lc-agents-part">
                <i style={{ background: p.color }} />
                {catLabel(p.key)}
                <em>{`≈${fmt(count)} (${Math.round(count / rawTotal * 100)}%)`}</em>
              </span>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
