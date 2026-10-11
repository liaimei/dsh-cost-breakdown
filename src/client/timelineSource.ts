/**
 * Context 标签页与 /context 模态框背后的 timeline 来源。它调和
 * `contextTimeline` 的两种 wire 世代，以 `detailRev` 为标记：
 *
 * - INLINE（较旧的 host、无通道的部署、闸门兜底）：集合
 *   随值就地携带。
 * - SPLIT（当前 host、detail 路由可用）：精简 head 小到足以放进每条
 *   session.list 行与推送帧，集合则从
 *   `/api/dsh-cost-breakdown/detail` 读取，并在推送的版本号超过
 *   已服务的 detail 后重新抓取。
 *
 * 每个 session 一个 store，重抓采用单飞，按世代与版本号保证竞态安全；
 * 读取失败保留上一份可用 detail 并退避。没有推送值的 session
 * 会自己打开通道（rev 0）。
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline, ContextTimelineDetail } from '../shared/types'
import type { SessionStandardProps } from './services'
import { asRecord, collectionsOf, projectionOf, timelineOf } from './services'

// host/detail.ts 的 detail 路由，在此重新声明：客户端 bundle 会内联
// 每个 import，而 host 模块绝不能进到这里。
const DETAIL_ROUTE = '/api/dsh-cost-breakdown/detail'

/** 收窄 detail 端点的载荷；版本号缺失或为 NaN 时整份载荷 reject，
 * 调用方因此展示可重试的提示，而不会拿到半合并的数据。 */
export function detailOf(value: unknown): ContextTimelineDetail | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.rev !== 'number' || !Number.isFinite(data.rev) || data.rev < 0) return null
  // 精简 head 随载荷一起下发，供 Agent 网络的冷节点环抓取；
  // 畸形的 head 只会被丢弃，而不会让整份载荷 reject。
  const head = timelineOf(data.head)
  return {
    rev: data.rev,
    ...(head !== null ? { head } : {}),
    ...collectionsOf(data),
  }
}

/** 插件自己的 `/api` 路由（host/detail.ts）上的 detail 读取器；失败与畸形载荷都会 reject。 */
export function makeDetailFetcher(
  sessionId: string,
): (() => Promise<ContextTimelineDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return async () => {
    const response = await fetch(DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!response.ok) throw new Error(`dsh-cost-breakdown: detail route HTTP ${response.status}`)
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true) throw new Error('dsh-cost-breakdown: detail read failed')
    if (r.value === null) return null
    const detail = detailOf(r.value)
    if (detail === null) throw new Error('dsh-cost-breakdown: detail read malformed')
    return detail
  }
}

/** store 的快照，每次状态转移都重建，并为 `useSyncExternalStore` 做引用闸门。 */
export interface DetailSnap {
  /** 最新被接受的 detail；重抓在途期间仍保留，卡片因此不会闪回加载态。 */
  detail: ContextTimelineDetail | null
  failed: boolean
  pending: boolean
}

const EMPTY_SNAP: DetailSnap = { detail: null, failed: false, pending: false }

const DETAIL_DEBOUNCE_MS = 300

/** 某个 session 的 detail 账本；导出供测试使用，应用则通过 `detailStoreOf` 取到它。 */
export class DetailStore {
  private detail: ContextTimelineDetail | null = null
  /** `detail` 的版本号（最新者胜的游标）；首次落地之前为 -1。 */
  private acceptedRev = -1
  private wantedRev = -1
  /** 在途（或已排期）读取所瞄准的 head 版本号——即重折异常得以接受的关键。 */
  private targetRev = -1
  /** 最近一次看到的 head 版本号；**变小**意味着 host 重折过、版本号已重新开始。 */
  private lastHeadRev = -1
  private generation = 0
  private failed = false
  private inFlight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  /** 没有任何视图持有该 store。它保留缓存的载荷，使重新打开时能立即
   * 渲染，但不发起读取：映射与页面同寿命，否则无视图的 store 会永远挂在一个已死的路由上。 */
  private parked = false
  private readonly listeners = new Set<() => void>()
  private snap: DetailSnap = EMPTY_SNAP

  constructor(
    private readonly fetcher: (() => Promise<ContextTimelineDetail | null>) | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
  ) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    if (this.parked) {
      this.parked = false
      // 在没有缓存的情况下恢复：清空账本与旧的退避状态，
      // 让这次挂载自己的请求重新读取，而不是卡在那个提示上。
      if (this.detail === null) {
        // 只在完全没有缓存时才这么做：仍持有载荷的 store 保留其
        // 退避状态，快速重挂载因此不会反复捶打一个正在失败的路由。
        this.resetLedger()
        this.failures = 0
      }
    }
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.park()
    }
  }

  readonly getSnapshot = (): DetailSnap => this.snap

  /** head 的版本号到达：当它超过已服务的 detail 时，安排一次
   * 尾沿读取。**变小**意味着 host 重折过，版本号重新开始，账本随之重置。 */
  request(rev: number): void {
    if (rev < this.lastHeadRev) this.resetLedger()
    this.lastHeadRev = rev
    if (rev <= this.acceptedRev || rev <= this.wantedRev) return
    this.wantedRev = rev
    this.schedule()
  }

  readonly retry = (): void => {
    this.failures = 0
    if (this.detail !== null) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.inFlight) void this.fire()
  }

  private resetLedger(): void {
    this.generation++
    this.acceptedRev = -1
    this.wantedRev = -1
    this.detail = null
    this.failed = false
    // 快照自身持有的载荷引用也要断开：它是被释放的 detail 仍可能可达的第二处。
    this.snap = EMPTY_SNAP
  }

  get active(): boolean {
    return this.listeners.size > 0
  }

  get hasPayload(): boolean {
    return this.detail !== null
  }

  /** 降级该 store：丢弃缓存的载荷与待办工作，在页面缓存超限后对空闲 store 调用。
   */
  release(): void {
    // 自行再清一次，降级的契约在这里同样成立。
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.resetLedger()
    this.failures = 0
  }

  private park(): void {
    this.parked = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emit()
  }

  private schedule(): void {
    // 没有人会读已停驻 store 的答案，因此绝不发起读取。
    if (this.parked || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, this.baseDelay * 2 ** Math.min(this.failures, 3))
    this.emit()
  }

  private async fire(): Promise<void> {
    // 尾沿定时器触发时，更早的那次读取仍在途中；若想要的版本号仍
    // 超过已服务的版本，该次读取落定后会重新武装。
    if (this.inFlight) return
    if (this.fetcher === undefined) {
      // 没有可读取的 session id：类型化的失败会武装卡片的提示。
      this.failed = true
      this.emit()
      return
    }
    this.inFlight = true
    this.targetRev = this.wantedRev
    const generation = this.generation
    this.emit()
    try {
      const d = await this.fetcher()
      // 读取在途中时发生了一次重置（重折、释放）：它的结果属于已被
      // 取代的世代，不得覆盖新的账本。
      if (generation !== this.generation) return
      if (d !== null) {
        // 最新者胜，外加一个例外：版本号**正是**本次读取所瞄准的那个 detail
        // 即使压不过 `acceptedRev` 也会被接受（即重折的情形：host 让
        // 版本号重新开始，此时目标版本号才是可信的键）。
        if (d.rev >= this.acceptedRev || d.rev === this.targetRev) {
          this.detail = d
          this.acceptedRev = d.rev
        }
        this.failures = 0
        this.failed = false
      } else {
        // 缺失（该 session 已离开活跃集合）：保留上一份 detail，在 head
        // 再次变动之前停掉尾沿读取，且只在无物可展示时才武装提示。
        this.wantedRev = this.acceptedRev
        this.failed = this.detail === null
        this.failures++
      }
    } catch {
      if (generation === this.generation) {
        this.failed = this.detail === null
        this.failures++
      }
    } finally {
      this.inFlight = false
      if (this.wantedRev > this.acceptedRev) this.schedule()
      this.emit()
    }
  }

  private emit(): void {
    const pending = this.timer !== null || this.inFlight
    const next: DetailSnap = { detail: this.detail, failed: this.failed, pending }
    if (next.detail === this.snap.detail && next.failed === this.snap.failed && next.pending === this.snap.pending) return
    this.snap = next
    for (const fn of this.listeners) fn()
  }
}

/** 允许多少个 session 保留其抓取到的 detail 载荷。一份大载荷实测约 194KB JSON
 * （约 300KB 活动堆），而这个映射与页面同寿命，因此较旧的空闲 store 会被降级，之后再重新读取。
 */
const DETAIL_STORES_MAX = 8

/** 与页面同寿命的按 session 存的 store（标签页与模态框共用一个）。 */
const stores = new Map<string, DetailStore>()

function payloadHolders(): number {
  let held = 0
  for (const store of stores.values()) if (store.hasPayload) held++
  return held
}

/** 与页面同寿命的按 session store 注册表。重新插入一个**已知** id 会把它
 *  移到映射的最新端，下面的淘汰过程因此总能命中最近最少打开的 session。
 *  任何曾被打开过的 id 都保留其 store 与缓存的载荷。 */
export function detailStoreOf(sessionId: string): DetailStore {
  const known = stores.get(sessionId)
  const store = known ?? new DetailStore(makeDetailFetcher(sessionId))
  // 重新插入会把条目移到映射的最新端，因此下面的降级
  // 总是命中最近最少打开的 session。
  if (known !== undefined) stores.delete(sessionId)
  stores.set(sessionId, store)
  // 没有载荷的 store 马上要去抓一份，因此按多一个计算；
  // 活跃 store 还在屏幕上，绝不降级。
  let excess = payloadHolders() - DETAIL_STORES_MAX + (store.hasPayload ? 0 : 1)
  for (const candidate of stores.values()) {
    if (excess <= 0) break
    if (candidate.active || !candidate.hasPayload) continue
    candidate.release()
    excess--
  }
  return store
}

/** 丢弃所有按 session 的 store；供测试以及「scope 变更后不得继续
 *  服务另一个账户缓存 detail」的场景使用。 */
export function resetTimelineDetailStores(): void {
  stores.clear()
}

/** 卡片的渲染状态：`legacy` 表示完全没有 detail 通道的内联值
 *  （无可重试），`failed` 表示读取已落定却没有可用值（可重试）。 */
export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'

/** 某个视图对 timeline 的读取：合并后的值，加上未就绪期间要展示的内容。
 *  构造上即保证 hook 顺序安全——每个 hook 都在塑造返回记录的分支
 *  之前运行（见 {@link useTimelineSource}）。 */
export interface TimelineSource {
  /** 卡片渲染的值：内联生成方式的值，或精简 head 与抓取到的 detail 集合合并后的结果。 */
  data: ContextTimeline | null
  detailState: DetailState
  retryDetail: () => void
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}

/** 视图对 timeline 的唯一读取。hook 顺序安全：每个 hook 都
 * 无条件执行，下面的分支只塑造返回的记录。 */
export function useTimelineSource(props: SessionStandardProps): TimelineSource {
  const head = projectionOf(props, 'contextTimeline', timelineOf)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  // 分离标记：精简 head 携带 detail 版本号；`headRev` 为 null
  // （内联值、闸门兜底、损坏的载荷）即没有通道。
  const headRev = head !== null && typeof head.detailRev === 'number' ? head.detailRev : null
  const slim = headRev !== null
  // 只要还没有推送值就发动冷启动：来源自己打开通道
  // （rev 0），而不是等一个可能永远不会来的推送。
  const cold = head === null
  const store = useMemo(
    () => (slim || cold ? detailStoreOf(sessionId) : null),
    [sessionId, slim, cold],
  )
  const snap = useSyncExternalStore(
    store !== null ? store.subscribe : noopSubscribe,
    store !== null ? store.getSnapshot : () => EMPTY_SNAP,
  )
  useEffect(() => {
    // 推送 head 的版本号驱动尾沿重抓；冷启动则请求 rev 0。
    if (store !== null) store.request(headRev ?? 0)
  }, [store, headRev])

  return useMemo<TimelineSource>(() => {
    const detail = snap.detail
    const retry = store !== null ? store.retry : noopRetry
    if (head !== null && !slim) return { data: head, detailState: 'legacy', retryDetail: noopRetry }
    // 用于渲染的 head：推送值，或 detail 读取自带的精简 head。
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      // 尚无内容可渲染——冷读取仍在途中，或已落定却没有可用值：
      // 这是可重试的失败，绝不呈现为转不动的加载动画。
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry }
    }
    if (detail === null) {
      // head 自带的计数在首次读取在途期间即可渲染，或在它无数据
      // 落定后渲染（失败提示就在旁边）。
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry }
    }
    const data: ContextTimeline = {
      ...base,
      requests: detail.requests,
      events: detail.events,
      nodes: detail.nodes,
      droppedNodes: detail.droppedNodes,
      archive: detail.archive,
      // 精简 head 不提供下限值；detail 的那一对会在这里整体落地。
      ...(detail.surfaceFloor !== undefined ? { surfaceFloor: detail.surfaceFloor } : {}),
      ...(detail.archiveFloor !== undefined ? { archiveFloor: detail.archiveFloor } : {}),
      ...(detail.fileOps !== undefined ? { fileOps: detail.fileOps } : {}),
      ...(detail.fileOpsFloor !== undefined ? { fileOpsFloor: detail.fileOpsFloor } : {}),
      ...(detail.spans !== undefined ? { spans: detail.spans } : {}),
    }
    return { data, detailState: 'ready', retryDetail: retry }
  }, [head, slim, store, snap])
}
