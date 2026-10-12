
import { z } from "zod";
import "@deepseek-ai/dsh-session";
import z$1 from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/host/activity.d.ts
/** activity 单元的持久 state：日账本，外加进行中的路由与 skill 槽位。 */
interface ActivityState {
  days: Record<string, ActivityDay>;
  /** 当前生效的路由（最后一条 `request/header` 的 config 胜出）——每次结算都按它计价。 */
  model?: string;
  provider?: string;
  /** 开启中 step 的启动时刻（由 `step/start` 武装，由 `step/end` 清除）。 */
  stepStart?: number;
  /** 待配对的 `skill` 工具调用 id（由 `tool/call` 武装，被配对的 `tool/result` 消费）：
   * 光靠 wrapper 匹配不足为信，否则一次读到引用了
   * `<skill_content name="…">` 的源码文本就会被记成一次加载。上限见 {@link MAX_PENDING_SKILL_CALLS}。 */
  skillCalls?: string[];
}
//#endregion
//#region src/host/headers.d.ts
/** 一个存储的工具：v1 行带着生产者 description 和原始 schema；之后的 fold 只追加元数据。 */
interface StoredHeaderTool {
  name: string;
  tokens: number;
  description?: string;
  plugin?: string;
  schema?: unknown;
}
/** 一个存储的 epoch：v1 行带的是 `system`；之后的 fold 带 `systemTokens`。 */
interface StoredHeaderRecord {
  seq: number;
  time: number;
  system?: string;
  systemTokens?: number;
  tools: StoredHeaderTool[];
}
/** headers 单元的持久 state：epoch 元数据行，由旧到新。 */
interface HeadersState {
  headers: StoredHeaderRecord[];
}
//#endregion
//#region src/host/foldState.d.ts
/** fold 的整个持久 state：存活 surface、保留下来的记录，
 * 以及整个 session 的累加器。每个可选字段都必须「缺席」
 * 而不是取值为 `undefined`（见 `model` 上的纯 JSON 说明）。 */
interface TimelineState {
  /** 模型可见的 surface，最新的在最后。 */
  surface: SurfaceNode[];
  sums: Record<Category, number>;
  systemTokens: number;
  /** 存活的 system prompt 节点，由旧到新。`systemTokens` 取 tokens > 0 的最后一个条目（harness 自己的
   * 「最后一条非空存活 system」规则），因此一个空的休眠节点能保住位置，又不会清掉 prompt。
   * 上限为 SYSTEM_NODES_MAX。在字段出现之前折叠的行上缺失；
   * client 此时回落到 header epoch 自己的信封数字。 */
  systems?: SystemPromptNode[];
  toolsTokens: number;
  /** projection 缓存要求纯 JSON：一个值为 `undefined` 的属性会让整份 checkpoint 无法序列化，
   * 该 session 的「每一次」缓存写入都会失败——包括重启后撑起 session 列表的 `title` 行。
   * 因此可选字段在有值之前保持缺席，绝不留成 `undefined`。 */
  model?: string;
  provider?: string;
  lastModel?: string;
  contextWindow?: number;
  requests: RequestRecord[];
  /** `requests` 中 turn run 的数量（一个 run = 共用同一 `turn` 的连续记录）。在唯一的追加点增量维护，
   * 裁剪替换数组时整体重算，因此保留裁剪的上限判断对每条事件保持 O(1)。
   * 在字段出现之前折叠的行上缺失。 */
  turnRuns?: number;
  events: ContextEventRecord[];
  /** 最近被移除的 surface 节点（带 `gone` 标记的「副本」），按移除顺序排列。
   * 在 trimState 里受两重限制：上限为 `maxArchiveNodes`，且只保留最旧保留请求之后的移除项。 */
  archived: SurfaceNode[];
  /** 按 (provider, model) 累计的计费 token 总量，对 DeepSeek 再按时段拆分。从不裁剪，
   * 因此估算覆盖「完整」session 日志。 */
  cost?: SessionCostUsage;
  /** 每轮消费账本（见 TurnCostUsage）。与 `cost` 由同一次 `accumulateCost` 写出，
   *  因此两者对同一次结算永远一致。键是十进制 turn 字符串。 */
  turnCost?: TurnCostUsage;
  /** 整个 session 的人类输入计数（见 Snapshot.humanInputs）；与 `cost` 一样从不裁剪。 */
  humanInputs?: number;
  /** 整个 session 的回复计数（见 Snapshot.answers）；与 `humanInputs` 一样从不裁剪。 */
  answers?: number;
  /** 用户最新一条自己的消息，做成长度受限的单行预览。最新者胜：没有文本的输入（只有图片）保留上一行。 */
  lastUser?: string;
  archiveFloor?: number;
  /** 任何改动了 request 记录、context 事件、存活 surface 或已移除节点 archive 的 fold 都会抬高它；
   * 瘦身 wire head 带着它，打开的标签页因此知道已拉取的 detail 已经过期。 */
  detailRev?: number;
  /** 整个 session 的计时汇总（见 TimingTotals），与 `cost` 一样是「完整」session 日志上的累计值。 */
  timing?: TimingTotals;
  /** 开启中 step 的启动时刻，由 `step/start` 武装，被随后的 `assistant/message`（TTFT/生成阶段拆分）
   * 和 `step/end`（墙钟耗时）消费。只有一个槽位而非映射：日志里 step 是顺序的，因此这些事件闭合的
   * 就是最新的那个 `step/start`——敌意交错日志的代价是时长被跳过。 */
  stepStart?: {
    time: number;
    firstToken?: number;
  };
  /** 开启中 step 里「已闭合」的用户等待区间（真实日志时刻），每段等待结算时以替换方式推入：
   * 一次审批决策，或 `ask_user_question` 调用整个工具窗口。`step/end` 把它们钳制后的并集从
   * step 窗口里减去，用来计价该请求的 `activeMs`，随后删除该槽位。 */
  stepWaits?: {
    start: number;
    end: number;
  }[];
  /** 开启中 step 里「待处理」的审批等待（请求 id → 其 `approval/asked` 时刻），由配对的
   * `approval/decided` 解除。若在决策途中崩溃，这对记录会悬空，因此 `step/end` 按自己的时刻
   * 收尾这些幸存项。在 `step/start`（被取代的 step 的残留）和 `step/end` 时删除。 */
  stepApprovals?: Record<string, number>;
  /** 开启中 step 的 `assistant/message` 所提交的那条 request 记录的 seq——`step/end` 把 `activeMs`
   * 回写到这个指针上。step 的消息与结束之间不会有任何推入，因此该记录就是 requests 的尾部，
   * 这次落章是受该 seq 守护的 O(1) 尾部写入。 */
  stepRequestSeq?: number;
  /** 时间条绘制的区间：每个已完成步骤的时间切片，按日志顺序排列，并带上真实时刻——
   * TTFT 等待、按流顺序的解码块、工具运行窗口，以及 step 内的残余。步骤「之间」的空闲时间不产生区间。
   * 上限为 TIMING_SPANS_MAX（保留最新尾部）。 */
  spans: TimingSpan[];
  /** 开启中 step 累积的绘制区间；`step/end` 把它们钳进 step 窗口，按「先到者胜」去重叠
   * （并行运行画的是其并集），用残余类型填洞，最后把整块铺排刷进 `spans`。
   * 刷入时删除（纯 JSON 前提）。 */
  stepSpans?: TimingSpan[];
  /** 工具 callId → 该调用的名称、启动时刻和原始参数，由 `tool/call` 武装，其 `tool/result` 折叠进来时
   * 「删除」——映射规模保持在待处理调用的量级，而不是随 session 寿命一直增长。 */
  callNames: Record<string, {
    name: string;
    start: number;
    argsRaw?: string;
  }>;
  /** 下一次替换将要遮蔽的 surface 节点 seq 列表，
   * 由计量事件（`compaction/summary` | `compaction/prune`）武装，
   * 并被必须同步紧随其后的那次替换消费。生产者给出的遮蔽价恰好覆盖这些 seq，
   * 它们可能与替换声明的范围不同（被裁剪的替换节点保留自己的 seq，落在范围终点之外）。 */
  pendingShadowedSeqs?: number[];
  /** 武装 `pendingShadowedSeqs` 的那条 `compaction/prune` 事件的 seq。遮蔽路径会把该事件的 `tokens`
   * 从粗略遮蔽价改写成「净释放」量，这一行才与趋势图显示的下降对得上。 */
  pendingShadowEventSeq?: number;
  /** fold 推导出的文件操作日志：每次已执行的文件操作一条记录，上限为 `maxFileOps`；裁剪时落 `fileOpsFloor`。 */
  fileOps: FileOpRecord[];
  /** 被丢弃操作中最新的 seq（卡片上操作日志的覆盖水位）。 */
  fileOpsFloor?: number;
  /** 嵌套 Code-Mode 操作按其顶层 run_code 调用 id 缓冲，直到父级结果折叠进来为止（派发事件先于它落地）。
   * 上限为 PENDING_CODE_OPS_MAX，因此永不结算 run_code 的敌意日志也无法把它撑大。 */
  pendingCodeOps?: Record<string, FileOpRecord[]>;
}
//#endregion
//#region src/shared/types.d.ts
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 插件的时间线：拆分世代里是瘦身 head，无独立通道的 host 上是内联值；
     * 键缺失表示 host 这一半没有装配。 */
    contextTimeline: ContextTimeline;
    /** 请求头内容 epoch——单独成一个单元，让高频读取的 timeline 值保持精简；
     * 键缺失表示 host 版本较旧（只有 token）。 */
    contextHeaders: ContextHeaders;
    /** Context Insights 热力图背后的每日活动账本；键缺失表示 host 版本较旧（热力图为空）。 */
    contextActivity: ContextActivity;
  }
  interface SessionProjectionStateMap {
    contextTimeline: TimelineState;
    contextHeaders: HeadersState;
    contextActivity: ActivityState;
  }
}
/** 参与计价的 surface 分桶。`skill` 承载 harness 注入的 skill 机制内容：
 * `<available_skills>` 摘要、`/name` 调用带入的指令，以及 `skill` 工具的加载。 */
type Category = 'user' | 'inject' | 'skill' | 'assistant' | 'tool';
/** 一个存活的 system prompt 节点；harness 把 prompt 建模成 surface 节点，其文本从 `seq` 处的
 * `system/message` 事件取回。生效金额取 `tokens > 0` 的最后一个节点。 */
interface SystemPromptNode {
  seq: number;
  time: number;
  tokens: number;
}
/** 在保留下来的 request/event 记录上预先算好的计数；`steps` 即保留的 request 记录数。 */
interface TimelineCounts {
  turns: number;
  steps: number;
  injects: number;
  compactions: number;
  prunes: number;
  /** 保留事件中带 `sub: 'skill'` 标记的去重名称数；`<available_skills>`
   * 摘要没有名字，从不计入。缺失 = 0。 */
  skills?: number;
}
/** 最新一条保留 request 记录的计费摘要；`prompt` 是该请求携带 usage 时 provider 报告的
 * prompt 大小。 */
interface TimelineLast {
  seq: number;
  total: number;
  prompt?: number;
}
/** 每日账本的一行：计费量，外加热力图可下钻查看的成本与 skill 明细。 */
interface ActivityDay {
  /** 当天由 provider 报告 usage 得出的计费 token（输入 + 缓存读/写 + 输出）；
   * 没有结算的请求只计入 `requests`。 */
  tokens: number;
  /** 当天已完成的模型调用（assistant 结算）数。 */
  requests: number;
  /** 当天的计费分桶，按 provider → model → 计价时段索引，归属以请求「发起」的那天为准。
   * 缺失 = 只有 token 的柱形。 */
  cost?: SessionCostUsage;
  /** skill 名 → `{ n: 加载次数, last: 末次加载的 epoch 毫秒 }`；缺失 = 当天无数据。 */
  skills?: Record<string, {
    n: number;
    last: number;
  }>;
}
/** 单 session 的每日账本：host 本地日键（`YYYY-MM-DD`，shared/days.ts）→ 当天计费量；
 * Context Insights 页面会合并所列 session 的全部账本。 */
interface ContextActivity {
  days: Record<string, ActivityDay>;
}
/** 一个可用 skill 的目录元数据，由 `/api/dsh-cost-breakdown/skills` 提供（host/skills.ts）；除 `name` 外每个字段都是尽力而为。 */
interface SkillInfo {
  /** 短横线连接（kebab-case）的标识符——关联到 `ActivityDay.skills` 的连接键。 */
  name: string;
  description: string;
  /** 指令文件的绝对路径，仅当 provider 基于文件系统时存在。 */
  path?: string;
  /** 发现来源分桶（例如 'project-agents'、'user-dsh'、'bundled'）。 */
  source?: string;
}
/** `dsh-cost-breakdown` 条目的展示偏好词表——Host Config schema（host/config.ts）与
 * Client 设置表单（client/settings.ts）共用的唯一声明。
 * 时间线按什么粒度切片：每个请求一行，还是整个 turn 一行。 */
type DefaultGranularity = 'step' | 'turn';
/** 成本曲线画的是累计花费，还是每步增量。 */
type DefaultTrendMode = 'total' | 'delta';
/** 浏览器的增量基线：与紧邻的上一条记录比，还是与上一个 turn 的最后一步比。 */
type DefaultDeltaBase = 'step' | 'turn';
/** 文件操作表的排序方式：按命中次数、按最近操作，还是按路径。 */
type DefaultFileSort = 'count' | 'latest' | 'path';
/** 工具用量排名的排序方式：按 token 量、调用次数，还是按名称。 */
type DefaultToolSort = 'size' | 'count' | 'name';
/** dock 的挂载位置：所有位置、只在标签页，还是只在侧边栏。 */
type DefaultPlacement = 'all' | 'tab' | 'sidebar';
/** 从 dock 是否能进入 Insights 入口。 */
type InsightsEntry = 'show' | 'hide';
/** session 时间条是否绘制时长曲线。 */
type DefaultDurationCurve = 'show' | 'hide';
/** 按用户持久化的展示偏好；host schema 为每个字段都给了默认值，
 * 因此 client 读取时无需判空。 */
interface PluginSettings {
  defaultPlacement: DefaultPlacement;
  defaultGranularity: DefaultGranularity;
  defaultTrendMode: DefaultTrendMode;
  defaultDeltaBase: DefaultDeltaBase;
  defaultToolSort: DefaultToolSort;
  defaultFileSort: DefaultFileSort;
  insightsEntry: InsightsEntry;
  defaultDurationCurve: DefaultDurationCurve;
}
/** Host 推送、Client 渲染的整个 `contextTimeline` 值；集合字段
 * （`requests`、`events`、`nodes`、`archive`）在瘦身 head 上是空的，由 {@link ContextTimelineDetail}
 * 换入。`counts`/`last`/`detailRev` 只在这种拆分形态里存在。 */
interface Snapshot {
  ok: boolean;
  /** 仅在运行中的 harness 低于受支持基线时出现：host 不做任何 fold（所有数字为 0），
   * client 展示升级提示。 */
  unsupported?: {
    current: string;
    minimum: string;
  };
  model?: string;
  provider?: string;
  contextWindow?: number;
  current: {
    system: number;
    tools: number;
    user: number;
    inject: number;
    skill: number;
    assistant: number;
    tool: number;
    total: number;
  };
  /** 当前上下文中的图片块数（用户上传加上工具结果里嵌套的图片），在存活 surface 节点上求和。缺失 = 0。 */
  images?: number;
  /** 结果仍存活的工具调用数（`skill` 工具的节点照样计入）；进行中以及已被压缩/裁剪掉的
   * 调用不计。缺失 = 0。 */
  toolCalls?: number;
  /** 整个 session 的统计：非注入的 `user/message`，加上已作答的 `ask_user_question`——
   * 完整日志上的累计值。缺失 = 0。 */
  humanInputs?: number;
  /** 整个 session 的回复数：每条带非空白文本的 assistant 消息算一次（纯工具调用的步骤不算回复）。缺失 = 0。 */
  answers?: number;
  /** 最新一条用户自己的消息的单行预览（取第一个文本块，空白折叠，最长 80 字符）。缺失 = 不展示。 */
  lastUser?: string;
  /** 拆分世代的 head 字段——恰好只在 host 提供瘦身 head 时出现；
   * detail 集合每次变化都会抬高 `detailRev`。 */
  counts?: TimelineCounts;
  last?: TimelineLast;
  detailRev?: number;
  /** 瘦身 head 里这些字段是空的（集合走 detail 通道）；client 会换入 detail payload 里的集合。 */
  requests: RequestRecord[];
  events: ContextEventRecord[];
  /** session 成本的累计原料（SessionCostUsage）；在出现已知模型且报告了 usage 的请求之前缺失。 */
  cost?: SessionCostUsage;
  /** 每轮（turn）的消费原料（TurnCostUsage）；在出现已知模型、报告了 usage 且带 `turn` 的
   *  请求之前缺失。与会话级 `cost` 由同一次定价写出，两者不会互相矛盾。 */
  turnCost?: TurnCostUsage;
  /** 整个 session 的计时汇总（TimingTotals）。首个 step 生命周期走完之前缺失。 */
  timing?: TimingTotals;
  /** 存活的 system prompt 节点，由旧到新。在字段出现之前折叠出的行上缺失——
   * client 此时读 header epoch 的 `systemTokens`。 */
  systems?: SystemPromptNode[];
  /** 对外提供的存活 surface：最新 `maxNodes` 条尾部，外加所有比该尾部更早的存活 inject/skill
   * 节点（它们先落地并被钉住）。按 seq 排序，由旧到新。 */
  nodes: SurfaceNode[];
  /** 未对外提供的存活节点：超出 `maxNodes` 的部分减去被钉住的 inject/skill 节点。 */
  droppedNodes: number;
  /** 最近被移除的 surface 节点（压缩/裁剪留下的影子），带 `gone` 标记（替换事件的 seq）；
   * 当 `seq < R.seq && (gone undefined || gone > R.seq)` 时，该节点属于请求 R。 */
  archive: SurfaceNode[];
  /** 未提供的 `droppedNodes` 个节点中最大的 seq；仅当 droppedNodes > 0 时出现。 */
  surfaceFloor?: number;
  /** 因保留上限被丢弃的 archive 条目中最新的 `gone`；低于它的 step 可能缺少已移除节点。 */
  archiveFloor?: number;
  /** fold 推导出的文件操作日志及其裁剪水位：只出现在内联值和 detail payload 里，绝不在瘦身 head 中。 */
  fileOps?: FileOpRecord[];
  fileOpsFloor?: number;
  /** 时间条绘制的区间段：只在内联值和 detail payload 里；在集合出现之前折叠出的行上缺失。 */
  spans?: TimingSpan[];
}
/** 拆分世代按需拉取的 DETAIL payload：瘦身 head 不再携带的沉重集合
 * （host/detail.ts）。`rev` 与 head 的 `detailRev` 对应，是 client 的「最新者胜」游标。 */
interface ContextTimelineDetail {
  rev: number;
  /** 与集合处在同一 fold 切点的瘦身 head——冷列出的 session 没有 `contextTimeline`
   * 行，Agent 关系环因此读它。可选。 */
  head?: ContextTimeline;
  requests: RequestRecord[];
  events: ContextEventRecord[];
  nodes: SurfaceNode[];
  droppedNodes: number;
  archive: SurfaceNode[];
  surfaceFloor?: number;
  archiveFloor?: number;
  /** 覆盖完整日志的文件操作日志（shared/fileOps.ts）；Code-Mode 的嵌套派发登记在其父 run_code 结果上（`parent`）。 */
  fileOps?: FileOpRecord[];
  /** 操作日志发生裁剪时，被丢弃操作中最新的 seq（如实反映覆盖范围，与 archiveFloor 同类）。 */
  fileOpsFloor?: number;
  /** 已完成步骤的时间切片，按日志顺序排列，位置取真实时刻。缺失 = 不画时间条。 */
  spans?: TimingSpan[];
}
/** 一次已执行的文件操作，由 host 从持久工具生命周期折叠而来（`tool/call` +
 * `tool/result`，或嵌套的 `tool/ptc-dispatch`）；行数增减是从调用 ARGUMENTS 读出的估算值。
 * `gone` 由 client 关联得出，不是 host 打的标记。 */
interface FileOpRecord {
  seq: number;
  /** 操作涉及的文件；对无路径的搜索则是被搜索的 pattern（`pattern: true`）。 */
  path: string;
  kind: 'read' | 'write' | 'search';
  tool: string;
  time?: number;
  err: boolean;
  added: number;
  removed: number;
  /** 被搜索的 pattern；调用带了 include 过滤时一并附上。 */
  detail?: string;
  /** 仅限由 meta 归因的搜索操作：结果为此文件报告的命中行数。 */
  hits?: number;
  /** 仅限读取操作：结果 meta 报告的确切窗口（从 1 起算），否则用 `limit` 参数估算（`est: true`）。 */
  read?: {
    start: number;
    count: number;
  } | {
    count: number;
    est: true;
  };
  /** 仅限嵌套 Code-Mode 操作：该操作运行时所依附的 run_code 结果节点（定位目标）。 */
  parent?: number;
  /** 仅限嵌套 Code-Mode 操作：run_code 程序由模型撰写的 description。 */
  program?: string;
  /** 被搜索的 pattern 标记：此时 `path` 是 pattern 而非文件——展示时不能对它做相对路径化。 */
  pattern?: true;
  /** 由 client 关联上的 archive 标记（见类型说明）；不落在 wire 上。 */
  gone?: number;
}
/** `contextTimeline` projection 的完整值；这里的 `ok` 恒为 `true`（保留是为兼容 wire）。 */
type ContextTimeline = Snapshot;
/** 计时卡片 session 时间条上的一段（某一步的 TTFT 等待、解码块、
 * 工具运行窗口或残余间隙）。`start`/`end` 是切片的真实时刻；时间条按日志顺序
 * 无缝拼接它们，且 `end` 恒大于 `start`。 */
interface TimingSpan {
  /** 计时卡片自己的切片词表（同样的键，同样的颜色）。 */
  kind: 'ttft' | 'reasoning' | 'text' | 'toolarg' | 'tools' | 'other';
  start: number;
  end: number;
}
/** 某个计价分桶的累计计费 token：完整 session 日志上的累计值，从不裁剪。 */
interface CostBucketTotals {
  uncached: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
/** 计时卡片排名背后的按工具名统计的墙钟耗时。 */
interface ToolTimingTotals {
  calls: number;
  ms: number;
}
/**
 * 整个 session 的计时汇总，由 host 从持久 step/tool 生命周期加上调用的首个 token（内嵌于`assistant/message.data.stream`）
 * 折叠而来；完整日志上的累计值。
 *
 * 单位毫秒：`wallMs` 汇总整个 step；`ttftMs` 是 step 开始 → 解码开始这一段，
 * `genMs`是解码开始 → assistant 消息这一段（只统计流里带过 token 增量的调用）；
 * `toolsMs` 汇总每次调用的工具耗时（并行调用各计各的）。
 * 解码窗口从第一个「可观测」瞬间起算——首个 token，
 * 或更早的 `block-start` 标记（被涂掉的 reasoning 块不留下任何 chunk）：
 * 若以 token 为锚，会把标记铺开的那段窗口重复计算，超过 100%。
 *
 * 生成阶段拆分来自流的 `block-start` 框架信息（`blockType`）：
 * `reasoningMs` /`textMs` / `toolArgMs` 及各自的块数，每个标记占据到下一个标记之前的区间。
 * `speedTokens`/`speedMs` 是与 harness 对齐的吞吐量口径（首 token → assistant 消息，
 * 两者都有的调用才计）；`speedMs` 保留首 token 作为锚。
 * `calls` 统计折叠出的 assistant 消息数，`toolCalls` 统计折叠出的 call/result 对。
 */
interface TimingTotals {
  wallMs: number;
  ttftMs: number;
  genMs: number;
  reasoningMs?: number;
  reasoningBlocks?: number;
  textMs?: number;
  textBlocks?: number;
  toolArgMs?: number;
  toolArgBlocks?: number;
  speedTokens?: number;
  speedMs?: number;
  calls: number;
  toolsMs: number;
  toolCalls: number;
  /** 计时卡片排名背后的按工具名统计（有上限）。 */
  tools: Record<string, ToolTimingTotals>;
}
/** 某个计费模型的汇总，按计价时段拆分：没有分时段计价的 provider 把全部量记在 `peak` 下；
 * DeepSeek 的 `peak` 按标价、`off` 按半价。 */
interface CostModelUsage {
  peak?: CostBucketTotals;
  off?: CostBucketTotals;
}
/** session 成本的原料：请求信封的 DSH provider id（没有时为空串）与 model id 逐级索引的
 * 累计 provider 报告计费 token——即 Client 的 models.dev 价目表用来查价的面。 */
interface SessionCostUsage {
  [provider: string]: {
    [model: string]: CostModelUsage;
  };
}
/** 单轮（turn）的消费原料。
 *
 * 为什么要单独存一份：会话级的 `cost` 只累计到会话，无法回答「这一轮花了多少」。
 * 归因的是**这一轮自己的请求**（`turn` 取自请求信封），不是两次累计值相减——
 * 后者在并行/交错的请求下会算错。 */
interface TurnCostEntry {
  /** 该轮的计价账本，与会话级 `cost` **同形**，因此走同一个定价函数、
   *  同一套峰谷规则，汇总卡与每轮读数不会对同一次结算给出两个答案。 */
  usage: SessionCostUsage;
  /** 该轮按 provider → model 计的**请求次数**。按次计费的平台（如积分制）用它，
   *  因为那类账单与 token 量无关，一次请求就是一次扣费。 */
  requests: {
    [provider: string]: {
      [model: string]: number;
    };
  };
}
/** turn → 该轮的消费原料。键是十进制字符串，JSON 往返不改形状。 */
interface TurnCostUsage {
  [turn: string]: TurnCostEntry;
}
/** surface 上一条模型可见的消息，及其启发式估算的 token 价。 */
interface SurfaceNode {
  seq: number;
  time?: number;
  cat: Category;
  tokens: number;
  /** 该节点消息内部的图片块数（为 0 时缺失）。 */
  imgs?: number;
  /** 仅 `archive` 条目会设置：遮蔽掉该节点的替换事件的 seq。 */
  gone?: number;
  form?: string;
  /** 对应 inject 事件点名的生产者身份（host pricing.ts 的
   * `injectionSourceName`）；不可读或早于该标记出现时缺失。 */
  name?: string;
  text?: string;
  tool?: string;
  err?: boolean;
  skill?: string;
  calls?: string[];
}
/** 一次已作答的模型调用（即一个 step）；同一 turn 的连续记录组成它。 */
interface RequestRecord {
  turn?: number;
  step?: number;
  time: number;
  seq: number;
  system: number;
  tools: number;
  user: number;
  inject: number;
  assistant: number;
  tool: number;
  total: number;
  prompt?: number;
  /** 该请求中 skill 机制内容的 token（即 `skill` 构成类别）；在类别出现之前折叠出的
   * 行上缺失（按 0 读）。 */
  skill?: number;
  /** 计费的缓存读取（命中缓存）prompt token——命中率的分子，分母是 `prompt`；
   * 旧 host 上缺失，而 0 是一个真实取值。 */
  cacheRead?: number;
  output?: number;
  /** 该 step 的活跃毫秒数（`step/start` → `step/end` 再减去 step 内的用户等待：
   * 审批决策与 `ask_user_question`），在 `step/end` 时落章；step 尚未结束时缺失。 */
  activeMs?: number;
  /** turn 模式聚合标记，由 Client 的 aggregateByTurn 设置（Host 从不设置）。 */
  stepCount?: number;
  /** 增量模式下带符号的净变化，由 Client 的 deltaOf 设置（Host 从不设置）。 */
  net?: number;
}
/** 一条持久的压缩/裁剪/注入/模型/模式事件，按 seq 排序；`form` 区分时间线渲染的
 * 子形态。 */
interface ContextEventRecord {
  seq: number;
  time: number;
  kind: 'compaction' | 'prune' | 'inject' | 'model' | 'mode';
  form?: string;
  tokens?: number;
  count?: number;
  sub?: string;
  name?: string;
  detail?: string;
  from?: string;
  to?: string;
  /** 紧挨在该事件之前记录的那条请求的 turn/step（host 打的标记）。 */
  fromTurn?: number;
  fromStep?: number;
  /** 该事件所归属请求的 turn/step（host 打的标记）。 */
  turn?: number;
  step?: number;
}
/** 某个请求头 epoch 中的一个工具，及其展示价。 */
interface HeaderTool {
  name: string;
  tokens: number;
  /** 已知时给出注册该工具的插件标签：MCP 工具是 `mcp:<server>`，否则查固定的
   * 一方插件映射；`UNKNOWN_TOOL_SOURCE` 标记启动期工具，缺失 = 无标签。 */
  plugin?: string;
}
/** 某个请求头 epoch 的元数据（epoch 边界与 token 价，从该 seq 起生效直到下一个）。
 * 内容刻意不放进 projection——否则每一行列表和每一帧推送都要带上它——改用
 * {@link HeaderEpochContent} 按需拉取。 */
interface HeaderRecord {
  seq: number;
  time: number;
  /** 该 epoch 估算的 system prompt token；没有记录 system prompt 时缺失。 */
  systemTokens?: number;
  tools: HeaderTool[];
}
/** `contextHeaders` projection 的值：有上限的 epoch 列表（最新的在最后）。 */
interface ContextHeaders {
  headers: HeaderRecord[];
}
/** 某一币种下的 DeepSeek 开放平台余额数字。 */
interface PlatformBalanceEntry {
  /** 平台报告的 ISO 币种代码（`CNY` / `USD`）。 */
  currency: string;
  /** 由 `granted` + `toppedUp` 推出，而不是读平台的 `total_balance`——后者的取整与两个分项各自独立。 */
  total: number;
  /** 尚未过期的赠送（granted）余额。 */
  granted: number;
  toppedUp: number;
}
/** DeepSeek 开放平台余额，由 `/api/dsh-cost-breakdown/balance` 提供；未配置或读取失败时
 * 在 wire 上为 `null`（不渲染任何内容）。 */
interface PlatformBalance {
  isAvailable: boolean;
  /** 账户持有的每个币种各一条；至少一条。 */
  balances: PlatformBalanceEntry[];
}
//#endregion
//#region src/host/config.d.ts
/** 随包提供的 fold 上限与基线节假日表；每个字段都可在条目级别覆盖。 */
declare const DEFAULT_BOUNDS: {
  maxRequestSteps: number;
  /** 保留的最新整 turn 窗口；裁剪以整 turn 为单位，绝不切在 turn 中间。 */
  maxKeptTurns: number;
  maxEvents: number;
  /** 仅作为病态 session 的兜底：每次推送都会带走整个值（每节点约 150B）。 */
  maxNodes: number;
  maxArchiveNodes: number;
  maxFileOps: number;
  /** 中国法定节假日（北京日期），全天按谷时计费；见 shared/officialRates.ts。 */
  holidays: string[];
};
/** 解析后的 fold 上限；由 {@link DEFAULT_BOUNDS} 推导，两者不会各自漂移。 */
type FoldBounds = typeof DEFAULT_BOUNDS;
/** 单个条目的原始配置：任意 fold 上限加任意展示偏好，全部可选，其余由 schema 补齐。
 * 消费方一律通过 {@link resolveBounds} 解析上限，绝不逐字段取。 */
export type Config = Partial<FoldBounds> & Partial<PluginSettings>;
/** 条目配置 schema：fold 上限加上易变的展示偏好。它同时是 plugins 页面表单的来源，
 * 在这里加一个字段就能编辑，无需额外接线。 */
export declare const Config: z$1<Schemastery.ObjectS<NoInfer<{
  maxRequestSteps: z$1<number, number, "defined">;
  maxKeptTurns: z$1<number, number, "defined">;
  maxEvents: z$1<number, number, "defined">;
  maxNodes: z$1<number, number, "defined">;
  maxArchiveNodes: z$1<number, number, "defined">;
  maxFileOps: z$1<number, number, "defined">;
  holidays: z$1<string[], string[], "defined">;
  defaultPlacement: z$1<"all" | "sidebar" | "tab", "all" | "sidebar" | "tab", "defined">;
  defaultGranularity: z$1<"step" | "turn", "step" | "turn", "defined">;
  defaultTrendMode: z$1<"delta" | "total", "delta" | "total", "defined">;
  defaultDeltaBase: z$1<"step" | "turn", "step" | "turn", "defined">;
  defaultToolSort: z$1<"count" | "name" | "size", "count" | "name" | "size", "defined">;
  defaultFileSort: z$1<"count" | "latest" | "path", "count" | "latest" | "path", "defined">;
  insightsEntry: z$1<"hide" | "show", "hide" | "show", "defined">;
  defaultDurationCurve: z$1<"hide" | "show", "hide" | "show", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
  maxRequestSteps: z$1<number, number, "defined">;
  maxKeptTurns: z$1<number, number, "defined">;
  maxEvents: z$1<number, number, "defined">;
  maxNodes: z$1<number, number, "defined">;
  maxArchiveNodes: z$1<number, number, "defined">;
  maxFileOps: z$1<number, number, "defined">;
  holidays: z$1<string[], string[], "defined">;
  defaultPlacement: z$1<"all" | "sidebar" | "tab", "all" | "sidebar" | "tab", "defined">;
  defaultGranularity: z$1<"step" | "turn", "step" | "turn", "defined">;
  defaultTrendMode: z$1<"delta" | "total", "delta" | "total", "defined">;
  defaultDeltaBase: z$1<"step" | "turn", "step" | "turn", "defined">;
  defaultToolSort: z$1<"count" | "name" | "size", "count" | "name" | "size", "defined">;
  defaultFileSort: z$1<"count" | "latest" | "path", "count" | "latest" | "path", "defined">;
  insightsEntry: z$1<"hide" | "show", "hide" | "show", "defined">;
  defaultDurationCurve: z$1<"hide" | "show", "hide" | "show", "defined">;
}>>, "plain">;
//#endregion
//#region src/host/index.d.ts
/** loader 行 id；Config 命名空间与设置表单的存储键都由它推导。 */
export declare const name = "dsh-cost-breakdown";
/** 硬依赖：注册表不存在时 Cordis 会让本插件保持 pending。 */
export declare const inject: string[];
/** 组装插件：先武装常驻路由，再注册闸门的回退单元或真实 fold 单元，
 * 最后装上 backfill watcher。 */
export declare function apply(ctx: Context, config: Config): void;
//#endregion
export type { ActivityDay, ActivityState, Category, ContextActivity, ContextEventRecord, ContextHeaders, ContextTimeline, ContextTimelineDetail, HeaderRecord, HeaderTool, HeadersState, PlatformBalance, PlatformBalanceEntry, RequestRecord, SkillInfo, Snapshot, SurfaceNode, TimelineCounts, TimelineLast, TimelineState };