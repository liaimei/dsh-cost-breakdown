/** /context 命令的居中对话框：数据与 Context 标签页是同一份推下来的 `contextTimeline`，
 * 只是精简为当前组成与共享的浏览器。 */

import { createElement as h, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { measureDock } from '../dockMeasure'
import { headlineOf } from '../headline'
import { modalStoreOf, takePendingConsume } from '../modalStore'
import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
import type { ContextSettings } from '../settings'
import { contextBreakdownOf, contextPressureOf, conversationNodesOf, headersOf, imageLoaderOf, projectionOf } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useTimelineSource } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeDetailNote } from './detailNote'
import { makeErrorBoundary } from './errorBoundary'
import { useEscapeClose } from './escapeClose'
import { makeLegend, makeStackedBar } from './stackedBar'

/** 该弹窗的输入；绑定的选择器 hook 是可选的，因为即使宿主没有 hooks
 *  分区，浮层仍然会渲染（没有那个标志时它保持关闭）。 */
export interface ContextModalProps extends SessionStandardProps {
  /** 绑定在每会话「打开」标志上的选择器 hook（hooks 分区）。 */
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
}

/**
 * 一次性绑定 `ctx`、`kit` 与已解析的 `settings`，并构建共享的子渲染器
 * （堆叠条、图例、组成、浏览器、明细提示），使它们全部在多次打开之间保持稳定。
 * `ErrorBoundary` 在下方 return 处包住正文，
 * 免得一个抛异常的投影把周围的会话视图也拖垮。
 */
export function makeContextModal(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
): (props: ContextModalProps) => ReactElement | null {
  const { t } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const ContextBrowser = makeContextBrowser(kit, StackedBar, settings)
  const DetailNote = makeDetailNote(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  function ContextModalBody(props: ContextModalProps): ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const open = typeof props.useContextModal === 'function' ? props.useContextModal(s => s) : false
    // 共享标签页那份逐会话明细存储，所以已打开的标签页能直接服务该弹窗，无需重复取数。
    const source = useTimelineSource(props)
    const data = source.data
    const pressure = projectionOf(props, 'contextPressure', contextPressureOf)
    const breakdown = projectionOf(props, 'contextBreakdown', contextBreakdownOf)
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    // 在「关闭」提前 return 之前无条件读取，好让 hook 顺序在开/关之间保持稳定。
    const convNodes = conversationNodesOf(props)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    const [dock, setDock] = useState({ left: 0, right: 0 })
    const backdropRef = useRef<HTMLDivElement | null>(null)
    // 以 `sessionId` 为 key：为上一个会话捕获的 loader 在弹窗跨会话复用后
    // 会取到错误的附件 id。
    const loadImage = useMemo(
      () => imageLoaderOf(ctx, sessionId !== '' ? sessionId : undefined),
      [ctx, sessionId],
    )

    // 首次渲染可能抢在声明的 inject 之前（watch 重建会在 fiber 重新触发之前重新挂载这个浮层），
    // 所以下面两个取数器必须在 face 落地或被撤销时重建。
    const historyFace = useHistoryFace()

    const fetchContent = useMemo(
      () => (sessionId !== '' && historyFace !== undefined ? makeContentFetcher(sessionId) : undefined),
      [sessionId, historyFace],
    )
    // 与 `fetchContent` 同样的重建规则：两个取数器都持有自己出生时的那个 face。
    const fetchHeader = useMemo(
      () => (sessionId !== '' && historyFace !== undefined ? makeHeaderFetcher(sessionId) : undefined),
      [sessionId, historyFace],
    )

    // 没有 id 的会话无法寻址弹窗 store，所以关闭是一个空操作，而不是
    // 对空 key 做一次写入。待消费守卫只在 store 写入之后才排空，
    // 所以 slash 命令的令牌不会被一次失败的关闭消耗掉。
    const close = useCallback(() => {
      if (sessionId === '') return
      modalStoreOf(sessionId).set(false)
      // sessions 服务在「关闭」时才读，因为在 apply 时捕获它会与更细粒度的模块组装撞车。
      const guard = takePendingConsume(sessionId)
      const sessions = ctx.get('sessions') as SessionsFace | undefined
      if (guard === undefined || sessions === undefined) return
      const scope = sessions.scope(sessionId)
      if (scope !== undefined) scope.bail(scope, 'slash/input-consume-token', { guard })
    }, [ctx, sessionId])

    // 捕获阶段的 Escape 关闭 + 焦点恢复（共用的浮层约定）。
    useEscapeClose(open, close)

    // 侧边栏各轨道在首帧之前测量一次，打开期间持续跟随：拖拽、折叠开关，
    // 以及窄视口下的重新求解都会重写框架的内联模板。
    useLayoutEffect(() => {
      if (!open) return undefined
      const dock = measureDock(backdropRef.current)
      setDock({ left: dock.left, right: dock.right })
      if (dock.frame === null) return undefined
      const observer = new MutationObserver(() => {
        const next = measureDock(backdropRef.current)
        setDock({ left: next.left, right: next.right })
      })
      observer.observe(dock.frame, { attributes: true, attributeFilter: ['style'] })
      return () => { observer.disconnect() }
    }, [open])

    if (!open) return null

    const head = data !== null ? headlineOf(data, pressure, breakdown) : null
    const subtitle = data !== null ? (data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '') : ''

    return (
      <div ref={backdropRef} className="lc-modal-backdrop" style={{ left: dock.left, right: dock.right }} onClick={close}>
        <div className="lc-modal-card" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="lc-modal-head">
            <span className="lc-modal-title">{t('tab')}</span>
            <button className="lc-modal-close hover:text-(--dsw-alias-label-primary) hover:bg-(--dsw-alias-bg-layer-2)" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>

          {data === null || head === null ? (
            source.detailState === 'failed' ? (
              <DetailNote state="failed" onRetry={source.retryDetail} />
            ) : (
              <div className="lc-empty">{t('loading')}</div>
            )
          ) : (
            <div>
              <CurrentComposition
                head={head}
                subtitle={subtitle}
                hoverKey={hoverCat}
                onHoverKey={setHoverCat}
              />
              <ContextBrowser
                data={data}
                headers={headers}
                convNodes={convNodes}
                fetchContent={fetchContent}
                fetchHeader={fetchHeader}
                loadImage={loadImage}
                hoverKey={hoverCat}
                onHoverKey={setHoverCat}
                detailState={source.detailState}
                onDetailRetry={source.retryDetail}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  return function ContextModal(props: ContextModalProps): ReactElement | null {
    return h(ErrorBoundary, null, h(ContextModalBody, props))
  }
}
