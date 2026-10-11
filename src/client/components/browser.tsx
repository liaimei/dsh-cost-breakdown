import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { UNKNOWN_TOOL_SOURCE, type Category, type ContextHeaders, type ContextTimeline, type HeaderTool, type RequestRecord, type SurfaceNode } from '../../shared/types'
import { assemble } from '../assemble'
import type { Assembled } from '../assemble'
import { CATS, CAT_COLOR, partsOf } from '../categories'
import { dnaBaseLabel, dnaOf } from '../dna'
import type { DnaItem } from '../dna'
import type { ContentFetcher, ConversationNodeLike, HeaderFetcher } from '../services'
import type { ContextSettings, DefaultDeltaBase, DefaultToolSort } from '../settings'
import type { ViewKit } from '../viewkit'
import { blockSummaryOf, callNamesOf, callSummaryOf } from '../callSummary'
import type { DetailState } from '../timelineSource'
import { makeDetailNote } from './detailNote'
import { makeNodeText } from './nodes'
import { turnStepsOf } from './trendChart'
import { fetchMissNote, useFetchOnMiss } from './fetchOnMiss'
import { imageRefOf, makeImageCard } from './images'
import { makeRichText } from './richText'
import type { StackedBarProps } from './stackedBar'
import type { ImageLoader } from '../services'
import { TextSection, schemaTextOf, RowToolbar, ToolSchema, toolErrOf } from './browserToolCard'
import { NodeContent, byCatOf, nodeNameOf, msgKindsOf, reasoningTextOf, ROW_KINDS } from './browserNodes'
import type { RowKind } from './browserNodes'

/** 浏览器卡片的输入。每个选中的步骤仍然只是一次 projection 读取，所以
 *  那些承载内容的取数 face 是可选的：没有它们时，各行降级为元数据加一条
 *  降级说明，而绝不是变成错误。 */
export interface ContextBrowserProps {
  data: ContextTimeline
  headers: ContextHeaders | null
  /** 由调用方解析，好让 `useChat` 槽位的 hook 顺序只存在于一处。 */
  convNodes?: readonly ConversationNodeLike[]
  fetchContent?: ContentFetcher
  fetchHeader?: HeaderFetcher
  /** 预览 seq：悬停会临时预览那个步骤；指针离开图表后，选择器自己的选中项重新接管。 */
  previewSeq?: number | null
  /** 钉选 seq：一次钉选选中那个步骤；pinSeq 为 null 则把浏览器退回实时表面。 */
  pinSeq?: number | null
  /** 两个 prop 都到齐时才受控；缺失时（/context 弹窗）浏览器保留自己挂载本地的开关。 */
  dna?: boolean
  onDnaChange?: (on: boolean) => void
  /** 一次性揭示请求：`key` 是两个 DNA 表面共享的带 key——'sys'（系统提示词）、
   * 'tool:<name>'（一份工具 schema）、'n<seq>'（一条消息）——所以同一座桥既服务头部带也服务消息
   * 节点；它通过 `onNodeFocusHandled` 交还，好让同一行能再次触发。 */
  nodeFocus?: { step: number | 'live'; key: string; cat: Category | 'system' | 'tools' } | null
  onNodeFocusHandled?: () => void
  catFocus?: CatFocus | null
  onCatFocusHandled?: () => void
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  onOpenCat?: (cat: string | null) => void
  loadImage?: ImageLoader
  detailState?: DetailState
  onDetailRetry?: () => void
}


/** 来自另一张卡片的类别展开请求：那个类别，外加助手类别
 *  打开时可选的行的种类透镜。 */
export interface CatFocus {
  cat: string
  kind?: RowKind
}

/** 某个类别 key 背后的条目数。`system` 与 `tools` 是头部世代的单例
 *  （系统提示词、工具清单），而不是 surface 节点分桶。 */
function countOf(asm: Assembled, byCat: Partial<Record<Category, SurfaceNode[]>>, c: string): number {
  if (c === 'system') return asm.system !== null ? 1 : 0
  if (c === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCat[c as Category]?.length ?? 0
}

/** 某一轮的最后一条记录，向回扫描；没有任何请求属于该轮时返回 null。 */
function lastOfTurn(requests: RequestRecord[], turn: number): RequestRecord | null {
  for (let i = requests.length - 1; i >= 0; i--) if ((requests[i].turn ?? 0) === turn) return requests[i]
  return null
}

/** 标出某个 surface 条目是在何处进入上下文的轮次/步骤：该条目 seq 之后「第一条」被记录的请求，
 * 就是第一个携带它的请求（assemble 的纳入规则是 `n.seq < R.seq`）；后面没有请求则为 null。 */
export function stepStampOf(requests: RequestRecord[]): (itemSeq: number) => { turn: number; step: number } | null {
  // 对副本排序：wire 按追加顺序到达，但推导绝不能依赖它（恢复出来的行可能重新排序）。
  const sorted = requests.slice().sort((a, b) => a.seq - b.seq)
  return (itemSeq) => {
    for (const r of sorted) {
      if (r.seq > itemSeq) {
        return typeof r.turn === 'number' && typeof r.step === 'number' ? { turn: r.turn, step: r.step } : null
      }
    }
    return null
  }
}

/** 每个带在已占用区域中至少保住这个份额，所以一个极小的条目仍然是可以悬停/点击的
 * 细丝，而不是不足一个像素的细屑；提示仍然报告真实占比。 */
const DNA_MIN_BAND = 0.35

/**
 * 绑定 `kit`、共享的 `StackedBar` 与 `settings`，返回浏览器卡片。
 * 三个子渲染器（明细提示、节点取文案、富文本套件）都在这座工厂层铸出来，
 * 所以每次渲染的正文绝不会重建组件身份。
 */
export function makeContextBrowser(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactElement,
  settings: ContextSettings,
): (props: ContextBrowserProps) => ReactElement {
  const { t, fmt, fmtTime, catLabel } = kit
  const DetailNote = makeDetailNote(kit)
  const nodeText = makeNodeText(kit)
  const rich = makeRichText(kit)
  const ImageCard = makeImageCard(kit)
  const lineLabel = (n: number): string => t(n === 1 ? 'block.line' : 'block.lines', { n })

  return function ContextBrowser(props: ContextBrowserProps): ReactElement {
    const { data, headers } = props
    // 'live' = 当前表面（「下一条」请求的上下文）；数字 = 某个保留步骤的 seq。
    const [sel, setSel] = useState<'live' | number>('live')
    const [openCat, setOpenCat] = useState<string | null>(null)
    const [openElem, setOpenElem] = useState<string | null>(null)
    // 过滤是架在「已打开」类别上的一枚透镜：切换类别会重置它，而选中某个步骤会保留它，好让同一枚透镜比较不同世代。
    const [rowQuery, setRowQuery] = useState('')
    const [rowKind, setRowKind] = useState<RowKind | null>(null)
    // 挂载时的默认值；工具栏内的切换保持挂载本地，绝不写回。
    const [toolSort, setToolSort] = useState<DefaultToolSort>(() => settings.defaultToolSort())
    const [dnaLocal, setDnaLocal] = useState(false)
    // 只有两个 prop 都到齐时才受控（标签页与趋势卡片共享这个开关）；
    // 否则这个开关是挂载本地的，好让 /context 弹窗能独立使用浏览器。
    const dnaLinked = props.dna !== undefined && props.onDnaChange !== undefined
    const dna = dnaLinked ? props.dna === true : dnaLocal
    const setDna = (on: boolean): void => {
      if (dnaLinked) {
        /* `dnaLinked` 要求两个 prop 都在，所以这个处理函数必然存在。 */
        props.onDnaChange?.(on)
      } else {
        setDnaLocal(on)
      }
    }
    const [dnaKey, setDnaKey] = useState<string | null>(null)
    const [deltaBase, setDeltaBase] = useState<DefaultDeltaBase>(() => settings.defaultDeltaBase())
    const onOpenCat = props.onOpenCat
    const setCat = (c: string | null): void => {
      setOpenCat(c)
      if (onOpenCat !== undefined) onOpenCat(c)
    }

    const convNodes = props.convNodes
    const convBySeq = useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    const openSeq = openElem !== null && openElem.startsWith('n')
      ? Number(openElem.slice(1))
      : null
    // fetch-on-miss 的 key：只有已打开且尚未 join 的节点值得一次定向读取，
    // 在那之前 key 保持 null，所以收起的行永远不会触发历史流量。
    const fetchContent = props.fetchContent
    const miss = useFetchOnMiss(
      openSeq !== null && !convBySeq.has(openSeq) ? openSeq : null,
      fetchContent,
      'dsh-cost-breakdown: targeted history read failed',
    )
    // 落地的冷读结果合并在实时 join「之下」：发生 seq 冲突时实时对话节点胜出，
    // 因为它们带着定向读取没有的块。
    const bySeq = useMemo(() => {
      if (miss.values.size === 0) return convBySeq
      const m = new Map(convBySeq)
      for (const [seq, n] of miss.values) if (!m.has(seq)) m.set(seq, n)
      return m
    }, [convBySeq, miss.values])
    // 钉选联动：被钉住的柱子选中它的步骤；取消钉选回到实时，且只有「新的」钉选才覆盖手动选中。
    const pinSeq = props.pinSeq
    useEffect(() => {
      setSel(pinSeq === null || pinSeq === undefined ? 'live' : pinSeq)
      setCat(null)
      setOpenElem(null)
    }, [pinSeq, onOpenCat])
    const rootRef = useRef<HTMLDivElement | null>(null)
    const focusScrollRef = useRef(false)
    const nodeFocus = props.nodeFocus
    useEffect(() => {
      if (nodeFocus === null || nodeFocus === undefined) return
      setSel(nodeFocus.step)
      setCat(nodeFocus.cat)
      setOpenElem(nodeFocus.key)
      setRowQuery('')
      setRowKind(null)
      focusScrollRef.current = true
      if (props.onNodeFocusHandled !== undefined) props.onNodeFocusHandled()
    }, [nodeFocus, props.onNodeFocusHandled, onOpenCat])
    const catFocus = props.catFocus
    useEffect(() => {
      if (catFocus === null || catFocus === undefined) return
      setSel('live')
      setCat(catFocus.cat)
      setOpenElem(null)
      setRowQuery('')
      setRowKind(catFocus.kind ?? null)
      if (props.onCatFocusHandled !== undefined) props.onCatFocusHandled()
    }, [catFocus, props.onCatFocusHandled, onOpenCat])
    useLayoutEffect(() => {
      if (!focusScrollRef.current) return
      focusScrollRef.current = false
      rootRef.current?.querySelector('.lc-br-elem-on')?.scrollIntoView({ block: 'nearest' })
    })
    // 尚未 join 的已打开行按取数状态显示的提示（fetchOnMiss.tsx）。
    const missNote = fetchMissNote(t, fetchContent, miss.state, miss.retry, 'browser.noContent')

    const requests = data.requests
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const stampOf = useMemo(() => stepStampOf(requests), [requests])
    // 实时尾巴——还没有任何已记录请求携带的条目——搭在「下一条」请求上，遵循 harness 的步骤循环
    // （`core/agent-loop` 的 agent.ts）：一条最新的用户消息开启新一轮，一条只有文本的最终回复结束该轮，
    // 其余一切则延续它。在请求被记录之前是一个「估计值」（虚线下划线），记录后确认的时间戳会取代它。
    const pendingStamp = useMemo(() => {
      let hasReq = false
      let lastSeq = -1
      let lastTurn = 0
      let lastStep = 0
      for (const r of requests) {
        if (hasReq && r.seq <= lastSeq) continue
        hasReq = true
        lastSeq = r.seq
        lastTurn = typeof r.turn === 'number' ? r.turn : -1
        lastStep = typeof r.step === 'number' ? r.step : -1
      }
      if (hasReq && (lastTurn < 0 || lastStep < 0)) return null
      let newestSeq = -1
      let newest: SurfaceNode | null = null
      for (const n of data.nodes) if (newest === null || n.seq > newestSeq) { newest = n; newestSeq = n.seq }
      if (newest === null) return null
      const nextTurn = { turn: lastTurn + 1, step: 1 }
      if (newest.cat === 'user') return nextTurn
      if (!hasReq) return null
      if (newest.cat === 'assistant' && !msgKindsOf(newest, bySeq.get(newest.seq)).tool) return nextTurn
      return { turn: lastTurn, step: lastStep + 1 }
    }, [requests, data.nodes, bySeq])
    const hoverReq = props.previewSeq !== null && props.previewSeq !== undefined
      ? requests.find(r => r.seq === props.previewSeq) ?? null
      : null
    const req = hoverReq ?? (sel === 'live' ? null : requests.find(r => r.seq === sel) ?? null)
    // 实时表面把它的下一条请求估计与日志里最新的事实配对（seq 最大——wire 顺序不可信）。
    const actual = req ?? requests.reduce<RequestRecord | null>((a, r) => (a === null || r.seq > a.seq ? r : a), null)
    const seq = req !== null ? req.seq : null
    // 浏览器「只」在显示实时步骤时才接入共享的组成悬停——被钉住/预览的步骤有
    // 不同的组成，所以它的悬停绝不能点亮 overview（反之亦然）。
    const linked = req === null && props.onHoverKey !== undefined
    const linkKey = linked && props.hoverKey !== null && props.hoverKey !== 'free'
      ? props.hoverKey
      : null
    const view = assemble(data, headers, seq)

    // projection 只携带元数据，所以选中步骤的内容按需取回（每展开一个分区一次
    // 历史读取）；系统提示词走时间线自己的 `system/message` 节点，工具则走头部世代。
    const fetchHeader = props.fetchHeader
    const headerSeq = view.header !== null ? view.header.seq : null
    const systemSeq = view.system !== null ? view.system.seq : null
    const contentSeq = openCat === 'system' ? systemSeq : openCat === 'tools' ? headerSeq : null
    const epoch = useFetchOnMiss(
      contentSeq,
      fetchHeader,
      'dsh-cost-breakdown: header content fetch failed',
    )
    const headerContent = epoch.values
    const headerNote = fetchMissNote(t, fetchHeader, epoch.state, epoch.retry, 'browser.headerMetaOnly')

    const breakdown = req !== null ? req : data.current
    const parts = partsOf(breakdown)
    const total = breakdown.total
    // 已打开的类别没有悬停也保持点亮（指针悬停会覆盖钉选）；当所显示步骤的
    // 组成里没有任何东西属于它时则丢掉，好让条永远不会读成全暗。
    const pinKey = openCat !== null && (breakdown[openCat as Category | 'system' | 'tools'] || 0) > 0 ? openCat : null
    const pick = (v: string) => {
      setSel(v === 'live' ? 'live' : Number(v))
      setCat(null)
      setOpenElem(null)
    }

    // δ 基线：'step' 与紧邻的前一条记录取差，'turn' 与上一轮的最后一步取差——实时情况下：最后一条
    // 已服务的请求，或本轮到目前为止的增量。没有前驱的表面退回「零」基线。
    const prevRecordOf = (r: RequestRecord): RequestRecord | null => {
      const i = requests.findIndex(x => x.seq === r.seq)
      return i > 0 ? requests[i - 1] : null
    }
    const lastReq = requests.length > 0 ? requests[requests.length - 1] : null
    const turnBaseOf = (r: RequestRecord): RequestRecord | null => lastOfTurn(requests, (r.turn ?? 0) - 1)
    const refReq = req === null
      ? deltaBase === 'step' ? lastReq : lastReq === null ? null : turnBaseOf(lastReq)
      : deltaBase === 'turn' ? turnBaseOf(req) : prevRecordOf(req)
    const zeroBase = refReq === null && lastReq !== null
    const prevView = refReq !== null ? assemble(data, headers, refReq.seq) : null
    const prevByCat = prevView !== null ? byCatOf(prevView) : null

    const byCat = byCatOf(view)

    // 一个 tool-result 节点就是一次已完成的调用——与统计里的 toolCalls 同一套记账；一个被重新
    // 归类的 `skill` 加载保留它的工具戳，也仍然在这里计数。
    const toolHits = new Map<string, number>()
    for (const n of view.nodes) {
      if ((n.cat === 'tool' || n.cat === 'skill') && n.tool !== undefined) toolHits.set(n.tool, (toolHits.get(n.tool) ?? 0) + 1)
    }
    const toolHitsOf = (tool: HeaderTool): number => toolHits.get(tool.name) ?? 0

    const dnaLabel = (it: DnaItem): string => {
      const base = dnaBaseLabel(it, t, catLabel)
      return it.time !== undefined ? base + ' · ' + fmtTime(it.time) : base
    }
    const dnaItems = dna ? dnaOf(view) : null
    const dnaByKey = new Map(dnaItems?.map(it => [it.key, it] as const) ?? [])
    const dnaParts = dnaItems?.map(it => ({
      key: it.key,
      color: CAT_COLOR[it.cat],
      value: it.tokens,
      label: dnaLabel(it),
      group: it.cat,
    })) ?? null
    // 只有当带的 key 指向一个「已渲染」的带时才响应悬停：一次推送可能在指针停驻其上时
    // 不带 mouseleave 就丢掉那个带，而一个死 key 会让条整体变暗（与钉选的闸门保持同一不变量）。
    const liveDnaKey = dnaKey !== null && dnaByKey.has(dnaKey) ? dnaKey : null
    const pickDna = (key: string): void => {
      const it = dnaByKey.get(key)
      /* 条只会报告它拿到的那几个部分的 key；纯属防御。 */
      if (it === undefined) return
      setCat(it.cat)
      setRowQuery('')
      setRowKind(null)
      setOpenElem(key)
      focusScrollRef.current = true
    }

    const toolCount = (c: string): number => countOf(view, byCat, c)

    // 恰好只有一个条目的类别会连类别一起打开那一行，所以一次点击就直接落到内容上。
    const singleKeyOf = (c: string): string | null => {
      if (c === 'system') return view.system !== null ? 'sys' : null
      if (c === 'tools') {
        const tools = view.header?.tools
        return tools !== undefined && tools.length === 1 ? 'tool:' + tools[0].name : null
      }
      /* 只经由 toggleCat 的可打开守卫到达
         （count > 0 ⟺ byCat[c] 存在）；这个兜底纯属防御。 */
      const nodes = byCat[c as Category] ?? []
      return nodes.length === 1 ? 'n' + String(nodes[0].seq) : null
    }

    const toggleCat = (c: string) => {
      // 空类别保持关闭——除了没有头部世代的 system/tools，它们打开是为了解释那条降级说明。
      const openable = toolCount(c) > 0
        || ((c === 'system' || c === 'tools') && view.header === null)
      if (!openable) return
      if (openCat === c) {
        setCat(null)
        setOpenElem(null)
        return
      }
      setCat(c)
      setRowQuery('')
      setRowKind(null)
      setOpenElem(singleKeyOf(c))
    }
    const toggleElem = (key: string) => { setOpenElem(openElem === key ? null : key) }

    /** 可展开的元素行；`err` 在箭头之后立刻带出红色的运行状态点，好让一次失败的结果在收起时也能被扫到。 */
    const elemRow = (
      key: string, tag: ReactNode | null, preview: string,
      tokens: number, time: number | undefined, body: ReactNode,
      err = false, trailing: ReactNode = null,
      stamp: { turn: number; step: number; pending: boolean } | null = null,
    ) => {
      const open = openElem === key
      return (
        <div key={key} className={'lc-br-elem' + (open ? ' lc-br-elem-on' : '')}>
          <button type="button" className="lc-br-elem-row hover:bg-(--dsw-alias-interactive-bg-hover)" onClick={() => { toggleElem(key) }}>
            <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
            {err ? <span className="lc-br-err-dot" title={t('node.failed')} /> : null}
            {tag !== null ? <span className="lc-br-tags">{tag}</span> : null}
            <span className="lc-br-preview">{preview}</span>
            {trailing !== null ? trailing : null}
            {stamp !== null || time !== undefined
              ? <span
                className={'lc-br-time' + (stamp !== null && stamp.pending ? ' lc-br-time-pending' : '')}
                title={stamp !== null
                  ? t(stamp.pending ? 'browser.stepPendingTip' : 'browser.stepAtTip', { t: stamp.turn, s: stamp.step })
                  : undefined}
              >
                {stamp !== null ? t('browser.stepAt', { t: stamp.turn, s: stamp.step }) : ''}
                {stamp !== null && time !== undefined ? ' · ' : ''}
                {time !== undefined ? fmtTime(time) : ''}
              </span>
              : null}
            <span className="lc-br-tokens">{'≈' + fmt(tokens)}</span>
          </button>
          {open ? <div className="lc-br-content">{body}</div> : null}
        </div>
      )
    }

    // 一行的戳记：它已确认的引入步骤，否则——只在「实时」下——用等待中的估计（过去步骤的视图从不臆测）。
    const stampFor = (itemSeq: number): { turn: number; step: number; pending: boolean } | null => {
      const confirmed = stampOf(itemSeq)
      if (confirmed !== null) return { ...confirmed, pending: false }
      if (!view.live || pendingStamp === null) return null
      return { ...pendingStamp, pending: true }
    }

    const rowTagNode = (tag: string | null, names: readonly string[] | null): ReactNode => {
      if (tag === null) return null
      if (names === null) return <span className="lc-br-tag">{tag}</span>
      const counts = new Map<string, number>()
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
      return [...counts.entries()].map(([name, count]) => (
        <span key={name} className="lc-br-tag">{count > 1 ? name + ' ×' + String(count) : name}</span>
      ))
    }

    const catBody = (c: string): ReactNode => {
      if (c === 'system') {
        // 没有生效的提示词：这条说明必须点名缺失的是哪个「projection」——是没有 headers 服务，还是还没有世代。
        const sys = view.system
        if (sys === null) {
          return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        }
        const content = headerContent.get(sys.seq)
        if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
        if (content.system === undefined) return <div className="lc-br-note">{t('browser.noSystem')}</div>
        return elemRow('sys', null, content.system.replace(/\s+/g, ' ').trim().slice(0, 80), breakdown.system, undefined,
          <TextSection label={catLabel('system')} text={content.system} rich={rich} lines={lineLabel} />,
          false, null, stampFor(sys.seq))
      }
      if (c === 'tools') {
        if (view.header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        const labels = {
          desc: t('tool.desc'),
          title: t('tool.params'),
          empty: t('tool.paramsEmpty'),
          show: t('tool.jsonToggle'),
          hide: t('tool.jsonHide'),
        }
        const content = headerContent.get(view.header.seq)
        const epochStamp = stampFor(view.header.seq)
        const contentByName = new Map(content?.tools.map(t => [t.name, t]) ?? [])
        const q = rowQuery.trim().toLowerCase()
        const shown = view.header.tools
          .filter((tool: HeaderTool) => {
            if (q === '') return true
            if (tool.name.toLowerCase().includes(q)) return true
            if ((tool.plugin ?? '').toLowerCase().includes(q)) return true
            const row = contentByName.get(tool.name)
            if (row === undefined) return false
            return (row.description ?? '').toLowerCase().includes(q)
              || schemaTextOf(row.schema).toLowerCase().includes(q)
          })
          // 按大小排序照应 overview 的 Top 徽标；生产者给的头部顺序没有意义。
          .sort((a, b) => toolSort === 'count'
            ? (toolHitsOf(b) - toolHitsOf(a) || (a.name < b.name ? -1 : 1))
            : toolSort === 'size'
              ? b.tokens - a.tokens
              : (a.name < b.name ? -1 : 1))
        const toolctl = (
          <RowToolbar value={rowQuery} placeholder={t('tool.search')} tip={t('tool.sortTip')} onChange={setRowQuery}>
            {(['size', 'count', 'name'] as const).map(k => (
              <button
                key={k}
                type="button"
                className={'lc-gran-btn' + (toolSort === k ? ' lc-gran-on' : '')}
                onClick={() => { setToolSort(k) }}
              >
                {t('tool.sort.' + k)}
              </button>
            ))}
          </RowToolbar>
        )
        if (shown.length === 0) {
          return (
            <div>
              {toolctl}
              <div className="lc-br-note">{t('tool.noMatch')}</div>
            </div>
          )
        }
        const toolBody = (tool: HeaderTool): ReactNode => {
          if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
          const row = contentByName.get(tool.name)
          return row === undefined
            ? <div className="lc-br-note">{t('browser.notInLog')}</div>
            : <ToolSchema description={row.description} schema={row.schema} rich={rich} lines={lineLabel} labels={labels} />
        }
        return (
          <div>
            {toolctl}
            {shown.map((tool: HeaderTool) => {
              // 尽力而为的宿主归属（toolSources.ts）；早于归属钩子的 provider 会以
              // UNKNOWN_TOOL_SOURCE 哨兵值到达，并渲染成本地化的「未知插件」标签。
              const trailing = (
                <>
                  {tool.plugin !== undefined
                    ? <span className="lc-br-tag lc-br-tool-plugin" title={tool.plugin === UNKNOWN_TOOL_SOURCE ? t('tool.unknownTitle') : t('tool.plugin')}>
                      {tool.plugin === UNKNOWN_TOOL_SOURCE ? t('tool.unknown') : tool.plugin}
                    </span>
                    : null}
                  <span className="lc-br-hits" title={t('tool.hitsTip')}>{'×' + fmt(toolHitsOf(tool))}</span>
                </>
              )
              return elemRow('tool:' + tool.name, null, tool.name, tool.tokens, undefined,
                toolBody(tool),
                false, trailing, epochStamp)
            })}
          </div>
        )
      }
      /* 只有类别已打开时才渲染正文，
         而这要求 count > 0 ⟺ byCat[c] 存在；纯属防御。 */
      const nodes = (byCat[c as Category] ?? []).slice().reverse()
      // 各行先推导出自己的展示事实，所以文本过滤扫的正是各行显示的东西——在推导时算好，而不是每次按键。
      const rows = nodes.map((n) => {
        const conv = bySeq.get(n.seq)
        // `skill` 工具的加载会重新归入 `skill` 分桶，但仍然是工具结果——同一条失败规则。
        const rowErr = (n.cat === 'tool' || n.cat === 'skill') && toolErrOf(n, conv).err
        let tag: string | null = null
        let tagNames: string[] | null = null
        let preview = nodeText(n)
        const id = nodeNameOf(n)
        if (n.cat === 'tool') {
          tag = n.tool ?? '?'
          tagNames = n.tool !== undefined ? [n.tool] : null
          preview = callSummaryOf(conv) ?? t('node.toolResult')
        } else if (n.cat === 'skill') {
          tag = n.skill !== undefined ? t('node.skillTag', { name: n.skill }) : t('form.' + (n.form || 'context'))
          preview = (n.skill === undefined && id !== '' ? id : null)
            ?? (n.text !== undefined && n.text !== '' ? n.text : null)
            ?? callSummaryOf(conv) ?? preview
        } else if (n.cat === 'assistant') {
          // fold 只对「没有文本」的回复盖上 `calls`；一条同时带文本与 calls 的回复通过
          // join 找回它的面包屑。
          const names = Array.isArray(n.calls) && n.calls.length > 0 ? n.calls : callNamesOf(conv)
          if (names.length > 0) {
            tag = names.join(' › ')
            tagNames = names
            preview = (n.text !== undefined && n.text !== '' ? n.text : null)
              ?? blockSummaryOf(conv)
              ?? t('node.empty')
          } else if (n.text === undefined || n.text === '') {
            preview = blockSummaryOf(conv) ?? preview
          }
        } else if (n.cat === 'user') {
          const imgCount = conv !== undefined && Array.isArray(conv.content)
            ? conv.content.filter(b => imageRefOf(b) !== null).length
            : 0
          if (imgCount > 0 && openElem !== `n${n.seq}`) {
            tag = t('attach.image') + (imgCount > 1 ? ' ×' + String(imgCount) : '')
          }
        } else {
          tag = t('form.' + (n.form || 'context'))
          if (id !== '') {
            preview = id
          } else if (n.text !== undefined && n.text !== '') {
            preview = n.form === 'snapshot' ? t('node.snapshot') + n.text : n.text
          }
        }
        return {
          n,
          conv,
          rowErr,
          tag,
          tagNames,
          preview,
          reasoning: n.cat === 'assistant' ? reasoningTextOf(conv) : '',
          kinds: msgKindsOf(n, conv),
        }
      })
      const q = rowQuery.trim().toLowerCase()
      // 种类徽标统计的是所显示步骤「全部」的行——该步骤的组成，而不是文本透镜的幸存者。
      const kindCounts = c === 'assistant'
        ? ROW_KINDS.map(k => ({ k, n: rows.reduce((acc, r) => acc + (r.kinds[k] ? 1 : 0), 0) }))
        : null
      const shown = q === '' && rowKind === null
        ? rows
        : rows.filter(r =>
          (rowKind === null || r.kinds[rowKind])
          && (q === ''
            || (r.tag ?? '').toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)
            || (typeof r.n.text === 'string' && r.n.text.toLowerCase().includes(q))
            || r.reasoning.toLowerCase().includes(q)))
      const rowctl = kindCounts === null
        ? <RowToolbar value={rowQuery} placeholder={t('browser.search.' + c)} onChange={setRowQuery} />
        : (
          <RowToolbar value={rowQuery} placeholder={t('browser.search.' + c)} tip={t('browser.kindTip')} onChange={setRowQuery}>
            {kindCounts.map(({ k, n }) => (
              <button
                key={k}
                type="button"
                className={'lc-gran-btn' + (rowKind === k ? ' lc-gran-on' : '')}
                onClick={() => { setRowKind(rowKind === k ? null : k) }}
              >
                {t('browser.kind.' + k)}
                <span className="lc-kind-n">{fmt(n)}</span>
              </button>
            ))}
          </RowToolbar>
        )
      if (shown.length === 0) {
        return <div>{rowctl}<div className="lc-br-note">{t('browser.rowNoMatch')}</div></div>
      }
      return (
        <div>
          {rowctl}
          {shown.map(({ n, conv, rowErr, tag, tagNames, preview }) => elemRow(`n${n.seq}`, rowTagNode(tag, tagNames), preview, n.tokens, n.time,
            <NodeContent
              node={n}
              conv={conv}
              rich={rich}
              img={{ Card: ImageCard, load: props.loadImage }}
              labels={{
                thinking: t('block.thinking'),
                answer: t('block.answer'),
                content: t('block.content'),
                result: t('block.result'),
                summary: t('block.summary'),
                images: t('attach.images'),
                other: t('attach.other'),
                lines: lineLabel,
                callState: (err: boolean, exit: number | null) => (
                  <span className={'lc-ts-call-state ' + (err ? 'lc-ts-call-err' : 'lc-ts-call-ok')}>
                    <i />
                    {err
                      ? t('call.fail') + (exit !== null ? ' · ' + t('call.exit', { n: exit }) : '')
                      : t('call.ok')}
                  </span>
                ),
              }}
              // 只有已打开那一行的正文会渲染，所以 miss 提示恰好就是「这一次」join 的取数状态。
              hint={conv === undefined ? missNote : t('browser.noContent')}
            />,
            rowErr, null, stampFor(n.seq)))}
        </div>
      )
    }

    return (
      <div className="lc-card" ref={rootRef}>
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('browser.title')}</span>
          <span className="lc-gran lc-br-dna-ctl" role="group" title={t('browser.dnaTip')}>
            <button
              type="button"
              className={'lc-gran-btn' + (dna ? ' lc-gran-on' : '')}
              onClick={() => { setDna(!dna) }}
            >
              {t('browser.dna')}
            </button>
          </span>
          <span className="lc-gran" role="group" title={t('browser.base.tip')}>
            <button
              type="button"
              className={'lc-gran-btn' + (deltaBase === 'step' ? ' lc-gran-on' : '')}
              onClick={() => { setDeltaBase('step') }}
            >
              {t('browser.base.step')}
            </button>
            <button
              type="button"
              className={'lc-gran-btn' + (deltaBase === 'turn' ? ' lc-gran-on' : '')}
              onClick={() => { setDeltaBase('turn') }}
            >
              {t('browser.base.turn')}
            </button>
          </span>
          <select
            className="lc-br-pick"
            value={seq === null ? 'live' : String(seq)}
            onChange={(e) => { pick(e.target.value) }}
          >
            <option value="live">{t('browser.live')}</option>
            {requests.slice().reverse().map(r => (
              <option key={r.seq} value={String(r.seq)}>
                {t('detail.step', { t: r.turn ?? 0, s: r.step ?? 0, n: stepsOf(r.turn) })}
              </option>
            ))}
          </select>
        </div>

        <div className="lc-br-meta">
          <b>{req !== null
            ? t('detail.step', { t: req.turn ?? 0, s: req.step ?? 0, n: stepsOf(req.turn) })
            : t('browser.liveNow')}</b>
          {req !== null ? <span>{fmtTime(req.time)}</span> : null}
          <span className="lc-est">{t('detail.estTotal', { n: fmt(total) })}</span>
          {actual !== null && actual.prompt !== undefined
            ? <span>{t('detail.actual', { n: fmt(actual.prompt) })}</span>
            : null}
        </div>

        <div className={'lc-br-bar' + (dna ? ' lc-br-bar-dna' : '')}>
          <StackedBar
            parts={dnaParts ?? parts}
            height={10}
            // 高亮优先级：指针悬停（DNA 模式下是本地的，否则是共享联动）高于已打开类别的钉选。
            // DNA 模式下镜像联动是「单向」的：进来的类别 key 会点亮该类别的各带，而带的悬停留在
            // 条上，绝不向上回报。
            hoverKey={dna ? liveDnaKey ?? linkKey ?? pinKey : linkKey ?? pinKey}
            onHoverKey={dna ? setDnaKey : linked ? props.onHoverKey : undefined}
            tip={dna}
            onPickKey={dna ? pickDna : undefined}
            minBand={dna ? DNA_MIN_BAND : undefined}
          />
        </div>

        {view.missingLive > 0
          ? <div className="lc-br-note">{t('browser.missingLive', { n: view.missingLive })}</div>
          : null}
        {view.approximate
          ? <div className="lc-br-note">{t('browser.approx')}</div>
          : null}
        {props.detailState === 'loading'
          ? <DetailNote state="loading" className="lc-br-note" />
          : null}
        {props.detailState === 'failed' && props.onDetailRetry !== undefined
          ? <DetailNote state="failed" onRetry={props.onDetailRetry} className="lc-br-note" />
          : null}

        <div className="lc-br-cats">
          {CATS.map((c) => {
            const count = toolCount(c.key)
            const v = breakdown[c.key] || 0
            const prevCount = zeroBase ? 0 : prevView !== null && prevByCat !== null ? countOf(prevView, prevByCat, c.key) : null
            const countDelta = prevCount !== null ? count - prevCount : null
            const prevTokens = zeroBase ? 0 : refReq !== null ? (refReq[c.key] || 0) : null
            const tokenDelta = prevTokens !== null ? v - prevTokens : null
            const openable = count > 0
              || ((c.key === 'system' || c.key === 'tools') && view.header === null)
            const open = openCat === c.key && openable
            return (
              <div key={c.key} className={'lc-br-cat' + (openable ? '' : ' lc-br-cat-empty')}>
                <button
                  type="button"
                  className={'lc-br-cat-row hover:bg-(--dsw-alias-interactive-bg-hover)'
                    + (open ? ' lc-br-cat-open' : '')
                    + (linked && props.hoverKey === c.key ? ' lc-br-cat-on' : '')}
                  /* 处理函数只在联动时才存在，
                     而联动已经要求 onHoverKey 有定义（见上）。 */
                  onMouseEnter={linked ? () => { if (props.onHoverKey !== undefined) props.onHoverKey(c.key) } : undefined}
                  onMouseLeave={linked ? () => { if (props.onHoverKey !== undefined) props.onHoverKey(null) } : undefined}
                  /* v8 ignore stop */
                  onClick={() => { toggleCat(c.key) }}
                >
                  <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
                  <i style={{ background: c.color }} />
                  <span className="lc-br-cat-label">{catLabel(c.key)}</span>
                  <span className="lc-br-count-grp">
                    <span className="lc-br-cat-count">{t('browser.items', { n: count })}</span>
                    {countDelta !== null && countDelta !== 0 ? (
                      <span className={'lc-br-delta lc-br-delta-' + (countDelta > 0 ? 'up' : 'down')}>
                        {`${countDelta > 0 ? '+' : ''}${countDelta}`}
                      </span>
                    ) : null}
                  </span>
                  <span className="lc-br-tokens-grp">
                    {tokenDelta !== null && tokenDelta !== 0 ? (
                      <span className={'lc-br-tdelta lc-br-tdelta-' + (tokenDelta > 0 ? 'up' : 'down')}>
                        {(tokenDelta > 0 ? '+' : '') + fmt(tokenDelta)}
                      </span>
                    ) : null}
                    <span className="lc-br-tokens">{'≈' + fmt(v)}</span>
                  </span>
                  <span className="lc-br-pct">{total > 0 ? `${Math.round(v / total * 100)}%` : ''}</span>
                </button>
                {open ? <div className="lc-br-body">{catBody(c.key)}</div> : null}
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}
