/** Context 卡片：只讲计数——比例住在组成卡片上，事件行住在 events
 * 卡片上，token 数字住在 Token 卡片上。计数是预先算好的（拆分代际的 wire
 * 头部，或内联代际上的 `countsOfRecords`）；这张卡片从不触碰那些集合。 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, ContextTimeline, RequestRecord, SessionCostUsage, SurfaceNode, TimelineCounts } from '../../shared/types'
import { billedTokensOf, mergeCostUsage } from '../cost'
import { sessionsFaceOf, subagentCostFoldOf } from '../agentTree'
import type { AgentHeads } from '../agentHeads'
import { useSessionsSnapshot } from '../agentHeads'
import { revealInScrollParent } from '../revealScroll'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'

/** 构造出与宿主拆分代际头部所携带的同一份计数，好让内联代际
 * 与远程代际无法互相矛盾。`steps` 是请求数，`turns` 是去重后的轮次
 * 编号（没有编号的轮次折成 0），技能则按 inject 事件的
 * `sub: 'skill'` 标记计数，而不是按任何节点形状。
 */
export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  // 已加载的技能：带 skill 标记的 inject 事件中那些去重的名字——即宿主 fold 的确切标记集合
  // （`/name` 调用与 `skill` 工具加载上的 `sub: 'skill'`；目录摘要走未标记的事件）。
  const skills = new Set<string>()
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
    if (ev.sub === 'skill' && typeof ev.name === 'string' && ev.name !== '') skills.add(ev.name)
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes, skills: skills.size }
}

/** usage 为 null = 没有任何上报（没有子代理、没有用量，或这个 harness 上还没有 sessions face）。 */
export interface SubagentStats {
  usage: SessionCostUsage | null
  count: number
}

/**
 * 一个 hook 工厂：它返回的是那个逐会话 hook 本身，所以卡片可以在渲染顺序中
 * 无条件调用它，而由调用方决定闭包捕获哪个 `ctx`/`heads`。
 * `landed` 映射按 id 缓存冷读来的头部，而 set 上的身份检查让
 * 已落定的重放不会在每次快照跳动时都重新渲染。
 */
export function makeSubagentCost(
  ctx: ClientCtx,
  heads: AgentHeads,
): (sessionId: string | undefined) => SubagentStats {
  return function useSubagentCost(sessionId: string | undefined): SubagentStats {
    const face = useMemo(() => sessionsFaceOf(ctx), [])
    const snapshot = useSessionsSnapshot(face)
    const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())
    const fold = useMemo(
      () => subagentCostFoldOf(snapshot, sessionId, landed),
      [snapshot, sessionId, landed],
    )
    // 同一个值 → 同一个 state：这个身份退让让每次快照跳动上的已落定重放不会成环。
    useEffect(() => {
      for (const id of fold.cold) {
        void heads.headOf(id).then((head) => {
          if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
        }).catch(() => {})
      }
    }, [fold, heads])
    return { usage: fold.usage, count: fold.count }
  }
}

/** 流程图里的五个盒子，按图例虚线行进的顺序排列；布局在测量之前
 *  把它们切成左/中/右三列。 */
type FlowNodeKey = 'inputs' | 'events' | 'session' | 'tools' | 'cost'

const FLOW_NODES: readonly FlowNodeKey[] = ['inputs', 'events', 'session', 'tools', 'cost']

/** 以根为参照的节点盒坐标，由布局 effect 测出。 */
interface FlowBox { x: number; y: number; w: number; h: number }

/** 一条缎带：它的 SVG 路径与描边颜色。 */
interface FlowLink { d: string; color: string }

/** 某个盒子边缘上的锚点：那个点，以及曲线控制点所遵循的
 *  向外法线（好让缎带垂直于它所接触的边缘离开与到达）。 */
interface Anchor { x: number; y: number; dx: number; dy: number }

/** 必须与 stats.css 里的 `@container lc-card (max-width: …)` 规则一致：流程图根节点填满卡片的
 * content box，所以 `clientWidth` 的读取与 CSS 查询在折叠模式上永远不会互相矛盾。 */
const FLOW_FOLD_PX = 559

/** 流程拓扑；刻意做成非守恒的——无论背后的计数多少，每条缎带宽度都一样。 */
const FLOW_LINKS: readonly { from: FlowNodeKey; to: FlowNodeKey; fromAt: number; toAt: number; color: string }[] = [
  { from: 'inputs', to: 'session', fromAt: 0.5, toAt: 1 / 3, color: 'var(--color-green-500)' },
  { from: 'events', to: 'session', fromAt: 0.5, toAt: 2 / 3, color: 'var(--color-purple-500)' },
  { from: 'session', to: 'tools', fromAt: 1 / 3, toAt: 0.5, color: 'var(--color-teal-500)' },
  { from: 'session', to: 'cost', fromAt: 2 / 3, toAt: 0.5, color: 'var(--color-pink-500)' },
]

const EVENT_PILLS: readonly { kind: 'inject' | 'compaction' | 'prune'; tally: 'injects' | 'compactions' | 'prunes'; cls: string }[] = [
  { kind: 'inject', tally: 'injects', cls: 'lc-kind-inject' },
  { kind: 'compaction', tally: 'compactions', cls: 'lc-kind-compaction' },
  { kind: 'prune', tally: 'prunes', cls: 'lc-kind-prune' },
]

/** 用宿主自己的判定（fold.ts 的 `toolCalls`）在实时表面上折叠，所以这些药丸相加起来
 * 按构造就等于头部的 `toolCalls` 数字，只减去 fold 没有给它盖上名字的那些结果。 */
export function toolTallyOf(nodes: readonly SurfaceNode[]): [string, number][] {
  const tally = new Map<string, number>()
  for (const n of nodes) {
    if (n.cat !== 'tool' && !(n.cat === 'skill' && n.tool !== undefined)) continue
    if (typeof n.tool !== 'string' || n.tool === '') continue
    tally.set(n.tool, (tally.get(n.tool) ?? 0) + 1)
  }
  return [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

/** 卡片的输入。一切都由调用方预先算好（拆分代际的头部，或
 *  内联的 `countsOfRecords`），而可选的 `onFigureClick` 正是让技能与
 *  回答这两个数字可交互的东西。 */
interface StatsContextProps {
  counts: TimelineCounts
  humanInputs?: number
  answers?: number
  onFigureClick?: (figure: 'skills' | 'answers') => void
  toolCalls?: number
  files: { reads: number; writes: number; searches: number; images: number }
  tools: readonly (readonly [string, number])[]
  cost?: SessionCostUsage
  locale: string
  sessionId?: string
}

/** 盒子边缘上位于比例 `at` 处的点，连同它那一侧蕴含的向外法线。 */
function flowAnchor(box: FlowBox, side: 'left' | 'right' | 'top' | 'bottom', at: number): Anchor {
  switch (side) {
    case 'left': return { x: box.x, y: box.y + box.h * at, dx: -1, dy: 0 }
    case 'right': return { x: box.x + box.w, y: box.y + box.h * at, dx: 1, dy: 0 }
    case 'top': return { x: box.x + box.w * at, y: box.y, dx: 0, dy: -1 }
    case 'bottom': return { x: box.x + box.w * at, y: box.y + box.h, dx: 0, dy: 1 }
  }
}

/** 一条三次曲线，其终点控制点落在 `b + normal·k`，因此路径是「朝节点内部」到达的。 */
export function flowCurve(a: Anchor, b: Anchor): string {
  const k = Math.max(18, (a.dx !== 0 ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) / 2)
  return `M ${a.x} ${a.y} C ${a.x + a.dx * k} ${a.y + a.dy * k} ${b.x + b.dx * k} ${b.y + b.dy * k} ${b.x} ${b.y}`
}

/** 源接在自己的后缘、目标接在自己的前缘：会话节点既是
 * 左/上这一对的目标，又是右/下这一对的源，所以一对朝向就能服务两种模式。 */
export function measureFlow(boxes: Record<FlowNodeKey, FlowBox>, horizontal: boolean): FlowLink[] {
  const fromSide = horizontal ? 'right' as const : 'bottom' as const
  const toSide = horizontal ? 'left' as const : 'top' as const
  return FLOW_LINKS.map(link => ({
    d: flowCurve(flowAnchor(boxes[link.from], fromSide, link.fromAt), flowAnchor(boxes[link.to], toSide, link.toAt)),
    color: link.color,
  }))
}

/**
 * 绑定 `kit` 与注入的 subagent-cost hook。`useSubagentCost` 走参数
 * 而不是 import，是为了让卡片及其测试能在一个伪造的 sessions face 上注入 hook，
 * 而真实的那个仍在同一次渲染中运行。
 */
export function makeStatsContext(
  kit: ViewKit,
  useSubagentCost: (sessionId: string | undefined) => SubagentStats,
): (props: StatsContextProps) => ReactElement {
  const { t, fmt } = kit
  return function StatsContext(props: StatsContextProps): ReactElement {
    const sub = useSubagentCost(props.sessionId)
    const subUsage = sub.usage
    const usage = mergeCostUsage(props.cost, subUsage) ?? undefined
    // 一个无依赖的布局 effect 在每次渲染后重新测量（同字符串的退让让它不成环）；
    // ResizeObserver 的跳动则覆盖窗格拖拽——那不会改变任何 prop。
    const flowRef = useRef<HTMLDivElement | null>(null)
    // `nodeRef` 写入一个由 ref 持有的映射，而不是一个 state 对象：那个映射
    // 在渲染之间不能改变身份，而下面的布局 effect 会直接读它。
    const nodeEls = useRef(new Map<FlowNodeKey, HTMLDivElement>())
    const [links, setLinks] = useState<FlowLink[]>([])
    const [, setResizeTick] = useState(0)
    const nodeRef = (key: FlowNodeKey) => (el: HTMLDivElement | null): void => {
      if (el === null) nodeEls.current.delete(key)
      else nodeEls.current.set(key, el)
    }
    useLayoutEffect(() => {
      const root = flowRef.current
      /* 这个 effect 只在挂载期间运行，而卡片总会渲染流程图的根节点。 */
      if (root === null) return
      const rootBox = root.getBoundingClientRect()
      const boxes = {} as Record<FlowNodeKey, FlowBox>
      for (const key of FLOW_NODES) {
        /* 五个节点在这个布局 effect 之前就已渲染，所以每个 key 都能解析。 */
        const el = nodeEls.current.get(key)
        if (el === undefined) return
        /* v8 ignore stop */
        const r = el.getBoundingClientRect()
        boxes[key] = { x: r.left - rootBox.left, y: r.top - rootBox.top, w: r.width, h: r.height }
      }
      const next = measureFlow(boxes, root.clientWidth > FLOW_FOLD_PX)
      // 宽度在 `FLOW_FOLD_PX` 处切换折叠模式，所以一次重新测量常常落到
      // 同一组缎带上；设置之前先比较，能让这种空操作不触发重渲染。
      setLinks(prev => (prev.length === next.length && prev.every((l, i) => l.d === next[i].d && l.color === next[i].color) ? prev : next))
    })
    /* jsdom 既没有 ResizeObserver 也没有布局：测试通过 measureFlow 的单元测试固定几何。 */
    useEffect(() => {
      const root = flowRef.current
      if (root === null || typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(() => { setResizeTick(tick => tick + 1) })
      observer.observe(root)
      return () => { observer.disconnect() }
    }, [])
    /* v8 ignore stop */
    const head = (label: string, total: ReactNode, tip?: ReactNode, href?: string): ReactElement => {
      const body = (
        <>
          <span className="lc-flow-label">
            {label}
            {tip !== undefined && <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>}
          </span>
          <b className="lc-flow-total">{total}</b>
          {tip !== undefined && <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{tip}</span>}
        </>
      )
      const className = 'lc-flow-head' + (tip === undefined ? '' : ' lc-stat-tipped group/tip')
      return href === undefined
        ? <div className={className}>{body}</div>
        : <a className={className} href={href} target="_blank" rel="noreferrer noopener">{body}</a>
    }
    const pill = (label: string, value: number, cls = '', tip?: ReactNode): ReactElement => (
      <span key={label} className={'lc-flow-pill' + cls + (value === 0 ? ' lc-flow-pill-dim' : '') + (tip === undefined ? '' : ' lc-stat-tipped group/tip')}>
        <span className="lc-flow-pill-label">
          {label}
          {tip !== undefined && <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>}
        </span>
        <b>{fmt(value)}</b>
        {tip !== undefined && <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{tip}</span>}
      </span>
    )
    const onFigureClick = props.onFigureClick
    const figure = (key: 'skills' | 'answers', value: number, label: string, tip: string): ReactElement => (
      <span
        key={key}
        role={onFigureClick === undefined ? undefined : 'button'}
        tabIndex={onFigureClick === undefined ? undefined : 0}
        className={'lc-flow-kv' + (onFigureClick === undefined ? '' : ' lc-flow-kv-btn')}
        title={onFigureClick === undefined ? undefined : tip}
        onClick={onFigureClick === undefined ? undefined : () => { onFigureClick(key) }}
        onKeyDown={onFigureClick === undefined ? undefined : (ev: KeyboardEvent) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return
          ev.preventDefault()
          onFigureClick(key)
        }}
      >
        <b>{fmt(value)}</b>
        <i>{label}</i>
      </span>
    )
    // 这张卡只讲 token：金额属于费用那一段（平台卡与明细表），
    // 在同一张卡里并排「token / 金额」会让读者以为两者可以跨界比较。
    const familyTokens = billedTokensOf(usage)
    const ownTokens = billedTokensOf(props.cost)
    const subTokens = billedTokensOf(subUsage)
    const revealAgents = (): void => {
      // agents 列表是页面别处的一张兄弟卡片，通过共享的
      // `.lc-root` 抵达；尚不存在的滚动父级会让这一步成为空操作。
      const agents = flowRef.current?.closest('.lc-root')?.querySelector('.lc-agents') ?? null
      if (agents !== null) revealInScrollParent(agents)
    }
    const onTeamClick = (ev: MouseEvent): void => {
      if ((ev.target as HTMLElement).closest('a') !== null) return
      revealAgents()
    }
    const onTeamKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      revealAgents()
    }
    const ioTotal = (props.humanInputs ?? 0) + props.files.reads + props.files.writes + props.files.searches + props.files.images
    // 头部的实时计数；在太旧、承载不了它的宿主上，退回用药丸自己的求和。
    const toolTotal = props.toolCalls ?? props.tools.reduce((sum, [, n]) => sum + n, 0)
    const topTools = props.tools.slice(0, 3)
    const moreTools = props.tools.length - topTools.length
    return (
      <div className="lc-card flex-[3] min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
        </div>
        <div className="lc-stats lc-flow" ref={flowRef}>
          {/* 在节点下方；按左→右 / 上→下排序，好让行进的虚线按流向读。 */}
          <svg className="lc-flow-svg" aria-hidden="true">
            {links.map((l, i) => (
              // 固定四条链接、固定顺序：下标「就是」身份（零测量的盒子会产生相同的 d 字符串）。
              <g key={i}>
                <path className="lc-flow-ribbon" d={l.d} stroke={l.color} />
                <path className="lc-flow-dash animate-lc-agent-flow motion-reduce:animate-none" d={l.d} stroke={l.color} />
              </g>
            ))}
          </svg>
          <div className="lc-flow-col">
            <div className="lc-flow-node" ref={nodeRef('inputs')}>
              {head(t('stats.io'), fmt(ioTotal))}
              {/* 搜索与图片读取只在真的发生过时才出现药丸；三个零计数则始终可见。 */}
              <div className="lc-flow-pills">
                {pill(t('stats.humanInputs'), props.humanInputs ?? 0, '', t('stats.humanInputsTip'))}
                {pill(t('files.kind.read'), props.files.reads)}
                {pill(t('files.kind.write'), props.files.writes)}
                {props.files.searches > 0 ? pill(t('files.kind.search'), props.files.searches) : null}
                {props.files.images > 0 ? pill(t('files.kind.image'), props.files.images) : null}
              </div>
            </div>
            <div className="lc-flow-node" ref={nodeRef('events')}>
              {head(t('stats.events'), fmt(props.counts.injects + props.counts.compactions + props.counts.prunes))}
              <div className="lc-flow-pills">
                {EVENT_PILLS.map(p => pill(t('kind.' + p.kind), props.counts[p.tally], ' lc-flow-pill-tint ' + p.cls))}
              </div>
            </div>
          </div>
          <div className="lc-flow-mid">
            <div className="lc-flow-node lc-flow-self" ref={nodeRef('session')}>
              <span className="lc-flow-label">{t('stats.session')}</span>
              <span className="lc-flow-self-stats">
                <span className="lc-flow-kv"><b>{fmt(props.counts.turns)}</b><i>{t('stats.turns')}</i></span>
                <span className="lc-flow-kv"><b>{fmt(props.counts.steps)}</b><i>{t('stats.steps')}</i></span>
              </span>
              <span className="lc-flow-self-stats">
                {figure('skills', props.counts.skills ?? 0, t('stats.skills'), t('stats.skillsJump'))}
                {figure('answers', props.answers ?? 0, t('stats.answers'), t('stats.answersJump'))}
              </span>
            </div>
          </div>
          <div className="lc-flow-col lc-flow-col-r">
            <div className="lc-flow-node" ref={nodeRef('tools')}>
              {head(t('stats.toolCalls'), fmt(toolTotal))}
              {topTools.length > 0
                ? (
                  <div className="lc-flow-pills">
                    {topTools.map(([name, n]) => (
                      <span key={name} className="lc-flow-pill" title={name}>
                        <span className="lc-flow-pill-label">{name}</span>
                        <b>{fmt(n)}</b>
                      </span>
                    ))}
                    {moreTools > 0
                      ? <span className="lc-flow-pill lc-flow-pill-dim"><span className="lc-flow-pill-label">{t('stats.toolsMore', { n: moreTools })}</span></span>
                      : null}
                  </div>
                )
                : null}
            </div>
            <div
              className="lc-flow-node lc-flow-team"
              ref={nodeRef('cost')}
              role="button"
              tabIndex={0}
              onClick={onTeamClick}
              onKeyDown={onTeamKeyDown}
            >
              {head(t('agents.title'), fmt(familyTokens), t('stats.teamTip'))}
              <div className="lc-flow-rows">
                <div className="lc-flow-row">
                  <span className="lc-flow-row-label">{t('stats.currentAgent')}</span>
                  <span className="lc-flow-pair"><b>{fmt(ownTokens)}</b></span>
                </div>
                <div className="lc-flow-row lc-stat-tipped group/tip">
                  <span className="lc-flow-row-label">
                    {t('stats.teamSubs', { n: sub.count })}
                    <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                  </span>
                  <span className="lc-flow-pair"><b>{fmt(subTokens)}</b></span>
                  <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{t('stats.subTokensTip')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
