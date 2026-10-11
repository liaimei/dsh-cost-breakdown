/** 步骤摘要——一条历史条的身份，由 timeline 的
 * 已服务节点推导而来。请求记录的 seq 就是其响应的 surface seq（折叠时二者记录在同一个 assistant/message 事件上）。
 */

import type { ContextTimeline, RequestRecord, SurfaceNode } from '../shared/types'

/** 一条历史条解释的三个 surface：开启该 turn 的 user 消息、
 *  上一条历史条与这一条之间落下的内容，以及这一条自己的响应。 */
export interface StepBrief {
  opener?: SurfaceNode
  inputs: SurfaceNode[]
  response?: SurfaceNode
}

/** 活跃节点与归档节点合成一个按 seq 有序的列表；摘要有界搜索需要
 *  单一单调序列，而归档条目保留其原始 seq。 */
export function briefNodes(data: ContextTimeline): SurfaceNode[] {
  return [...data.nodes, ...data.archive].sort((a, b) => a.seq - b.seq)
}

/** 第一个 seq >= `seq` 的下标（都不满足时为 `nodes.length`）：响应查找与
 *  inputs 区间共同的起点。用二分查找，是因为摘要要对每个悬停的历史条
 *  在整个节点列表上各推导一次。 */
function lowerBound(nodes: SurfaceNode[], seq: number): number {
  let lo = 0
  let hi = nodes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (nodes[mid].seq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** 为 `requests[idx]` 推导摘要（该展示列表由步骤记录或 turn 聚合项构成）。 */
export function briefOf(nodes: SurfaceNode[], requests: RequestRecord[], idx: number): StepBrief | null {
  if (idx < 0 || idx >= requests.length) return null
  const req = requests[idx]
  const ri = lowerBound(nodes, req.seq)
  const hit = ri < nodes.length && nodes[ri].seq === req.seq ? nodes[ri] : undefined
  const response = hit !== undefined && hit.cat === 'assistant' ? hit : undefined

  const turnStart = idx === 0 || (requests[idx - 1].turn ?? 0) !== (req.turn ?? 0)

  // opener：本 turn 第一条历史条之前最新的 user 消息（user 消息只会落在 turn 起点）。
  // 通过在同 turn 的兄弟条中向前回走来定位本 turn 的第一条，因此 turn 中段的
  // 历史条仍然归因于该 turn 的开场 user 消息，而不是它前面那条请求。
  let firstIdx = idx
  while (firstIdx > 0 && (requests[firstIdx - 1].turn ?? 0) === (req.turn ?? 0)) firstIdx--
  const upper = requests[firstIdx].seq
  const lower = firstIdx > 0 ? requests[firstIdx - 1].seq : -1
  let opener: SurfaceNode | undefined
  for (let i = lowerBound(nodes, upper) - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.seq <= lower) break
    if (n.cat === 'user') { opener = n; break }
  }

  const inputs: SurfaceNode[] = []
  if (!turnStart) {
    // 第一条历史条必然是 turn 起点，所以这里 idx > 0。
    const prevSeq = requests[idx - 1].seq
    for (let i = lowerBound(nodes, prevSeq + 1); i < nodes.length && nodes[i].seq < req.seq; i++) {
      inputs.push(nodes[i])
    }
  }
  return { opener, inputs, response }
}
