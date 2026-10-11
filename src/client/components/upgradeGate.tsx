/** 基线闸门弹窗：宿主报告的 harness 低于支持基线时（推下来的 `contextTimeline` 上那条 `unsupported`
 * 记录），标签页继续渲染它那些全零的卡片，而这个对话框把检测到的版本与要求的最低版本并列出来。
 * 已关闭状态按会话记在模块级台账里，所以标签页重新挂载不会让它再弹，
 * 而重新启动应用则会。 */

import { useCallback, useState, type ReactElement } from 'react'
import type { ViewKit } from '../viewkit'
import { useEscapeClose } from './escapeClose'

/** 本次浏览器会话中用户已经关过闸门的那些会话。 */
const dismissed = new Set<string>()

/** 闸门的输入；两个版本号都由调用方复核过，
 *  所以这张卡片不必再去解释一个格式非法的版本串。 */
export interface UpgradeGateProps {
  sessionId?: string
  /** 检测到的 harness 版本，已复核。 */
  current: string
  /** 本插件支持的最低基线。 */
  minimum: string
}

/** 绑定 `kit`，返回基线闸门弹窗。关闭状态刻意放在两处：组件 state 清掉当前这次挂载，
 *  模块级台账清掉重新挂载与原地切换会话。
 *  于是这个对话框只会在应用全新启动后再出现。 */
export function makeUpgradeGate(kit: ViewKit): (props: UpgradeGateProps) => ReactElement | null {
  const { t } = kit
  return function UpgradeGate(props: UpgradeGateProps): ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    // `closedFor` 管一次挂载内的关闭；台账管重新挂载与原地切换会话。
    const [closedFor, setClosedFor] = useState<string | null>(null)
    const closed = closedFor === sessionId || dismissed.has(sessionId)
    const close = useCallback(() => {
      // `sessionId` 对没有 id 的会话可能是 ''：台账就以空串为键，
      // 这仍然能区分「已关闭」与「从未显示过」。
      dismissed.add(sessionId)
      setClosedFor(sessionId)
    }, [sessionId])

    // /context 弹窗那套浮层约定：捕获阶段监听 Escape，关闭后把焦点还给打开前的元素。
    useEscapeClose(!closed, close)

    if (closed) return null

    return (
      <div className="lc-modal-backdrop" onClick={close}>
        <div className="lc-modal-card lc-gate-card" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="lc-modal-head">
            <span className="lc-modal-title">{t('gate.title')}</span>
            <button className="lc-modal-close hover:text-(--dsw-alias-label-primary) hover:bg-(--dsw-alias-bg-layer-2)" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>
          <div className="lc-gate-body">{t('gate.body', { minimum: props.minimum })}</div>
          <div className="lc-gate-versions">
            <span className="lc-gate-version">
              <span className="lc-gate-version-label">{t('gate.current')}</span>
              <span className="lc-gate-version-value">v{props.current}</span>
            </span>
            <span className="lc-gate-version">
              <span className="lc-gate-version-label">{t('gate.minimum')}</span>
              <span className="lc-gate-version-value">
                v{props.minimum}
                <span className="lc-gate-or-newer">{t('gate.orNewer')}</span>
              </span>
            </span>
          </div>
          <div className="lc-gate-actions">
            <button type="button" className="lc-gate-ok hover:brightness-110" onClick={close}>{t('gate.ok')}</button>
          </div>
        </div>
      </div>
    )
  }
}
