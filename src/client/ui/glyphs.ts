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

/**
 * Resolve one export by name, or by the first name in a candidate list that exists.
 *
 * The candidate list is what makes the glyph set survive a harness upgrade: the platform renames and
 * retires icons between releases (0.2.1 removed the whole `Icon*Chart*` family), and a single hard-coded
 * name would silently degrade to "renders nothing" on the release that dropped it. Listing the spelling
 * per generation lets one build serve both.
 *
 * Anything that is not callable, or whose read throws, is skipped; no candidate resolves to an empty
 * glyph, which still renders (nothing) instead of throwing.
 */
export function resolveGlyph(
  name: string | readonly string[],
  source: Record<string, unknown> = namespace,
): Glyph {
  for (const candidate of typeof name === 'string' ? [name] : name) {
    try {
      const found = source[candidate]
      if (typeof found === 'function') return found as Glyph
    } catch {
      // Try the next candidate.
    }
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
/** The Statistics entry glyph, reused by the dock trigger so readers recognise the owner.
 *
 * 0.1.x drew a bar chart; 0.2.1 retired every `Icon*Chart*` export and ships only data/gauge glyphs, so
 * the data glyph carries the identity on the newer harness. */
export const GlyphInsights = resolveGlyph(['IconChartBarOutlineRegular', 'IconDataOutlineRegular'])
/** The right-sidebar guide pill: a readout glyph for the session summary. The gauge is the glyph the
 * official composer stat pill uses, so the pill reads as one of the harness's own readouts. */
export const GlyphSummary = resolveGlyph(['IconDataOutlineRegular', 'IconGaugeOutlineRegular'])
