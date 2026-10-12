/** dsh-cost-breakdown——客户端这一半 bundle 的入口。Context 视图读取 harness 的 session 投影
 * `contextTimeline`（分离生成方式的精简 head）；体量大的集合按需从 host 的
 * detail 端点取回，每个正在查看的客户端各读一次（timelineSource.ts）。 */

import { createElement as h } from 'react'
import { DICT_EN, DICT_ZH } from './i18n'
import { registerContextCommand } from './command'
import { makeContextModal } from './components/contextModal'
import { makeOverviewPanel } from './components/overviewPanel'
import { makePluginConfigCard } from './components/settingsCard'
import { watchInsightPage } from './insightPage'
import { modalStoreOf } from './modalStore'
import type { ClientCtx } from './services'
import { createContextSettings, type ConfigFormsFace, type SettingsField } from './settings'
import { makeContextView } from './components/contextView'
import { makeComposerDock } from './components/composerDock'
import { makeContextJumpButton } from './components/contextJump'
import { makeTurnSpend } from './components/turnSpend'
import { watchHistoryFaces } from './historyPage'
import { watchPlacement } from './placement'
import { watchSidebarContextTab } from './sidebar'
import { makeViewKit } from './viewkit'

// import 顺序**就是**同优先级规则之间的层叠顺序：Tailwind 工具类样式表排在最前，
// 然后是 base，最后是各组件自己的样式表，平级冲突时后者获胜。
import './styles/tailwind.css'
import './styles/base.css'
import './styles/stats.css'
import './styles/statsCost.css'
import './styles/jump.css'
import './styles/settings.css'
import './styles/stackedBar.css'
import './styles/trendChart.css'
import './styles/requestDetail.css'
import './styles/events.css'
import './styles/fileCard.css'
import './styles/modal.css'
import './styles/browser.css'
import './styles/detailSections.css'
import './styles/attachments.css'
import './styles/agentGraph.css'
import './styles/overview.css'
import './styles/dateRange.css'
import './styles/composerDock.css'

const NS = 'dsh-cost-breakdown'

/** bundle 的唯一入口，每个客户端 fiber 执行一次。**硬性** inject 只有 `slots` 与
 *  `locale`；其他服务一律延迟（`ctx.inject`）或在调用点校验，因此被裁剪过的
 *  部署也能完成组装，不会留下悬而未决的 fiber。 */
function apply(ctx: ClientCtx): void {
  // 先注册字典：后续每个注册都可能传 `locale: NS`，并指望
  // 该命名空间在渲染之前就已解析。
  ctx.effect(() => {
    return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
  }, 'dsh-cost-breakdown: dictionaries')
  // 整个插件共用的绑定版翻译函数（kit 以及下面每个 `t()` 标签都用它）；
  // 只绑定一次，各调用点就不必再带命名空间。
  const t = ctx.locale.bind(NS)

  const kit = makeViewKit(t)
  // 历史面孔通过**声明式** inject 解析：对被追踪 remote 代理做未声明读取
  // 会抛错 "cannot get property … without inject" 并拖垮视图（见 historyPage.ts）。
  watchHistoryFaces(ctx)
  const settings = createContextSettings()
  // 两种放置方式共用一个视图组件：注册到哪里由 `watchPlacement` 决定。
  const ContextView = makeContextView(ctx, kit, settings)

  ctx.effect(() => watchPlacement(settings, {
    tab: () => ctx.slots.inject('conversation.view', () => {
      return ctx.slots.register(
        // order 20 会渲染在 Chat（0）与 Trajectory（10）的右侧。
        { name: 'conversation.view', id: 'context', order: 20, locale: NS, label: () => t('tab') },
        props => h(ContextView, props),
      )
    }),
    sidebar: () => watchSidebarContextTab(ctx, ContextView, t, NS),
  }), 'dsh-cost-breakdown: placement')

  // Chat → Context 跳转：能定位到回复所在 turn 时，打开右侧 Sidebar 中钉住该 turn 的标签页，
  // 否则打开对话标签页（contextJump.tsx；中转与激活在 viewFocus.ts）。
  const ContextJump = makeContextJumpButton(ctx, kit)
  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    return ctx.slots.register(
      // 排在随附的 feedback 条目（10）之后，仍在图标行内。
      { name: 'conversation.chat.assistant-actions', id: 'context-jump', order: 20, locale: NS },
      props => h(ContextJump, props),
    )
  })

  // composer 下方常驻的花费读数。它只需要 `slots`，因此独立于右侧
  // Sidebar 贡献：没有那一列的 harness 也能显示它。
  const ComposerDock = makeComposerDock(ctx, kit)
  ctx.slots.inject('conversation.composer.dock', () => {
    return ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'context-cost', order: 10, locale: NS },
      props => h(ComposerDock, props),
    )
  })

  // 每轮回复后面的消费读数：与官方的「用量 N tok」胶囊同一行（该槽位由 harness 的
  // turn-tail 渲染成图标行，官方胶囊在行尾的 endInfo 里）。它按每轮账本动态决定
  // 显示金额（区分峰谷）还是积分——见 components/turnSpend.tsx。
  const TurnSpend = makeTurnSpend(kit, () => (
    typeof ctx.locale.getLocale === 'function' && ctx.locale.getLocale().active === 'zh' ? 'cny' : 'usd'
  ))
  ctx.slots.inject('conversation.chat.assistant-actions', () => {
    return ctx.slots.register(
      // 排在随附的 feedback（10）与上面的 context-jump（20）之后，仍是图标行内的一员。
      { name: 'conversation.chat.assistant-actions', id: 'turn-spend', order: 30, locale: NS },
      props => h(TurnSpend, props as unknown as Parameters<typeof TurnSpend>[0]),
    )
  })

  registerContextCommand(ctx, kit)
  const ContextModal = makeContextModal(ctx, kit, settings)
  ctx.slots.inject('conversation.input.overlay', () => {
    return ctx.slots.register(
      { name: 'conversation.input.overlay',
        id: 'context-modal',
        order: 10,
        locale: NS,
        inject: (sessionId = '') => ({ hooks: { contextModal: modalStoreOf(sessionId) } }) },
      props => h(ContextModal, props),
    )
  })

  // Context Insights 页：面板挂在带键的 `main` slot 上，其侧栏条目挂在
  // `sidebar.panellist` 上，二者都由 `insightsEntry` 偏好项决定挂载或卸载（insightPage.ts）。
  const OverviewPanel = makeOverviewPanel(ctx, kit)
  ctx.effect(() => watchInsightPage(
    ctx,
    settings,
    // 根作用域座位：宿主 props（标准 kit）传入时没有类型。
    props => h(OverviewPanel, props as unknown as Parameters<typeof OverviewPanel>[0]),
    t,
    NS,
  ), 'dsh-cost-breakdown: insight page')

  const cardFace = (): {
    hooks: { contextSettings: typeof settings.store }
    set: (field: SettingsField, value: string) => void
  } => ({
    // 卡片通过这个注入的 store 读设置（变更时因此会重渲染），
    // 并经由 `set` 写入；面孔声明在注册处，而不是模块级。
    hooks: { contextSettings: settings.store },
    set: (field, value) => { settings.set(field, value) },
  })

  // 偏好项搭 configForms 服务与 Plugins 页带键的 `plugins.bundle.config` slot。
  // 延迟 inject 只在服务存在处触发，没有该服务的 host 因此保持 schema 默认值。
  ctx.inject(['configForms'], (raw) => {
    const c = raw as ClientCtx & { configForms?: ConfigFormsFace }
    const forms = c.configForms
    // inject 之后再校验一次：服务可能存在但已被裁剪。
    if (forms === undefined || typeof forms.get !== 'function' || typeof forms.whileServed !== 'function') return
    c.effect(() => settings.attach(forms.get(NS)), 'dsh-cost-breakdown: config forms')
    const PluginConfigCard = makePluginConfigCard(kit)
    c.effect(() => forms.whileServed([NS], () => {
      // slots.inject 的清理函数就是该注册的清理函数。
      return c.slots.inject('plugins.bundle.config', () => {
        return c.slots.register(
          { name: 'plugins.bundle.config', key: NS, locale: NS, inject: cardFace },
          props => h(PluginConfigCard, props as unknown as Parameters<typeof PluginConfigCard>[0]),
        )
      }) as () => void
    }), 'dsh-cost-breakdown: plugins-page card')
  })
}

// 插件这半的导出面：`inject` 是**硬性**需求清单，因此 fiber
// 只在两个服务都存在处挂载。客户端需要的其他一切均为延迟。
module.exports = {
  name: 'dsh-cost-breakdown',
  inject: ['slots', 'locale'],
  apply,
}
