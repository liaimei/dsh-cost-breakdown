/**
 * The plugin's own glyph set.
 *
 * Icons come from the harness platform module, resolved **by name at load time** rather than
 * imported directly. Reason: a renamed or absent export would give a malformed element type and
 * React error #130, which takes the whole surface down. Resolving by name degrades to "renders
 * nothing" instead, losing one glyph rather than one page.
 */

import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement } from 'react'

/** Shape every resolved glyph has; the fallback must satisfy the platform type without knowing
 * which size/className fields it carries. */
export type Glyph = (props: IconProps) => ReactElement | null

const namespace = primitives as unknown as Record<string, unknown>

/** Resolve one export by name. Anything that is not a callable, or whose read throws, renders
 * nothing. */
export function resolveGlyph(name: string, source: Record<string, unknown> = namespace): Glyph {
  try {
    const found = source[name]
    if (typeof found === 'function') return found as Glyph
  } catch {
    // Fall through to the empty glyph.
  }
  return () => null
}

/** Model switch in the event list. */
export const GlyphBranch = resolveGlyph('IconBranchOutlineRegular')
/** Injected-context event marker. */
export const GlyphPlus = resolveGlyph('IconPlusOutlineRegular')
/** Copied confirmation on the skill card. */
export const GlyphCheck = resolveGlyph('IconCheckOutlineRegular')
/** Copy control (skill path, raw text). */
export const GlyphCopy = resolveGlyph('IconCopyOutlineRegular')
/** Close control on the find bar. */
export const GlyphClose = resolveGlyph('IconCloseOutlineRegular')
/** Preferences entry that opens this plugin's settings card. */
export const GlyphSettings = resolveGlyph('IconSettingsOutlineMedium')
/** Date-range dropdown and find-bar jump-down. */
export const GlyphChevronDown = resolveGlyph('IconChevronDownOutlineMedium')
/** Find bar's previous match. */
export const GlyphChevronUp = resolveGlyph('IconChevronUpOutlineMedium')
/** Find bar's query entry. */
export const GlyphSearch = resolveGlyph('IconSearchOutlineRegular')
/** Clock glyph that replaces the peak countdown in the narrow dock row — the same official
 * outline family as the rest of the status bar. */
export const GlyphClock = resolveGlyph('IconClockOutlineRegular')
/** The Statistics entry glyph, reused by the dock trigger so readers recognise the owner. */
export const GlyphInsights = resolveGlyph('IconChartBarOutlineRegular')
