/** 插件的用户设置绑定（浏览器这一半）：Host 提供的 `dsh-cost-breakdown` 命名空间
 * 承载按用户的展示偏好；该界面缺失或只读时，一律退化为 schema 默认值。 */

import type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultToolSort, DefaultTrendMode, InsightsEntry, SettingsField } from '../shared/types'

/** 展示相关的词汇表声明在 shared/types.ts，因为 host 那半写的是同一份
 *  schema；这里重新导出，使每个客户端模块都从同一处 import
 *  它的偏好类型。 */
export type { DefaultDeltaBase, DefaultFileSort, DefaultGranularity, DefaultDurationCurve, DefaultPlacement, DefaultToolSort, DefaultTrendMode, InsightsEntry, SettingsField } from '../shared/types'

/** 绑定后的设置表单（`ctx.configForms.get`），即本模块消费的形态。 */
export interface SettingsScopeLike {
  getSnapshot(): { status: string; value: unknown; writable: boolean }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** `ctx.configForms` 服务面孔，即本模块消费的形态；绑定后的表单满足
 *  {@link SettingsScopeLike}（snapshot/subscribe/set 三者形状相同）。 */
export interface ConfigFormsFace {
  get(namespace: string): SettingsScopeLike
  whileServed(namespaces: readonly string[], register: () => () => void): () => void
}

/** 设置快照：一份不可变记录，变更时整体替换，React 消费方因此可以按引用
 *  比较。每个字段都携带**可直接使用**、已填默认的值——组件绝不需要
 *  再从原始 scope 推导兜底值。 */
export interface SettingsState {
  /** scope 同步状态：首个 Host 分区到达之前为 loading，未提供服务时为 unavailable。 */
  status: 'loading' | 'ready' | 'unavailable'
  placement: DefaultPlacement
  granularity: DefaultGranularity
  mode: DefaultTrendMode
  deltaBase: DefaultDeltaBase
  toolSort: DefaultToolSort
  fileSort: DefaultFileSort
  insightsEntry: InsightsEntry
  durationCurve: DefaultDurationCurve
  writable: boolean
}

/** 插件在各处传递的设置句柄：直通 getter、供 React 座位用的可观察 store，
 *  以及 Host scope 绑定。每个 getter 都只是对**当前**状态的普通读取，
 *  组件因此可以在渲染期间调用。 */
export interface ContextSettings {
  /** 可观察的快照 store，以 `useContextSettings` 之名绑定到卡片 props 上。 */
  store: { subscribe(listener: () => void): () => void; getSnapshot(): SettingsState }
  defaultPlacement(): DefaultPlacement
  defaultGranularity(): DefaultGranularity
  defaultTrendMode(): DefaultTrendMode
  defaultDeltaBase(): DefaultDeltaBase
  defaultToolSort(): DefaultToolSort
  defaultFileSort(): DefaultFileSort
  insightsEntry(): InsightsEntry
  defaultDurationCurve(): DefaultDurationCurve
  attach(scope: SettingsScopeLike): () => void
  /** 持久化一项偏好选择（先本地回显，再走受栅栏保护的 scope 写入）。 */
  set(field: SettingsField, value: string): void
}

// 每个字段都是可选的，且只有通过各自枚举检查才会被填充，
// 因此插件看不懂的值与 Host 从未下发的值无法区分。
type Prefs = {
  placement?: DefaultPlacement
  granularity?: DefaultGranularity
  mode?: DefaultTrendMode
  deltaBase?: DefaultDeltaBase
  toolSort?: DefaultToolSort
  fileSort?: DefaultFileSort
  insightsEntry?: InsightsEntry
  durationCurve?: DefaultDurationCurve
}

/** 把一份原始 scope 值清洗成 {@link Prefs}：每个字段都按各自的封闭
 *  词汇表校验，未知取值在这里就被剔除，而不会流到组件里。 */
function prefsOf(value: unknown): Prefs {
  if (value === null || typeof value !== 'object') return {}
  const v = value as Record<string, unknown>
  return {
    ...(v.defaultPlacement === 'all' || v.defaultPlacement === 'tab' || v.defaultPlacement === 'sidebar' ? { placement: v.defaultPlacement } : {}),
    ...(v.defaultGranularity === 'step' || v.defaultGranularity === 'turn' ? { granularity: v.defaultGranularity } : {}),
    ...(v.defaultTrendMode === 'total' || v.defaultTrendMode === 'delta' ? { mode: v.defaultTrendMode } : {}),
    ...(v.defaultDeltaBase === 'step' || v.defaultDeltaBase === 'turn' ? { deltaBase: v.defaultDeltaBase } : {}),
    ...(v.defaultToolSort === 'size' || v.defaultToolSort === 'count' || v.defaultToolSort === 'name' ? { toolSort: v.defaultToolSort } : {}),
    ...(v.defaultFileSort === 'count' || v.defaultFileSort === 'latest' || v.defaultFileSort === 'path' ? { fileSort: v.defaultFileSort } : {}),
    ...(v.insightsEntry === 'show' || v.insightsEntry === 'hide' ? { insightsEntry: v.insightsEntry } : {}),
    ...(v.defaultDurationCurve === 'show' || v.defaultDurationCurve === 'hide' ? { durationCurve: v.defaultDurationCurve } : {}),
  }
}

/** 用 schema 默认值构建句柄，此时还没有 Host scope：`configForms`
 *  始终未到达的部署会一直沿用它们，这也是每个默认值都取宽松档的原因
 *  （placement 为 `all`、两个条目都显示、写入被拒）。 */
export function createContextSettings(): ContextSettings {
  let state: SettingsState = { status: 'loading', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', durationCurve: 'show', writable: false }
  let scope: SettingsScopeLike | undefined
  const listeners = new Set<() => void>()
  /** 逐字段的引用闸门：`useSyncExternalStore` 按引用比较快照，
   *  因此发布一个值相等但新建的对象会让每个设置消费方在 Host 每次
   *  跳动时都重渲染。 */
  const publish = (next: SettingsState): void => {
    if (next.status === state.status && next.placement === state.placement && next.granularity === state.granularity
      && next.mode === state.mode && next.deltaBase === state.deltaBase && next.toolSort === state.toolSort
      && next.fileSort === state.fileSort && next.insightsEntry === state.insightsEntry && next.durationCurve === state.durationCurve
      && next.writable === state.writable) return
    state = next
    for (const listener of listeners) listener()
  }
  /** 把绑定 scope 的快照折叠进状态，并返回两个其**缺失**对调用方有意义的
   *  偏好项：那里的 undefined 意味着 Host 拒绝或从未携带该字段，
   *  写入回滚路径正是以此为依据。 */
  const sync = (bound: SettingsScopeLike): { placement?: DefaultPlacement; insightsEntry?: InsightsEntry } => {
    const snap = bound.getSnapshot()
    const prefs = prefsOf(snap.value)
    // 失败即放行：配置问题绝不能把某个条目藏住。插件看不懂的值
    // 退化为该字段的默认值；分区里没有该字段（较旧的 Host 那半）则保持当前状态。
    const raw = snap.value !== null && typeof snap.value === 'object'
      ? snap.value as Record<string, unknown>
      : undefined
    publish({
      status: snap.status === 'ready' || snap.status === 'unavailable' ? snap.status : 'loading',
      placement: prefs.placement ?? (raw?.defaultPlacement === undefined ? state.placement : 'all'),
      granularity: prefs.granularity ?? state.granularity,
      mode: prefs.mode ?? state.mode,
      deltaBase: prefs.deltaBase ?? state.deltaBase,
      toolSort: prefs.toolSort ?? state.toolSort,
      fileSort: prefs.fileSort ?? state.fileSort,
      insightsEntry: prefs.insightsEntry ?? (raw?.insightsEntry === undefined ? state.insightsEntry : 'show'),
      durationCurve: prefs.durationCurve ?? (raw?.defaultDurationCurve === undefined ? state.durationCurve : 'show'),
      writable: snap.writable,
    })
    return { placement: prefs.placement, insightsEntry: prefs.insightsEntry }
  }
  return {
    store: {
      subscribe(listener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => state,
    },
    defaultPlacement: () => state.placement,
    defaultGranularity: () => state.granularity,
    defaultTrendMode: () => state.mode,
    defaultDeltaBase: () => state.deltaBase,
    defaultToolSort: () => state.toolSort,
    defaultFileSort: () => state.fileSort,
    insightsEntry: () => state.insightsEntry,
    defaultDurationCurve: () => state.durationCurve,
    attach(bound) {
      scope = bound
      // 先同步再订阅：scope 的首个快照才是权威值，
      // 若先订阅，可能让部分状态与初次读取交错。
      sync(bound)
      return bound.subscribe(() => { sync(bound) })
    },
    set(field, value) {
      // 先本地回显：卡片必须立刻响应，而不是等 scope 往返；
      // 而 `publish` 的引用闸门会让未变的值不触发重渲染。
      publish({ ...state, ...prefsOf({ [field]: value }) })
      // scope 写入的 promise 在传输失败时会 **reject**（dsh 只让队列尾部保持 fulfilled），
      // 因此绝不能让悬空：把乐观回显回滚到 scope 的真值；被拒的写入会通过订阅恢复。
      const bound = scope
      if (bound === undefined) return
      void bound.set(field, value).catch(() => {
        const truth = sync(bound)
        // 持久化失败的闸门状态不得靠一次未落地的回显把某个条目藏住。
        if (field === 'defaultPlacement' && truth.placement === undefined) {
          publish({ ...state, placement: 'all' })
        }
        if (field === 'insightsEntry' && truth.insightsEntry === undefined) {
          publish({ ...state, insightsEntry: 'show' })
        }
      })
    },
  }
}
