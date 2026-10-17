/**
 * The below-baseline notice.
 *
 * The host half answers with an `unsupported` record instead of folding anything when the running harness
 * predates the supported baseline: its log shapes and seams are outside the compatibility matrix, so
 * showing zeroes as if they were measurements would be a lie. This gate turns that record into a plain
 * "upgrade" statement.
 *
 * Dismissal is remembered twice — in mount state and in a module-level ledger — because the surface can
 * be remounted (a watch rebuild, a tab switch) and a dismissed notice must not come back on its own.
 */

import { useState } from 'react'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { Translate } from '../../i18n/dict'

/** Sessions whose gate the reader has dismissed. The ledger outlives a remount on purpose. */
const dismissed = new Set<string>()

/** Reset for tests. */
export function resetUpgradeGate(): void {
  dismissed.clear()
}

/** The gate. Renders nothing when there is no record or the reader already dismissed it. */
export function UpgradeGate(props: {
  t: Translate
  sessionId?: string
  /** The running harness release, from the wire record. */
  current: string
  /** The minimum release this build supports. */
  minimum: string
}): ReactElement | null {
  const { t, sessionId } = props
  const key = sessionId ?? ''
  const [gone, setGone] = useState(() => dismissed.has(key))
  // A missing record means the host folded normally: nothing to say.
  if (props.current === '' || props.minimum === '') return null
  if (gone) return null
  return h('div', { className: 'cb-gate-card', role: 'status' },
    h('div', { className: 'cb-gate-title' }, t('gate.title')),
    h('div', { className: 'cb-gate-body' }, t('gate.body', { current: props.current, minimum: props.minimum })),
    h('div', { className: 'cb-gate-actions' },
      h('button', {
        type: 'button',
        className: 'cb-gran-btn',
        onClick: () => {
          dismissed.add(key)
          setGone(true)
        },
      }, t('gate.ok'))))
}
