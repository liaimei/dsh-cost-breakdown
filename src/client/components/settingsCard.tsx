/** dsh-cost-breakdown 的偏好设置卡片，以 Host 提供的 `cost-breakdown` 命名空间为键
 * （该名字是 **loader 行 id**，不是包名）：该命名空间
 * 不可用时（没有 Host 那一半的部署，或远程浏览器），这张卡片什么都不渲染。 */

import { useState, type ReactElement } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDown } from '../primitives'
import type { SettingsField, SettingsState } from '../settings'
import type { ViewKit } from '../viewkit'

/** 卡片由宿主注入的几个面；`useContextSettings` 缺失（远程浏览器）读作
 *  未提供服务，而不是崩掉。 */
export interface SettingsCardProps {
  useContextSettings?: <T>(selector: (state: SettingsState) => T) => T
  set?: (field: SettingsField, value: string) => void
}

/** 一行偏好设置：一个带标签的弹出菜单（`Menu` 自己 portal，所以传 `portal`）。
 *  被禁用的行仍然显示它已解析出的标签，所以命名空间无法写入时
 *  当前偏好依然可读。 */
interface PrefRowProps {
  label: string
  value: string
  options: ReadonlyArray<{ id: string; label: string }>
  disabled: boolean
  onPick: (id: string) => void
}

function PrefRow(props: PrefRowProps): ReactElement {
  const [open, setOpen] = useState(false)
  const active = props.options.find(o => o.id === props.value)?.label ?? props.value
  return (
    <div className="lc-settings-row">
      <span className="lc-settings-label">{props.label}</span>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={props.options}
        selectedId={props.value}
        onSelect={(id) => { setOpen(false); props.onPick(id) }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className="lc-settings-select hover:enabled:bg-(--dsw-alias-interactive-bg-hover) disabled:opacity-50 disabled:cursor-default"
            disabled={props.disabled}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(v => !v) }}
          >
            {active}
            <IconChevronDown />
          </button>
        )}
      />
    </div>
  )
}

/** 卡片各行据以构造的翻译函数。 */
type Translate = ViewKit['t']

/** 全部八行偏好设置，按显示顺序。`disabled` 合并了两种条件：
 *  命名空间不是 `ready` 时没有值可显示，而只读部署会静默
 *  丢弃写入。 */
function PreferenceRows(props: { t: Translate; state: SettingsState; set?: SettingsCardProps['set'] }): ReactElement {
  const { t, state, set } = props
  const disabled = state.status !== 'ready' || !state.writable
  return (
    <>
      <PrefRow
        label={t('settings.placement')}
        value={state.placement}
        disabled={disabled}
        options={[
          { id: 'all', label: t('placement.all') },
          { id: 'tab', label: t('placement.tab') },
          { id: 'sidebar', label: t('placement.sidebar') },
        ]}
        onPick={(id) => { set?.('defaultPlacement', id) }}
      />
      <PrefRow
        label={t('settings.insightsEntry')}
        value={state.insightsEntry}
        disabled={disabled}
        options={[
          { id: 'show', label: t('insightsEntry.show') },
          { id: 'hide', label: t('insightsEntry.hide') },
        ]}
        onPick={(id) => { set?.('insightsEntry', id) }}
      />
      <PrefRow
        label={t('settings.gran')}
        value={state.granularity}
        disabled={disabled}
        options={[
          { id: 'step', label: t('gran.step') },
          { id: 'turn', label: t('gran.turn') },
        ]}
        onPick={(id) => { set?.('defaultGranularity', id) }}
      />
      <PrefRow
        label={t('settings.mode')}
        value={state.mode}
        disabled={disabled}
        options={[
          { id: 'total', label: t('gran.total') },
          { id: 'delta', label: t('gran.delta') },
        ]}
        onPick={(id) => { set?.('defaultTrendMode', id) }}
      />
      <PrefRow
        label={t('settings.durationCurve')}
        value={state.durationCurve}
        disabled={disabled}
        options={[
          { id: 'show', label: t('insightsEntry.show') },
          { id: 'hide', label: t('insightsEntry.hide') },
        ]}
        onPick={(id) => { set?.('defaultDurationCurve', id) }}
      />
      <PrefRow
        label={t('settings.deltaBase')}
        value={state.deltaBase}
        disabled={disabled}
        options={[
          { id: 'step', label: t('browser.base.step') },
          { id: 'turn', label: t('browser.base.turn') },
        ]}
        onPick={(id) => { set?.('defaultDeltaBase', id) }}
      />
      <PrefRow
        label={t('settings.toolSort')}
        value={state.toolSort}
        disabled={disabled}
        options={[
          { id: 'size', label: t('tool.sort.size') },
          { id: 'count', label: t('tool.sort.count') },
          { id: 'name', label: t('tool.sort.name') },
        ]}
        onPick={(id) => { set?.('defaultToolSort', id) }}
      />
      <PrefRow
        label={t('settings.fileSort')}
        value={state.fileSort}
        disabled={disabled}
        options={[
          { id: 'count', label: t('files.sort.count') },
          { id: 'latest', label: t('files.sort.latest') },
          { id: 'path', label: t('files.sort.path') },
        ]}
        onPick={(id) => { set?.('defaultFileSort', id) }}
      />
    </>
  )
}

/**
 * 绑定 `kit`，返回偏好设置卡片。两个提前退出让配置不全的宿主保持安静：
 * 完全没有 selector（缺客户端那一半的构建）与 `unavailable` 命名空间
 * 都渲染 null，因为一排点不动的下拉框比没有卡片更糟。
 */
export function makePluginConfigCard(kit: ViewKit): (props: SettingsCardProps) => ReactElement | null {
  const { t } = kit
  return function PluginConfigCard(props: SettingsCardProps): ReactElement | null {
    const state = typeof props.useContextSettings === 'function' ? props.useContextSettings(s => s) : undefined
    if (state === undefined || state.status === 'unavailable') return null
    return (
      <div className="lc-settings-prefs">
        {!state.writable && state.status === 'ready'
          ? <p className="lc-settings-note" role="status">{t('settings.readOnly')}</p>
          : null}
        <PreferenceRows t={t} state={state} set={props.set} />
      </div>
    )
  }
}
