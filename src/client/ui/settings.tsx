/**
 * The Plugins-page settings card.
 *
 * It is the only place a user edits this plugin's display preferences, and it writes them through the host
 * config form (namespace = the loader row id). Two rules keep it honest:
 *
 *   - A missing selector, or a scope the host reports as `unavailable`, renders **null**: a row of dead
 *     dropdowns is worse than no card.
 *   - Every write echoes locally first (the card must react immediately) and rolls back to the scope's
 *     truth if the write is rejected. A preference that failed to persist must not keep looking applied.
 */

import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { Translate } from '../i18n/dict'
import type { PreferencesState, PreferencesStore } from '../shell/preferences'
import type { PreferenceKey } from '../../wire/model'

/** The card's props: the injected preference hook plus the writer. */
export interface SettingsCardProps {
  t: Translate
  hooks?: { preferences?: { subscribe(listener: () => void): () => void; getSnapshot(): PreferencesState } }
  set?: (field: PreferenceKey, value: unknown) => void
  /** The store itself, when the host injected it directly instead of a hook seat. */
  store?: PreferencesStore
}

/** One toggle/choice row. */
function row(label: string, control: ReactElement, hint?: string): ReactElement {
  return h('div', { className: 'cb-set-row', key: label },
    h('div', { className: 'cb-set-label' }, label, hint !== undefined ? h('span', { className: 'cb-set-hint' }, hint) : null),
    h('div', { className: 'cb-set-control' }, control))
}

/** A segmented control for a small closed vocabulary. */
function segment(value: string, options: ReadonlyArray<{ value: string; label: string }>, onChange: (next: string) => void, disabled: boolean): ReactElement {
  return h('div', { className: 'cb-gran', role: 'group' },
    options.map(option => h('button', {
      key: option.value,
      type: 'button',
      className: `cb-gran-btn${option.value === value ? ' cb-gran-on' : ''}`,
      'aria-pressed': option.value === value,
      disabled,
      onClick: () => { onChange(option.value) },
    }, option.label)))
}

/** The settings card. */
export function PluginSettingsCard(props: SettingsCardProps): ReactElement | null {
  const { t, hooks, set } = props
  const store = props.store
  const state = store?.get() ?? hooks?.preferences?.getSnapshot()
  // No scope, or one the host cannot serve: render nothing rather than a dead form.
  if (state === undefined || state.status === 'unavailable') return null
  const write = (field: PreferenceKey, value: unknown): void => {
    if (set !== undefined) set(field, value)
    else store?.set(field, value)
  }
  const readOnly = !state.writable
  return h('div', { className: 'cb-set-card' },
    h('div', { className: 'cb-set-title' }, t('plugin.settings')),
    readOnly ? h('div', { className: 'cb-set-readonly' }, t('settings.readOnly')) : null,
    row(t('settings.placement'),
      segment(state.defaultPlacement, [
        { value: 'all', label: t('placement.all') },
        { value: 'tab', label: t('placement.tab') },
        { value: 'sidebar', label: t('placement.sidebar') },
      ], next => { write('defaultPlacement', next) }, readOnly)),
    row(t('settings.gran'),
      segment(state.defaultGranularity, [
        { value: 'step', label: t('gran.step') },
        { value: 'turn', label: t('gran.turn') },
      ], next => { write('defaultGranularity', next) }, readOnly)),
    row(t('settings.mode'),
      segment(state.defaultTrendMode, [
        { value: 'total', label: t('gran.total') },
        { value: 'delta', label: t('gran.delta') },
      ], next => { write('defaultTrendMode', next) }, readOnly)),
    row(t('settings.toolSort'),
      segment(state.defaultToolSort, [
        { value: 'count', label: t('tool.sort.count') },
        { value: 'size', label: t('tool.sort.size') },
        { value: 'name', label: t('tool.sort.name') },
      ], next => { write('defaultToolSort', next) }, readOnly)),
    row(t('settings.fileSort'),
      segment(state.defaultFileSort, [
        { value: 'count', label: t('files.sort.count') },
        { value: 'latest', label: t('files.sort.latest') },
        { value: 'path', label: t('files.sort.path') },
      ], next => { write('defaultFileSort', next) }, readOnly)),
    row(t('settings.insightsEntry'),
      segment(state.insightsEntry, [
        { value: 'show', label: t('insightsEntry.show') },
        { value: 'hide', label: t('insightsEntry.hide') },
      ], next => { write('insightsEntry', next) }, readOnly)),
    row(t('settings.planTier'),
      // Positional labels, not plan names: the index selects the Nth tier of whichever family a
      // platform belongs to, and families disagree on names (Lite/Pro/Max vs Lite/Essential/Standard/Pro).
      segment(String(state.defaultPlanTier), [
        { value: '0', label: t('plan.tierIndex.1') },
        { value: '1', label: t('plan.tierIndex.2') },
        { value: '2', label: t('plan.tierIndex.3') },
        { value: '3', label: t('plan.tierIndex.4') },
      ], next => { write('defaultPlanTier', Number(next)) }, readOnly),
      t('plan.tierTip')),
    row(t('settings.durationCurve'),
      segment(state.defaultDurationCurve, [
        { value: 'show', label: t('insightsEntry.show') },
        { value: 'hide', label: t('insightsEntry.hide') },
      ], next => { write('defaultDurationCurve', next) }, readOnly)),
  )
}
