/** 计时卡片：会话的「活动」时间花到哪儿去了。环图把整步的墙钟时间拆成
 * 模型调用各段——TTFT（步骤开始 → 首个 token，即等待）与 LLM 生成（首个 token → 助手消息）——
 * 以及工具执行那一段，残余部分算作额外开销；一次其流中
 * 没有记录任何 token 增量的调用（旧版或被中断）保持未归属，
 * 落进残余里。当宿主折叠出了生成拆分时（见
 * TimingTotals），生成那一段会展开为当时正在解码的东西：
 * 思考、回答文本，以及工具调用参数。各分段的行走先给出
 * 真实时长，再在次行用计数限定它——
 * 模型调用（TTFT）、工具运行，以及各解码分段自己的「块」数
 * （每次调用零到多个，所以那里用调用数会是假的计数）。一个
 * 从未发生的分段（时长为零）整体省略——环图本来就跳过
 * 它的弧，而一行零值会去借用会话的调用数，
 * 读起来像「没有时间，却调了很多次」。环图与各行并排放，
 * 好让头部那一行只占半高。并行的工具调用各自计数，所以工具
 * 那个数可以重叠——环图把它夹进模型之后的窗口，而
 * 行的数字保持真实。它们下方，会话时间条把每个
 * 已完成步骤的各段按发生顺序无缝压实（把 DNA 那套手法用在
 * 时间消耗上——每个带的宽度是它在累计活动
 * 时间中的占比，空闲时间不占轨道），
 * 并按「种类」接入同一套悬停联动。 */

import { useState, type ReactElement } from 'react'
import type { TimingSpan, TimingTotals } from '../../shared/types'
import type { ViewKit } from '../viewkit'

import { SliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import { makeTimingStrip, TIMING_COLOR } from './timingStrip'
import type { DonutProps, DonutSegment } from './donut'

/** 在占比算出来之前的一条环图/图例条目。 */
interface Slice {
  key: string
  color: string
  label: string
  /** 真实时长（行里打印的是它；环图会把它夹进自己的窗口）。 */
  ms: number
  /** 次行的限定语（调用/运行/块的计数），没有时缺失。 */
  times?: string
}

/** 卡片的环形调色板（timingStrip.tsx 拥有它——条带画的是同一批种类）。 */
const COLOR = TIMING_COLOR

/** 解码吞吐数字，格式与 harness 自己的
 * session-stats 槽位完全一致：十以上取整数，以下保留一位小数。 */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** 绑定 `kit` 与共享的 `Donut`，返回计时卡片。可选的 `spans` 是
 *  条带要压实的逐步时间分段；拿不到它们的调用方（跨会话聚合，或
 *  在集合存在之前就已折叠的行）得到一张没有条带的卡片。 */
export function makeStatsTiming(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  timing: TimingTotals | null
  /** 计时条带画出的各时间跨度（明细通道的逐步时间
   * 分段）。在 overview 的跨会话聚合卡片上，以及在
   * 集合存在之前就已折叠的行上缺失——此时卡片不显示条带。 */
  spans?: TimingSpan[]
}) => ReactElement {
  const { t, fmt, fmtDuration, fmtShare } = kit
  const TimingStrip = makeTimingStrip(kit)
  return function StatsTiming(props: { timing: TimingTotals | null; spans?: TimingSpan[] }): ReactElement {
    // 图例行 ↔ 环图分段的悬停联动（共享 key，两侧都可设置）。
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const timing = props.timing
    const wall = timing !== null && Number.isFinite(timing.wallMs) && timing.wallMs > 0 ? timing.wallMs : 0
    // 吞吐数字：宿主的配对方式与 harness session-stats 的折叠
    // 完全一致（provider 输出 token 对解码窗口），所以
    // 两个数字绝不会互相矛盾。读取不了或缺失的配对（较旧的缓存行）不渲染任何数字。
    const tps = timing !== null
      && typeof timing.speedMs === 'number' && Number.isFinite(timing.speedMs) && timing.speedMs > 0
      && typeof timing.speedTokens === 'number' && Number.isFinite(timing.speedTokens) && timing.speedTokens >= 0
      ? formatTokensPerSecond(timing.speedTokens / (timing.speedMs / 1_000))
      : null
    let segments: DonutSegment[] = []
    let rows: SliceRow[] = []
    if (timing !== null && (wall > 0 || timing.calls > 0 || timing.toolCalls > 0)) {
      // 模型各段从步骤开始跑到它的助手消息——
      // TTFT 到首个 token，生成从那里算起；工具在之后运行。
      const callTimes = t('timing.callTimes', { n: fmt(timing.calls) })
      const modelSlices: Slice[] = [
        { key: 'ttft', color: COLOR.ttft, label: t('timing.ttft'), ms: timing.ttftMs, times: callTimes },
      ]
      // 生成窗口要么展开成它的解码分桶，要么保持
      // 为一段。只有分桶真的带时间时才显示拆分：
      // 没有折叠出拆分的宿主（较旧的缓存行）只给 `genMs`，
      // 而一个流里带 token 增量但没有块标记的日志
      // （分桶全零）保持未拆分的形状，而不是三行死数据。
      // 缺失的分桶读作 0（宿主会省略零长度的跨度）。
      // 这些分段用自己的「块」计数来限定，绝不用调用
      // 数：一次模型调用会产出零到多个解码块（单次调用
      // 常会请求好几个工具，而多数调用根本不产出推理），
      // 所以调用数会被读成一个逐分段的计数，而那并不成立。
      // TTFT 与工具保留各自的计数——它们每次调用/运行恰好发生一次。
      // 没有折叠出计数的宿主（较旧的缓存行）只给时长。
      const blockTimes = (blocks?: number): string | undefined =>
        blocks !== undefined && blocks > 0 ? t('timing.blockTimes', { n: fmt(blocks) }) : undefined
      const buckets: [key: string, color: string, label: string, ms: number, times?: string][] = [
        ['reasoning', COLOR.reasoning, t('timing.reasoning'), timing.reasoningMs ?? 0, blockTimes(timing.reasoningBlocks)],
        ['text', COLOR.text, t('timing.text'), timing.textMs ?? 0, blockTimes(timing.textBlocks)],
        ['toolarg', COLOR.toolarg, t('timing.toolArgs'), timing.toolArgMs ?? 0, blockTimes(timing.toolArgBlocks)],
      ]
      const split = buckets.some(([, , , ms]) => ms > 0)
      if (split) {
        for (const [key, color, label, ms, times] of buckets) {
          modelSlices.push({ key, color, label, ms, ...(times !== undefined ? { times } : {}) })
        }
      } else {
        modelSlices.push({ key: 'gen', color: COLOR.reasoning, label: t('timing.gen'), ms: timing.genMs })
      }
      // 环图各窗口：TTFT，然后是生成窗口，接着是工具用剩下的
      // 部分；残余则是额外开销。每个窗口都被夹进它前面那些窗口
      // 留出的空间里，所以一段恶意的超长分段（并行工具
      // 重叠）永远不能把环图推过墙钟——各行保留的
      // 才是真实总和。解码分桶按卡片顺序共享生成窗口；
      // 未拆分的形状则把那个窗口全给 `gen`。
      const ttftRing = Math.min(timing.ttftMs, wall)
      const genRing = Math.max(0, Math.min(timing.genMs, wall - ttftRing))
      const modelRings: number[] = [ttftRing]
      let used = ttftRing
      const genEnd = ttftRing + genRing
      for (const slice of modelSlices.slice(1)) {
        const take = Math.max(0, Math.min(slice.ms, genEnd - used))
        modelRings.push(take)
        used += take
      }
      const toolRing = Math.max(0, Math.min(timing.toolsMs, wall - ttftRing - genRing))
      const other = Math.max(0, wall - ttftRing - genRing - toolRing)
      // 分段占比以墙钟总量为分母；每个值都已经被夹进
      // [0, wall]，所以这个比例不需要再设边界。
      const share = (ms: number): number => (wall > 0 ? ms / wall : 0)
      // 次行先给时长，再用调用数限定它；
      // 时长为零的分段只保留计数（它那条短横线没有什么可限定）。
      const countOf = (ms: number, times?: string): string => {
        const dur = fmtDuration(ms)
        if (times === undefined) return dur
        return ms > 0 ? `${dur} · ${times}` : times
      }
      const modelSegments = modelSlices.map((slice, index) => ({
        key: slice.key, color: slice.color, value: share(modelRings[index]),
      }))
      const toolSlice: Slice = {
        key: 'tools',
        color: COLOR.tools,
        label: t('timing.tools'),
        ms: timing.toolsMs,
        times: t('timing.toolTimes', { n: fmt(timing.toolCalls) }),
      }
      const otherSlice: Slice = { key: 'other', color: COLOR.other, label: t('timing.other'), ms: other }
      segments = [
        ...modelSegments,
        { key: 'tools', color: COLOR.tools, value: share(toolRing) },
        { key: 'other', color: COLOR.other, value: share(other) },
      ]
      const toRow = (slice: Slice): SliceRow => ({
        key: slice.key,
        color: slice.color,
        label: slice.label,
        dim: slice.ms === 0,
        pct: fmtShare(slice.ms, wall),
        count: countOf(slice.ms, slice.times),
      })
      // 从未发生的分段是「隐藏」而不是显示成一行零值：
      // 一行还带着计数的 "0.0%"（"— · 323 calls"）会被读成
      // 「它 323 次都没花时间」，而事实是那里什么都没有运行、没有解码。
      // 环图本来就跳过零弧，所以图例现在与它一致。
      // 每个分段都是墙钟总量的占比，所以删行绝不会扭曲剩下那些百分比。
      rows = [
        ...modelSlices.map(toRow),
        toRow(toolSlice),
        toRow(otherSlice),
      ].filter(row => !row.dim)
    }
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('timing.title')}</span>
          {tps !== null && (
            <span className="lc-card-rate" title={t('timing.tpsTip')}>{t('timing.tps', { tps })}</span>
          )}
        </div>
        {rows.length === 0
          ? <div className="lc-empty">{t('timing.empty')}</div>
          : (
            <>
              <div
                className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap"
              >
                {/* 环图 + 图例行：卡片 320px 时间隙收拢，低于 240px 时该行换行，
                    环图居中于占满整宽的图例之上（以 lc-card 容器为准）。 */}
                <Donut
                  segments={segments}
                  size={96}
                  centerTop={wall > 0 ? fmtDuration(wall) : '—'}
                  centerSub={t('timing.total')}
                  hoverKey={hoverKey}
                  onHoverKey={setHoverKey}
                />
                <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
              </div>
              {/* 会话时间条也接入这套悬停联动：悬停某段会点亮
                  同类别的每一段，以及环图弧与图例行，
                  而来自图例/环图的悬停则点亮条带上对应的各段。 */}
              {props.spans !== undefined && props.spans.length > 0
                ? <TimingStrip spans={props.spans} hoverKey={hoverKey} onHoverKey={setHoverKey} />
                : null}
            </>
          )}
      </div>
    )
  }
}
