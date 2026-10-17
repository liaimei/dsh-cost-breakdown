/**
 * The plugin's mark: a three-segment gauge, bundled from the package's own `icon.svg` (the same
 * file `package.json#icon` hands the Host for the plugin list). Bundling it rather than borrowing
 * a platform glyph keeps the plugin's identity self-contained.
 *
 * There is exactly one drawing, recoloured for the one seat that needs it: the sidebar panel row
 * paints the same shape in `currentColor` so the shell's hover/active state owns the colour, like
 * a bundled row. The gauge is stroke-drawn, which is why recolouring (rather than a mask, which
 * would eat the fills) lets one artwork serve both seats.
 */

import sheetMarkup from '../../../icon.svg?raw'
import type { ReactElement } from 'react'
import type { Translate } from '../i18n/dict'

const SHEET = sheetMarkup
  .slice(sheetMarkup.indexOf('>') + 1, sheetMarkup.lastIndexOf('</svg>'))
  .trim()
  .replace(/>\s+</g, '><')

/** `mono` variant: every literal colour becomes `currentColor`, so the harness row's own colour
 * paints it. */
const MONO = SHEET
  .replace(/stroke="#[0-9A-Fa-f]{6}"/g, 'stroke="currentColor"')
  .replace(/fill="#[0-9A-Fa-f]{6}"/g, 'fill="currentColor"')

/** Props shaped like the harness `IconProps` the guide pill passes. */
export interface MarkProps {
  size?: number
  className?: string
  /** Sidebar panel row: paint with the surrounding text colour instead of the fixed palette. */
  mono?: boolean
}

/** The mark. Every registration uses it as a JSX type, so it stays a plain component: the Host's
 * slot renderer mounts it with `IconProps` only, and `mono` is opt-in. */
export function PluginMark({ size = 20, className, mono = false }: MarkProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      className={className}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      dangerouslySetInnerHTML={{ __html: mono ? MONO : SHEET }}
    />
  )
}

/** The sidebar panel-list glyph: the mark in `mono`, so the shell's row colour paints it and the
 * row's label/active state stay the shell's business. */
export function SidebarMark({ size = 18 }: { size?: number }): ReactElement {
  return <PluginMark size={size} mono />
}

/** The tab-chip title seat: a mark followed by the surface's own name, translated through the
 * plugin's bound translator so the chip follows the locale (a tab-info hook can throw on a tab
 * record that has not been committed yet). The caller supplies the key because the conversation
 * tab and the right-sidebar column answer different questions and so carry different names. */
export function makeTabTitle(t: Translate, key = 'tab'): () => ReactElement {
  return function TabTitle(): ReactElement {
    return (
      <>
        <PluginMark size={16} className="cb-title-icon" />
        <span className="cb-title-label">{t(key)}</span>
      </>
    )
  }
}
