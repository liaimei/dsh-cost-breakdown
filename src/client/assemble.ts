/** 逐步上下文组装——Context 浏览器卡片背后的纯重建。请求记录由 Host 按派发时的
 * 原样快照：生效的 header 加上响应落地**之前**模型可见的 surface。
 * 覆盖范围如实反映：当可服务的窗口装不下完整答案时
 * （更旧的活跃节点被丢弃、删除动作超出归档保留范围），结果会带上 UI 转成提示的标记。 */

import type { ContextHeaders, ContextTimeline, HeaderRecord, SurfaceNode, SystemPromptNode } from '../shared/types'

/** 重建出的派发：`live` 标记当前步骤（不做切割），其余字段是该步骤
 *  自己的 header/system/nodes，外加两个被 UI 转成提示的如实标记。 */
export interface Assembled {
  live: boolean
  header: HeaderRecord | null
  /** 从 timeline 的活跃 `systems` 节点解析而来；在该字段出现之前折叠的行
   *  则用 header 世代自己的信封数字顶替。 */
  system: SystemPromptNode | null
  nodes: SurfaceNode[]
  missingLive: number
  approximate: boolean
}

/** `seq` **之前**最新的 header 世代（即派发时生效的 header）；`seq` 为 null
 *  表示当前步骤，取最新世代。切点之前没有世代时返回 null，
 *  早于首个 header 的请求读到的也是这个结果。 */
export function headerAt(headers: ContextHeaders | null, seq: number | null): HeaderRecord | null {
  if (headers === null || headers.headers.length === 0) return null
  if (seq === null) return headers.headers[headers.headers.length - 1]
  for (let i = headers.headers.length - 1; i >= 0; i--) {
    if (headers.headers[i].seq < seq) return headers.headers[i]
  }
  return null
}

/** `seq` 处或之前最后一个带 token 的活跃 system 节点——正是 host 折叠的
 * 「最后一个非空且仍存活的 system」规则，因此与折叠记录的每步 `system` 数字一致。
 * 在 `systems` 出现之前折叠的行回退到 header 世代的数字。 */
export function systemAt(
  data: ContextTimeline,
  header: HeaderRecord | null,
  seq: number | null,
): SystemPromptNode | null {
  const systems = data.systems
  if (systems !== undefined && systems.length > 0) {
    for (let i = systems.length - 1; i >= 0; i--) {
      const node = systems[i]
      if (node.tokens <= 0) continue
      if (seq === null || node.seq < seq) return node
    }
    return null
  }
  return header !== null && header.systemTokens !== undefined
    ? { seq: header.seq, time: header.time, tokens: header.systemTokens }
    : null
}

/** 按 host 快照时的样子重建某一步的上下文。`seq` 为 null 即**当前**步骤；
 *  否则切点是排他的（`seq < seq`），与请求记录自己的 seq 一致。 */
export function assemble(data: ContextTimeline, headers: ContextHeaders | null, seq: number | null): Assembled {
  const live = seq === null
  let nodes: SurfaceNode[]
  if (live) {
    nodes = data.nodes.slice()
  } else {
    const picked: SurfaceNode[] = []
    for (const n of data.nodes) {
      if (n.seq < seq) picked.push(n)
    }
    // 归档节点只有在切点处仍留在上下文中才算数：`gone` 是折叠驱逐它的
    // 那个 seq 之后的位置，因此在 `seq` **之前**已被移除的节点不得重新出现。
    for (const n of data.archive) {
      if (n.seq < seq && n.gone !== undefined && n.gone > seq) picked.push(n)
    }
    nodes = picked
  }
  nodes.sort((a, b) => a.seq - b.seq)

  let missingLive = 0
  if (data.droppedNodes > 0) {
    // 当前步骤：每个被丢弃的活跃节点都属于当前上下文。过去的步骤：被丢弃的区间位于
    // `surfaceFloor` 处或之下，因此只在它之后的步骤打标记（更旧步骤的子集不会被夸大）。
    if (live || (data.surfaceFloor !== undefined && seq > data.surfaceFloor)) {
      missingLive = data.droppedNodes
    }
  }
  const approximate = !live
    // 归档不保留 `archiveFloor` 之前的任何内容，因此在它之下切出的步骤无法
    // 忠实重建——UI 会标注「近似」，而不是假装精确。
    && data.archiveFloor !== undefined
    && seq < data.archiveFloor

  const header = headerAt(headers, seq)
  return { live, header, system: systemAt(data, header, seq), nodes, missingLive, approximate }
}
