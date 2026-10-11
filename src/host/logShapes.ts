/**
 * 按形状驱动的读取器，覆盖持久 session 事件词表——这是插件的日志写法唯一交汇处。
 * 受支持范围（dsh 0.1.7-rc.2+，session 格式 V4）
 * 只说一种方言：`system/message` surface 节点、
 * 打包的 assistant 流记录、`SurfaceOp { startSeq, endSeq }`。
 *
 * 读取器对不可信输入保持全函数：projection 注册表驱动 fold 时没有错误边界，
 * 一次抛错就会卡住该单元的推送流，
 * 浏览器会永远停在「加载中」。fold 读的是「形状」，
 * 从不读探测出来的 harness 版本；harness 无法迁移到 V4 的旧日志一律拒绝，绝不原样提供。
 *
 * @module dsh-cost-breakdown/host/log-shapes
 */

/** 原始流 chunk 是否携带 token 增量；对齐 dsh-llm 的 `isTokenDelta`。 */
export function isTokenChunk(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  const c = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown }
  switch (c.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof c.text === 'string' && c.text !== ''
    case 'tool-call-delta':
      return (typeof c.argumentsDelta === 'string' && c.argumentsDelta !== '') || c.name !== undefined
    default:
      return false
  }
}

/** 流的 `block-start.blockType` 所指的解码分桶；标记未知时返回 undefined。 */
export type DecodeKind = 'reasoning' | 'text' | 'toolarg'

/** 把 wire 上的 `block-start` 写法映射到 {@link DecodeKind}；`tool-call` 这种写法
 * 映射到更短的分桶名 `toolarg`。 */
export function decodeKindOfBlock(blockType: unknown): DecodeKind | undefined {
  if (blockType === 'reasoning') return 'reasoning'
  if (blockType === 'text') return 'text'
  if (blockType === 'tool-call') return 'toolarg'
  return undefined
}

/** 单条流里各类型的解码耗时与块数；计时汇总携带的就是这些和。 */
export interface DecodeTally {
  spans: Record<DecodeKind, number>
  blocks: Record<DecodeKind, number>
}

/** 内嵌 assistant 流里的解码区间与 `block-start` 计数，
 * 铺满 [首个 block-start, endTime]：每个标记占据到下一个标记之前的区间，
 * 最后一个到 `endTime`；对不可信输入保持全函数。 */
export function decodeTallyOfStream(stream: unknown, endTime: number): DecodeTally {
  const tally: DecodeTally = { spans: { reasoning: 0, text: 0, toolarg: 0 }, blocks: { reasoning: 0, text: 0, toolarg: 0 } }
  if (!Array.isArray(stream) || !Number.isFinite(endTime)) return tally
  let kind: DecodeKind | undefined
  let since = 0
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type !== 'chunk' || r.chunk === null || typeof r.chunk !== 'object') continue
    const chunk = r.chunk as { type?: unknown; blockType?: unknown }
    if (chunk.type !== 'block-start') continue
    const time = r.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (kind !== undefined) tally.spans[kind] += Math.max(0, time - since)
    kind = decodeKindOfBlock(chunk.blockType)
    if (kind !== undefined) tally.blocks[kind] += 1
    since = time
  }
  if (kind !== undefined) tally.spans[kind] += Math.max(0, endTime - since)
  return tally
}

/** 流中一段有序的解码区间，由时间条按流顺序绘制。 */
export interface DecodeSpan {
  kind: DecodeKind
  start: number
  end: number
}

/** 内嵌 assistant 流里「有序」的解码区间——归属规则与 {@link decodeTallyOfStream} 相同，
 * 保留顺序是因为时间条按流顺序绘制；`blockType` 未知时不生成区间，
 * 留给调用方做残余填充。 */
export function decodeSpansOfStream(stream: unknown, endTime: number): DecodeSpan[] {
  const spans: DecodeSpan[] = []
  if (!Array.isArray(stream) || !Number.isFinite(endTime)) return spans
  let kind: DecodeKind | undefined
  let since = 0
  const close = (to: number): void => {
    if (kind !== undefined && to > since) spans.push({ kind, start: since, end: to })
  }
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type !== 'chunk' || r.chunk === null || typeof r.chunk !== 'object') continue
    const chunk = r.chunk as { type?: unknown; blockType?: unknown }
    if (chunk.type !== 'block-start') continue
    const time = r.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    close(time)
    kind = decodeKindOfBlock(chunk.blockType)
    since = time
  }
  close(endTime)
  return spans
}

/** 一段「打包」增量（`text-chunks` / `reasoning-chunks` /
 * `tool-call-chunks`）里首个 token 的时刻：该段的基准时间加上累计到首个合格成员为止的成员间增量。
 * 对齐 dsh-llm 的 `runFirstTokenTime`；增量非有限时返回 undefined。 */
function runFirstTokenTime(record: Record<string, unknown>): number | undefined {
  const time0 = record.time0
  if (typeof time0 !== 'number' || !Number.isFinite(time0)) return undefined
  if (record.type === 'tool-call-chunks' && record.name !== undefined) return time0
  const fragments = record.type === 'tool-call-chunks' ? record.args : record.texts
  if (!Array.isArray(fragments)) return undefined
  const dt: readonly unknown[] = Array.isArray(record.dt) ? record.dt as unknown[] : []
  let time = time0
  for (const [index, fragment] of fragments.entries()) {
    if (index > 0) {
      const step = dt[index - 1]
      if (typeof step !== 'number' || !Number.isFinite(step)) return undefined
      time += step
    }
    if (typeof fragment === 'string' && fragment !== '') return time
  }
  return undefined
}

/** 内嵌 assistant 流（`assistant/message.data.stream`、
 * `assistant/attempt.data.stream`）里首个 token 的时刻；不含 token 时返回 undefined；
 * 对齐 dsh-llm 的 `assistantStreamFirstTokenTime`。 */
export function firstTokenTimeOfStream(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const r = record as Record<string, unknown>
    if (r.type === 'chunk') {
      const time = r.time
      if (typeof time === 'number' && Number.isFinite(time) && isTokenChunk(r.chunk)) return time
      continue
    }
    const time = runFirstTokenTime(r)
    if (time !== undefined) return time
  }
  return undefined
}

/** 替换操作覆盖的 surface 闭区间；`append` 以及任何无法识别或敌意的操作返回 null
 * （fold 把它们当作 append 处理）。 */
export function replaceRangeOf(surfaceOp: unknown): { start: number; end: number } | null {
  if (surfaceOp === null || typeof surfaceOp !== 'object') return null
  const op = surfaceOp as { op?: unknown; startSeq?: unknown; endSeq?: unknown }
  if (op.op !== 'replace') return null
  const { startSeq: start, endSeq: end } = op
  if (typeof start !== 'number' || !Number.isFinite(start)) return null
  if (typeof end !== 'number' || !Number.isFinite(end)) return null
  return { start, end }
}
