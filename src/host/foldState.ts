/**
 * 时间线 fold 的持久 state 形状、它消费的事件信封，
 * 以及 state 的构造与保留上限——即 projection 缓存做 checkpoint 的那份纯 JSON。
 * 写它的 reducer 归 `fold.ts` 所有。
 */

import type { Category, ContextEventRecord, FileOpRecord, RequestRecord, SessionCostUsage, SurfaceNode, SystemPromptNode, TimingSpan, TimingTotals, TurnCostUsage } from '../shared/types'
import type { FoldBounds } from './config'

/** 本 fold 消费的运行时事件信封。核心 `SessionEvent` 联合类型只覆盖核心事件类型；
 * 由插件合并进来的词表（`dsh-compaction` 声明的 `compaction/*` 一族）不在其中，
 * 而 fold 又不能依赖那些包——因此放宽到这个结构化信封。 */
export interface TimelineEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: unknown
}

/** fold 的整个持久 state：存活 surface、保留下来的记录，
 * 以及整个 session 的累加器。每个可选字段都必须「缺席」
 * 而不是取值为 `undefined`（见 `model` 上的纯 JSON 说明）。 */
export interface TimelineState {
  /** 模型可见的 surface，最新的在最后。 */
  surface: SurfaceNode[]
  sums: Record<Category, number>
  systemTokens: number
  /** 存活的 system prompt 节点，由旧到新。`systemTokens` 取 tokens > 0 的最后一个条目（harness 自己的
   * 「最后一条非空存活 system」规则），因此一个空的休眠节点能保住位置，又不会清掉 prompt。
   * 上限为 SYSTEM_NODES_MAX。在字段出现之前折叠的行上缺失；
   * client 此时回落到 header epoch 自己的信封数字。 */
  systems?: SystemPromptNode[]
  toolsTokens: number
  /** projection 缓存要求纯 JSON：一个值为 `undefined` 的属性会让整份 checkpoint 无法序列化，
   * 该 session 的「每一次」缓存写入都会失败——包括重启后撑起 session 列表的 `title` 行。
   * 因此可选字段在有值之前保持缺席，绝不留成 `undefined`。 */
  model?: string
  provider?: string
  lastModel?: string
  contextWindow?: number
  requests: RequestRecord[]
  /** `requests` 中 turn run 的数量（一个 run = 共用同一 `turn` 的连续记录）。在唯一的追加点增量维护，
   * 裁剪替换数组时整体重算，因此保留裁剪的上限判断对每条事件保持 O(1)。
   * 在字段出现之前折叠的行上缺失。 */
  turnRuns?: number
  events: ContextEventRecord[]
  /** 最近被移除的 surface 节点（带 `gone` 标记的「副本」），按移除顺序排列。
   * 在 trimState 里受两重限制：上限为 `maxArchiveNodes`，且只保留最旧保留请求之后的移除项。 */
  archived: SurfaceNode[]
  /** 按 (provider, model) 累计的计费 token 总量，对 DeepSeek 再按时段拆分。从不裁剪，
   * 因此估算覆盖「完整」session 日志。 */
  cost?: SessionCostUsage
  /** 每轮消费账本（见 TurnCostUsage）。与 `cost` 由同一次 `accumulateCost` 写出，
   *  因此两者对同一次结算永远一致。键是十进制 turn 字符串。 */
  turnCost?: TurnCostUsage
  /** 整个 session 的人类输入计数（见 Snapshot.humanInputs）；与 `cost` 一样从不裁剪。 */
  humanInputs?: number
  /** 整个 session 的回复计数（见 Snapshot.answers）；与 `humanInputs` 一样从不裁剪。 */
  answers?: number
  /** 用户最新一条自己的消息，做成长度受限的单行预览。最新者胜：没有文本的输入（只有图片）保留上一行。 */
  lastUser?: string
  archiveFloor?: number
  /** 任何改动了 request 记录、context 事件、存活 surface 或已移除节点 archive 的 fold 都会抬高它；
   * 瘦身 wire head 带着它，打开的标签页因此知道已拉取的 detail 已经过期。 */
  detailRev?: number
  /** 整个 session 的计时汇总（见 TimingTotals），与 `cost` 一样是「完整」session 日志上的累计值。 */
  timing?: TimingTotals
  /** 开启中 step 的启动时刻，由 `step/start` 武装，被随后的 `assistant/message`（TTFT/生成阶段拆分）
   * 和 `step/end`（墙钟耗时）消费。只有一个槽位而非映射：日志里 step 是顺序的，因此这些事件闭合的
   * 就是最新的那个 `step/start`——敌意交错日志的代价是时长被跳过。 */
  stepStart?: {
    time: number
    firstToken?: number
  }
  /** 开启中 step 里「已闭合」的用户等待区间（真实日志时刻），每段等待结算时以替换方式推入：
   * 一次审批决策，或 `ask_user_question` 调用整个工具窗口。`step/end` 把它们钳制后的并集从
   * step 窗口里减去，用来计价该请求的 `activeMs`，随后删除该槽位。 */
  stepWaits?: { start: number; end: number }[]
  /** 开启中 step 里「待处理」的审批等待（请求 id → 其 `approval/asked` 时刻），由配对的
   * `approval/decided` 解除。若在决策途中崩溃，这对记录会悬空，因此 `step/end` 按自己的时刻
   * 收尾这些幸存项。在 `step/start`（被取代的 step 的残留）和 `step/end` 时删除。 */
  stepApprovals?: Record<string, number>
  /** 开启中 step 的 `assistant/message` 所提交的那条 request 记录的 seq——`step/end` 把 `activeMs`
   * 回写到这个指针上。step 的消息与结束之间不会有任何推入，因此该记录就是 requests 的尾部，
   * 这次落章是受该 seq 守护的 O(1) 尾部写入。 */
  stepRequestSeq?: number
  /** 时间条绘制的区间：每个已完成步骤的时间切片，按日志顺序排列，并带上真实时刻——
   * TTFT 等待、按流顺序的解码块、工具运行窗口，以及 step 内的残余。步骤「之间」的空闲时间不产生区间。
   * 上限为 TIMING_SPANS_MAX（保留最新尾部）。 */
  spans: TimingSpan[]
  /** 开启中 step 累积的绘制区间；`step/end` 把它们钳进 step 窗口，按「先到者胜」去重叠
   * （并行运行画的是其并集），用残余类型填洞，最后把整块铺排刷进 `spans`。
   * 刷入时删除（纯 JSON 前提）。 */
  stepSpans?: TimingSpan[]
  /** 工具 callId → 该调用的名称、启动时刻和原始参数，由 `tool/call` 武装，其 `tool/result` 折叠进来时
   * 「删除」——映射规模保持在待处理调用的量级，而不是随 session 寿命一直增长。 */
  callNames: Record<string, { name: string; start: number; argsRaw?: string }>
  /** 下一次替换将要遮蔽的 surface 节点 seq 列表，
   * 由计量事件（`compaction/summary` | `compaction/prune`）武装，
   * 并被必须同步紧随其后的那次替换消费。生产者给出的遮蔽价恰好覆盖这些 seq，
   * 它们可能与替换声明的范围不同（被裁剪的替换节点保留自己的 seq，落在范围终点之外）。 */
  pendingShadowedSeqs?: number[]
  /** 武装 `pendingShadowedSeqs` 的那条 `compaction/prune` 事件的 seq。遮蔽路径会把该事件的 `tokens`
   * 从粗略遮蔽价改写成「净释放」量，这一行才与趋势图显示的下降对得上。 */
  pendingShadowEventSeq?: number
  /** fold 推导出的文件操作日志：每次已执行的文件操作一条记录，上限为 `maxFileOps`；裁剪时落 `fileOpsFloor`。 */
  fileOps: FileOpRecord[]
  /** 被丢弃操作中最新的 seq（卡片上操作日志的覆盖水位）。 */
  fileOpsFloor?: number
  /** 嵌套 Code-Mode 操作按其顶层 run_code 调用 id 缓冲，直到父级结果折叠进来为止（派发事件先于它落地）。
   * 上限为 PENDING_CODE_OPS_MAX，因此永不结算 run_code 的敌意日志也无法把它撑大。 */
  pendingCodeOps?: Record<string, FileOpRecord[]>
}

/** `requests` 中最新的 `maxTurns` 个 turn run，从后往前走，未裁剪的超长数组因此只需一次反向扫描。
 * 没有 `turn` 编号的记录自成一个 run（它只与 `undefined` 相等），
 * 因此 turn 化之前的记录不会被并进相邻项。 */
export function trimToLastTurns(requests: RequestRecord[], maxTurns: number): RequestRecord[] {
  let runs = 0
  let start = requests.length
  let prevTurn: number | undefined
  for (let i = requests.length - 1; i >= 0; i--) {
    const turn = requests[i].turn
    if (turn !== prevTurn) {
      if (runs >= maxTurns) break
      runs++
      prevTurn = turn
    }
    start = i
  }
  return requests.slice(start)
}

/** `requests` 中的 run 数，也就是 `turn` 字段的跳变次数——裁剪后用于重算增量 `turnRuns`
 * 账本的那次 O(n) 计算。 */
export function countTurnRuns(requests: RequestRecord[]): number {
  let runs = 0
  let prevTurn: number | undefined
  for (const r of requests) {
    if (r.turn !== prevTurn) {
      runs++
      prevTurn = r.turn
    }
  }
  return runs
}

/** 对已追加完毕的 state 施加全部保留上限，
 * 并为每个被丢掉头部的集合抬高对应的覆盖水位。
 * 顺序很重要：request 裁剪会移动最旧保留 seq，它决定下面 archive 能丢多少。 */
export function trimState(st: TimelineState, bounds: FoldBounds): void {
  // 只要 run 数量越过上限就按「整个」turn run 裁剪——而不是等原始 step 数量越界才裁——这样 state 会稳定停驻在最新的约 maxKeptTurns 个 turn 上（只按阈值裁的策略会来回震荡：
  // 裁到 1200、长回 1500、
  // 再裁）。run 数量来自增量 `turnRuns` 账本；
  // 该字段出现之前从缓存恢
  // 复的行在这里重算一次。
  st.turnRuns = st.turnRuns ?? countTurnRuns(st.requests)
  if (st.turnRuns > bounds.maxKeptTurns) {
    st.requests = trimToLastTurns(st.requests, bounds.maxKeptTurns)
    st.turnRuns = countTurnRuns(st.requests)
  }
  // 病态的「一步数极多」turn：在 turn 裁剪之后再兜一道 step 硬上限。
  if (st.requests.length > bounds.maxRequestSteps) {
    st.requests = st.requests.slice(-bounds.maxRequestSteps)
    st.turnRuns = countTurnRuns(st.requests)
  }
  if (st.events.length > bounds.maxEvents) st.events = st.events.slice(-bounds.maxEvents)
  if (st.spans.length > TIMING_SPANS_MAX) st.spans = st.spans.slice(-TIMING_SPANS_MAX)
  // 被丢弃操作中最新的 seq 成为对外操作日志的覆盖水位。
  if (st.fileOps.length > bounds.maxFileOps) {
    const drop = st.fileOps.length - bounds.maxFileOps
    st.fileOpsFloor = Math.max(st.fileOpsFloor ?? 0, st.fileOps[drop - 1].seq)
    st.fileOps = st.fileOps.slice(drop)
  }
  if (st.archived.length > 0) {
    let drop = 0
    // 条目按移除顺序离开，因此最后一个被丢掉的条目的 `gone` 就是被丢弃的最新 seq。
    const oldestReq = st.requests.length > 0 ? st.requests[0].seq : undefined
    if (oldestReq !== undefined) {
      while (drop < st.archived.length
        && (st.archived[drop].gone ?? Infinity) <= oldestReq) drop++
    }
    if (st.archived.length - drop > bounds.maxArchiveNodes) {
      drop = st.archived.length - bounds.maxArchiveNodes
    }
    if (drop > 0) {
      const floor = st.archived[drop - 1].gone
      if (floor !== undefined) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor)
      st.archived = st.archived.slice(drop)
    }
  }
}

/** 数量上限，保留最新尾部；按每步约 6-8 个区间算，可覆盖最近几百步，远超时间条的像素分辨率。 */
const TIMING_SPANS_MAX = 2_000

/** 一份全新的空 state；`turnRuns` 从 0 起步，第一次 `trimState` 因此直接看到账本，
 * 而不是去重算（空的）数组。 */
export function createTimelineState(): TimelineState {
  return {
    surface: [],
    sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    systemTokens: 0,
    toolsTokens: 0,
    requests: [],
    turnRuns: 0,
    events: [],
    archived: [],
    callNames: {},
    fileOps: [],
    spans: [],
  }
}
