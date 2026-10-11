/** 子树渲染出错时降级成这张带可用「重试」的样式化卡片；harness 自带的 slot 边界
 * 只会留下一块空的错误占位。 */

import { Component, type ComponentType, type ReactNode } from 'react'
import type { Translate } from '../i18n'

/**
 * 按传入的译文构造一个错误边界类。必须写成类，因为只有类能实现
 * `getDerivedStateFromError`；harness slot 自带的边界出错时只显示空白占位，
 * 这里则让失败保持可读，并给出一个清掉错误的重试按钮
 * （子树会用当前输入重新渲染）。
 */
export function makeErrorBoundary(t: Translate): ComponentType<{ children?: ReactNode }> {
  return class ErrorBoundary extends Component<{ children?: ReactNode }, { error: Error | null }> {
    constructor(props: { children?: ReactNode }) {
      super(props)
      this.state = { error: null }
    }

    static getDerivedStateFromError(error: unknown): { error: Error | null } {
      return { error: error instanceof Error ? error : new Error(String(error)) }
    }

    render(): ReactNode {
      const error = this.state.error
      if (error === null) return this.props.children
      return (
        <div className="lc-root">
          <div className="lc-empty lc-error">
            <span>{t('error')}</span>
            <code className="lc-error-msg">{error.message}</code>
            <button
              type="button"
              className="lc-error-retry hover:border-(--dsw-alias-label-primary)"
              onClick={() => { this.setState({ error: null }) }}
            >{t('error.retry')}</button>
          </div>
        </div>
      )
    }
  }
}
