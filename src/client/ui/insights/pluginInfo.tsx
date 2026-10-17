/**
 * The plugin's identity card on the Insights page.
 *
 * It reports what this build is — name, version, repository — because a user reading a cost figure needs
 * to know which build produced it. Version and repository come from build-time macros, so they cannot
 * drift from the artifact they describe.
 */

import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { Translate } from '../../i18n/dict'

/** The version baked into this build. */
declare const __DSH_CTX_VERSION__: string | undefined
/** The repository URL baked into this build. */
declare const __DSH_CTX_REPO__: string | undefined

/** The build's version, or `unknown` outside a built artifact (a test or a dev server). */
export function buildVersion(): string {
  try {
    return typeof __DSH_CTX_VERSION__ === 'string' ? __DSH_CTX_VERSION__ : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The build's repository URL, when the bundler provided one. */
export function buildRepo(): string | null {
  try {
    return typeof __DSH_CTX_REPO__ === 'string' && __DSH_CTX_REPO__ !== '' ? __DSH_CTX_REPO__ : null
  } catch {
    return null
  }
}

/** The card. */
export function PluginInfoCard(props: { t: Translate }): ReactElement {
  const { t } = props
  const repo = buildRepo()
  return h('div', { className: 'cb-card cb-ov-plugin' },
    h('div', { className: 'cb-card-title' },
      h('span', { className: 'cb-card-title-text' }, t('plugin.title'))),
    h('div', { className: 'cb-ov-plugin-row' },
      h('span', { className: 'cb-ov-plugin-name' }, t('plugin.name')),
      h('span', { className: 'cb-ov-plugin-version' }, buildVersion())),
    repo !== null
      ? h('a', { className: 'cb-ov-plugin-link', href: repo, target: '_blank', rel: 'noreferrer' }, t('plugin.github'))
      : null,
    h('div', { className: 'cb-card-sub' }, t('plugin.hint')))
}
