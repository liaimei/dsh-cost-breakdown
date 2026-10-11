import { memo, type ComponentType, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, RequestRecord, SurfaceNode } from '../../shared/types'
import { partsOf, CATS } from '../categories'
import { cacheHitPercent } from '../format'
import type { StepBrief } from '../brief'
import { blockSummaryOf, callNamesOf, callSummaryOf } from '../callSummary'
import type { ConversationNodeLike } from '../services'
import type { StackedBarProps } from './stackedBar'
import type { ViewKit } from '../viewkit'

/** 明细面板的输入。`prev` 是模式开关而不是展示提示：
 *  它只要出现，面板就从累计构成变成相对那条记录的带符号增量。 */
export interface RequestDetailProps {
  request: RequestRecord | null
  /** 增量模式：紧排在本条之前显示的那条记录（第一根柱子上为 null）。
   * 它的「存在」把面板从累计构成切换为相对上一条记录的带符号
   * 变化——正是图表的 deltaOf 所画的那一对。 */
  prev?: RequestRecord | null
  marker?: ContextEventRecord | null
  /** 该步骤的语义身份（轮次开场 / 输入 / 回复）——见 brief.ts；null 则渲染一条预留的空泳道。 */
  brief?: StepBrief | null
  /** 用于丰富调用参数的对话快照 join；join 缺失 = 只有名字，绝不是错误。 */
  convOf?: (seq: number) => ConversationNodeLike | undefined
  /** 逐轮次的步骤总数（父级在已服务请求上算的 `turnStepsOf`），供头部的
   * 「第几步/共几步」使用；不传 = 一轮一个步骤。 */
  stepsOf?: (turn: number | undefined) => number
  /** 在上下文浏览器里揭示某条 brief 行的节点；不传 = 各行不响应。 */
  onLocate?: (node: SurfaceNode, isResponse: boolean) => void
  /** 镜像过来的类别悬停（与 overview/browser 共享）：点亮组成条上对应的
   * 分段；条本身从不把悬停回报出去。 */
  hoverKey?: string | null
}

/**
 * 绑定 `kit` 与共享的 `StackedBar`，返回带 memo 的明细面板。memo 放在
 * 这一层，是因为父级在悬停渲染之间保持 `request`/`prev`/`brief`/`convOf` 引用稳定，
 * 所以只有活动柱子真的移动时面板才重新渲染。
 */
export function makeRequestDetail(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactElement,
): ComponentType<RequestDetailProps> {
  const { t, fmt, fmtTime, catLabel, eventLabel, eventAt } = kit

  /** 一条 brief 行：定宽的种类标签加一行一眼可读的内容。标签带一个样式化、即时的说明气泡（
   * 共享的 `.lc-tip` 外观）；内容 span 保留原生 title（预览 + 定位提示），所以两者永不叠在一起。
   * 浏览器联动已接好「且」该行带节点时可点击（始终存在的 In 行在空状态下不响应）。
   */
  function BriefRow(props: {
    tag: string
    tagTip: string
    /** 只在空状态的 In 行上缺失——没有节点的行无法定位。 */
    node?: SurfaceNode
    isResponse: boolean
    onLocate?: (node: SurfaceNode, isResponse: boolean) => void
    children: ReactNode
  }): ReactElement {
    const inner = (
      <>
        <span className="lc-brief-tag group/tip">
          {props.tag}
          <span className="lc-tip lc-brief-tip group-hover/tip:opacity-100" role="tooltip">{props.tagTip}</span>
        </span>
        {props.children}
      </>
    )
    if (props.node === undefined || props.onLocate === undefined) return <div className="lc-brief-row">{inner}</div>
    const node = props.node
    const onLocate = props.onLocate
    const locate = (): void => { onLocate(node, props.isResponse) }
    return (
      <button type="button" className="lc-brief-row lc-brief-row-link hover:bg-(--dsw-alias-interactive-bg-hover)" onClick={locate}>
        {inner}
      </button>
    )
  }

  /** 一行的构成——一个紧凑的「事实」标签加上预览文本，与上下文浏览器的元素行同构，使一条
   * brief 行读起来与它点击后揭示的浏览器行完全一致：工具结果标出工具名，skill 内容标出
   * skill 名，助手回复标出调用面包屑，inject 标出形态，用户消息标出图片附件。
   * 各分支覆盖 Category 联合类型；一个恶意的 cat 降级进 user 那一支——变成一行纯文本，绝不抛异常。 */
  function chipParts(n: SurfaceNode, conv: ConversationNodeLike | undefined): { tag: string | null; text: string } {
    if (n.cat === 'tool') {
      const summary = callSummaryOf(conv)
      if (n.tool !== undefined) return { tag: n.tool, text: summary ?? '' }
      return { tag: null, text: summary ?? t('node.toolResult') }
    }
    if (n.cat === 'skill') {
      // skill 内容（issue #66）：一次加载/调用标出它的「名字」，目录摘要则标出它的形态标签（
      // 即「目录已更新」那套说法）。没有文本的行（`skill` 工具的加载——它的内容走在工具结果里）
      // 预览调用摘要，与工具行一样。
      return {
        tag: n.skill !== undefined ? t('node.skillTag', { name: n.skill }) : t('form.' + (n.form ?? 'context')),
        text: n.text ?? callSummaryOf(conv) ?? '',
      }
    }
    if (n.cat === 'assistant') {
      // fold 出来的 surface 节点只对「没有文本」的回复保留 `calls`；一条同时带文本与 calls 的回复
      // 通过对话 join 找回它的调用面包屑。
      const names = n.calls !== undefined && n.calls.length > 0 ? n.calls : callNamesOf(conv)
      const own = n.text !== undefined && n.text !== '' ? n.text : blockSummaryOf(conv) ?? ''
      return {
        tag: names.length > 0 ? names.join(' › ') : null,
        text: own !== '' ? own : (names.length > 0 ? '' : t('node.empty')),
      }
    }
    if (n.cat === 'inject') {
      const text = n.text !== undefined && n.text !== ''
        ? (n.form === 'snapshot' ? t('node.snapshot') + n.text : n.text)
        : ''
      return { tag: t('form.' + (n.form ?? 'context')), text }
    }
    // 用户那一支（或恶意的 cat）：图片上传会多一个 Image 徽标。
    const imgs = n.imgs ?? 0
    return {
      tag: imgs > 0 ? t('attach.image') + (imgs > 1 ? ' ×' + String(imgs) : '') : null,
      text: n.text ?? '',
    }
  }

  /** 事实 + 文本这一类对应的原生 title：'tag · text'，缺哪半就降级为哪半。 */
  function factTitle(tag: string | null, text: string): string {
    return tag !== null ? (text !== '' ? tag + ' · ' + text : tag) : text
  }

  /** brief 的容器「永远」渲染——一条固定三行的泳道（`.lc-brief` 的 min-height），因此拖动图表时
   * 面板高度绝不变化；未知或空步骤只是让泳道的一部分留白，而不是把它收起。 */
  function BriefSection(props: {
    brief: StepBrief | null | undefined
    convOf?: (seq: number) => ConversationNodeLike | undefined
    onLocate?: (node: SurfaceNode, isResponse: boolean) => void
  }): ReactElement {
    const { opener, inputs, response } = props.brief ?? { inputs: [] }
    // `convOf` 默认落空，好让行构成只有一条代码路径处理「没有快照 join」。
    const convOf = props.convOf ?? (() => undefined)
    // 内容 span 的原生 title：完整预览，加上可点击时的定位提示。
    const hint = props.onLocate !== undefined ? ' — ' + t('brief.locate') : ''
    // 徽标点击：定位「这个」徽标的节点；stopPropagation 让它不会同时触发整行的定位。
    const locateChip = props.onLocate === undefined ? undefined : (n: SurfaceNode) =>
      (e?: MouseEvent) => { e?.stopPropagation(); props.onLocate?.(n, false) }
    const MAX_CHIPS = 3
    /** brief 的唯一内容单元——输入与回复共用同一套徽标构造（错误点、事实标签、
     * 预览文本）。输入徽标紧凑且各自可点（每个定位自己的节点）；回复则是单个
     * 徽标、撑到整行宽，且不响应，因为行按钮本身已经能定位它。 */
    const nodeChip = (n: SurfaceNode, onClick?: (e?: MouseEvent) => void, grow = false): ReactElement => {
      const { tag, text } = chipParts(n, convOf(n.seq))
      return (
        <span
          key={n.seq}
          className={'lc-brief-chip' + (grow ? ' lc-brief-chip-grow' : '') + (onClick !== undefined ? ' lc-brief-chip-link hover:bg-(--dsw-alias-interactive-bg-hover)' : '')}
          title={factTitle(tag, text) + hint}
          onClick={onClick}
        >
          {n.err === true ? <span className="lc-br-err-dot" /> : null}
          {tag !== null ? <span className="lc-brief-chip-tag">{tag}</span> : null}
          {text !== '' ? <span className="lc-brief-chip-text">{text}</span> : null}
        </span>
      )
    }
    const openerParts = opener !== undefined ? chipParts(opener, convOf(opener.seq)) : null
    return (
      <div className="lc-brief">
        {opener !== undefined && openerParts !== null ? (
          <BriefRow tag={t('brief.turn')} tagTip={t('brief.turnTip')} node={opener} isResponse={false} onLocate={props.onLocate}>
            {openerParts.tag !== null ? <span className="lc-brief-fact">{openerParts.tag}</span> : null}
            {openerParts.text !== '' ? (
              <span className="lc-brief-text" title={factTitle(openerParts.tag, openerParts.text) + hint}>{openerParts.text}</span>
            ) : null}
          </BriefRow>
        ) : null}
        {/* In 行「永远」渲染（含空状态）：一轮的开场步骤没有输入，而恒定的行
            数能让面板高度在拖动图表时保持稳定。没有节点时该行不响应。 */}
        <BriefRow tag={t('brief.input')} tagTip={t('brief.inputTip')} node={inputs[0]} isResponse={false} onLocate={props.onLocate}>
          {inputs.length > 0 ? (
            <>
              {/* 与其他行一样整行可点（定位「第一个」输入）；每个徽标仍然定位自己的节点——
                  stopPropagation 让徽标点击不会同时触发整行的。 */}
              {inputs.slice(0, MAX_CHIPS).map(n => nodeChip(n, locateChip?.(n)))}
              {inputs.length > MAX_CHIPS ? <span className="lc-brief-more">{t('brief.more', { n: inputs.length - MAX_CHIPS })}</span> : null}
            </>
          ) : (
            <span className="lc-brief-empty">{t('brief.noInputs')}</span>
          )}
        </BriefRow>
        {response !== undefined ? (
          <BriefRow tag={t('brief.reply')} tagTip={t('brief.replyTip')} node={response} isResponse onLocate={props.onLocate}>
            {nodeChip(response, undefined, true)}
          </BriefRow>
        ) : null}
      </div>
    )
  }

  // 在工厂层做 memo：父级在悬停/选中渲染之间交出引用稳定的 request/prev/marker/brief/convOf/onLocate
  // （见 contextView），所以活动柱子没有移动时面板就跳过协调。
  return memo(function RequestDetail(props: RequestDetailProps): ReactElement | null {
    const req = props.request
    // request 为 null 表示指针下没有柱子；面板泳道的高度由下方
    // 图表决定，所以这里返回 null 不会让标签页跳动。
    if (!req) return null
    // 一轮的聚合就是整段运行中「最后」一条带 `stepCount > 1` 的记录，
    // 面板也正是靠这个知道该说「轮」而不是「步」。
    const isTurn = req.stepCount !== undefined && req.stepCount > 1
    const head = isTurn
      ? t('detail.turn', {
        t: req.turn ?? 0,
        /** isTurn 已经保证 stepCount !== undefined；这个兜底纯属防御。 */
        n: req.stepCount ?? 0,
      })
      : t('detail.step', { t: req.turn ?? 0, s: req.step ?? 0, n: props.stepsOf?.(req.turn) ?? 1 })
    // 当这根柱子带有边界事件（compaction/prune）时，头部
    // 还会显示事件发生在哪儿：前一条请求与后一条请求
    // 之间的空隙（例如 "✂ Turn 49 · Step 2→3"）。
    const marker = props.marker ?? null
    const markerAt = marker !== null ? eventAt(marker) : null
    // 增量模式：各类别相对上一条记录的「带符号」变化（图表把它们向零线
    // 上下两侧发散堆叠）；provider 用量徽标退出——prompt/output/cacheRead 是逐请求的数字，不是增量。
    const delta = props.prev !== undefined
    const prev = props.prev ?? null
    // 与图表的 `deltaOf` 不同，第一条记录的增量保持 0，而不是与一个隐式的
    // 零作比较——面板读的是一根柱子，不是一个聚合。
    const deltas = CATS.map(c => delta ? (req[c.key] || 0) - (prev !== null ? prev[c.key] || 0 : 0) : 0)
    let net = 0
    let maxAbs = 0
    if (delta) {
      for (const d of deltas) {
        net += d
        if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d)
      }
    }
    const parts = delta
      ? CATS.map((c, i) => ({ key: c.key, color: c.color, value: Math.abs(deltas[i]) }))
      : partsOf(req)
    return (
      <div className="lc-detail">
        <div className="lc-detail-head">
          <b>{head}</b>
          {marker !== null && markerAt !== null
            ? <span className="lc-detail-marker" title={eventLabel(marker)}>{'✂ ' + markerAt}</span>
            : null}
          {isTurn ? <span className="lc-detail-tag">{t('detail.lastStep')}</span> : null}
          {delta ? <span className="lc-detail-tag">{t('gran.delta')}</span> : null}
          <span className="lc-detail-time">{fmtTime(req.time)}</span>
          {/* 指标徽标：每个 provider 数字一颗中性药丸；不折叠 `cacheRead` 的宿主上，
              缓存那个数字会消失（无用量请求上同样）。 */}
          {delta ? (
            <span className={'lc-detail-metric' + (net > 0 ? ' lc-detail-metric-up' : net < 0 ? ' lc-detail-metric-down' : '')}>
              {t('tip.delta', { n: (net > 0 ? '+' : '') + fmt(net) })}
            </span>
          ) : null}
          {!delta && req.prompt !== undefined
            ? <span className="lc-detail-metric">{t('detail.actual', { n: fmt(req.prompt) })}</span>
            : null}
          {!delta && req.output !== undefined
            ? <span className="lc-detail-metric">{t('detail.output', { n: fmt(req.output) })}</span>
            : null}
          {!delta && req.prompt !== undefined && req.cacheRead !== undefined
            ? <span className="lc-detail-metric">{t('detail.cache', { n: cacheHitPercent(req.cacheRead, req.prompt) ?? '—' })}</span>
            : null}
        </div>
        <BriefSection brief={props.brief} convOf={props.convOf} onLocate={props.onLocate} />
        {/* 镜像共享的类别悬停，但关掉了提示——跨卡片的悬停不得在指针并不停驻的
            柱子上再浮出第二个提示（与浏览器自己的条同一规则）。 */}
        <StackedBar parts={parts} height={10} hoverKey={props.hoverKey} tip={false} />
        <div className="lc-detail-rows">
          {CATS.map((c, i) => {
            const v = delta ? deltas[i] : req[c.key] || 0
            const mag = Math.abs(v)
            return (
              <div key={c.key} className={'lc-detail-row' + (props.hoverKey === c.key ? ' lc-detail-row-on' : '')}>
                <i style={{ background: c.color }} />
                <span className="lc-detail-label">{catLabel(c.key)}</span>
                <span className="lc-bar-track">
                  {delta ? (
                    <>
                      {/* 呼应图表的小型发散条：零在中点，增长向右填充，
                          缩减向左填充，各行共用同一刻度。 */}
                      <span className="lc-bar-zero" />
                      {v !== 0 ? (
                        <span
                          className={'lc-bar-fill ' + (v > 0 ? 'lc-bar-fill-up' : 'lc-bar-fill-down')}
                          style={{ width: `${mag / maxAbs * 50}%`, background: c.color }}
                        />
                      ) : null}
                    </>
                  ) : (
                    <span className="lc-bar-fill" style={{ width: `${req.total > 0 ? v / req.total * 100 : 0}%`, background: c.color }} />
                  )}
                </span>
                {delta ? (
                  <span className={'lc-detail-num' + (v > 0 ? ' lc-detail-num-up' : v < 0 ? ' lc-detail-num-down' : '')}>
                    {(v > 0 ? '+' : '') + fmt(v)}
                  </span>
                ) : (
                  <span className="lc-detail-num">{'≈' + fmt(v)}</span>
                )}
                <span className="lc-detail-pct">{!delta && req.total > 0 ? `${Math.round(v / req.total * 100)}%` : ''}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  })
}
