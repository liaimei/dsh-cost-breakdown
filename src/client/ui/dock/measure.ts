/**
 * How much room the plugin's readout actually has on the composer row.
 *
 * The row is the harness's own `.dock` flex line: the official usage pills and context ring sit on it
 * beside this plugin's entry. The plugin's slot is a `kind: "list"` entry with no DOM wrapper, so
 * `trigger.parentElement` **is** that row.
 *
 * This is a pure function because the verdict has been wrong twice, both times about *which* width to
 * compare:
 *
 * 1. Comparing against the **whole row** ignores that the plugin is one entry among several; with an
 *    860 px row, ~260 px of official pills and a ~600 px readout, 600 vs 860 always says "fits".
 * 2. Subtracting the siblings' **squashed** widths looked right but fed back: the official pills are
 *    compressible (`min-width: 0` + ellipsis) while this entry is `flex: none`, so the shortfall lands
 *    on them — the narrower they get, the more room the arithmetic claims, and the plugin never
 *    collapses. That is precisely the shipped bug where the official readout shrank to an icon while
 *    this one stayed full.
 *
 * The fix is to subtract each sibling's **needed** (natural) width, which does not change under flex
 * pressure. The caller measures it.
 */

/** The raw amounts one verdict needs; all measured by the caller (0 under jsdom). */
export interface RoomInput {
  /** The row's `clientWidth` (includes padding, excludes border/scrollbar). 0 when unmeasurable. */
  rowWidth: number
  paddingLeft: number
  paddingRight: number
  /** Each **other** entry's needed width, excluding this one. */
  siblingWidths: readonly number[]
  /** The flex row's `column-gap` in px. */
  gap: number
}

/** Coerce a possibly-NaN style value into a non-negative number. */
function px(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * An entry's **needed** width: its current box plus whatever it (or a clipping descendant) is hiding.
 *
 * Visible + hidden does not change when flex redistributes space, which is the invariant the verdict
 * needs. Only genuinely clipping nodes (`scrollWidth > clientWidth`) contribute, so a parent that
 * merely propagates a child's clipping is not counted twice.
 *
 * A `null` element measures as 0.
 */
export function neededWidthOf(element: Element | null): number {
  if (element === null) return 0
  let width = 0
  try {
    width = element.getBoundingClientRect().width
    // The element itself may be the clipper.
    for (const node of [element, ...element.querySelectorAll('*')]) {
      const hidden = node.scrollWidth - node.clientWidth
      if (hidden > 0) width += hidden
    }
  } catch {
    // A hostile node (throwing on property access) measures as 0: one sibling under-counted beats the
    // whole verdict crashing.
    return 0
  }
  return width
}

/**
 * The width available to this entry; `null` when the row cannot be measured (≤ 0).
 *
 * The row width is `clientWidth`, which includes padding, so the content width subtracts both
 * paddings; then each other entry's needed width and the gaps between them. `n` siblings means `n + 1`
 * entries and `n` gaps.
 *
 * `null` rather than 0 keeps "cannot measure" distinct from "genuinely no room": the former (jsdom, the
 * first unlaid-out frame) must read as "fits" so an abnormal environment degrades to the full readout
 * instead of the icon.
 */
export function roomForEntry(input: RoomInput): number | null {
  const row = px(input.rowWidth)
  if (row <= 0) return null
  const content = row - px(input.paddingLeft) - px(input.paddingRight)
  const siblings = input.siblingWidths.reduce((sum, width) => sum + px(width), 0)
  const gaps = px(input.gap) * input.siblingWidths.length
  return Math.max(0, content - siblings - gaps)
}

/** The dock card's geometry inputs, measured from the trigger and the viewport. */
export interface CardPlacementInput {
  trigger: { left: number; top: number; bottom: number }
  viewport: { width: number; height: number }
  /** The card's own natural height (its `scrollHeight`, so a clamped card does not feed back). */
  natural: number
  /** The card's measured width before clamping. */
  cardWidth: number
}

/** Where the expanded card goes and how tall it may be. */
export interface CardPlacement {
  left: number
  top: number
  width: number
  maxHeight: number
  flip: boolean
}

/** Minimum card width: the official context meter's own floor. */
export const CARD_MIN_WIDTH = 264
/** Distance between the card and the trigger. */
const CARD_GAP = 8
/** Keep the card off the viewport edge. */
const VIEWPORT_GUTTER = 12
/** Below this height the card is not worth showing above the composer. */
const CARD_MIN_HEIGHT = 160

/**
 * Place the card, preferring above the trigger.
 *
 * Flip **only** when the space above is insufficient *and* below is roomier — "does not fit above" alone
 * was the off-screen bug: the card moved below into a space it also did not fit, landing as an invisible
 * sliver.
 */
export function placeCard(input: CardPlacementInput): CardPlacement {
  const { trigger, viewport } = input
  const natural = Math.max(input.natural, CARD_MIN_HEIGHT)
  const roomAbove = trigger.top - CARD_GAP - VIEWPORT_GUTTER
  const roomBelow = viewport.height - trigger.bottom - CARD_GAP - VIEWPORT_GUTTER
  const flip = roomAbove < natural && roomBelow > roomAbove
  const room = flip ? roomBelow : roomAbove
  const maxHeight = Math.max(CARD_MIN_HEIGHT, room)
  const top = flip ? trigger.bottom + CARD_GAP : trigger.top - Math.min(natural, maxHeight) - CARD_GAP
  const width = Math.min(
    Math.max(input.cardWidth, CARD_MIN_WIDTH),
    Math.max(CARD_MIN_WIDTH, viewport.width - VIEWPORT_GUTTER * 2),
  )
  const left = Math.max(VIEWPORT_GUTTER, Math.min(trigger.left, viewport.width - width - VIEWPORT_GUTTER))
  return { left, top, width, maxHeight, flip }
}

/**
 * Whether an official overlay is currently open at the plugin's own layer.
 *
 * Both live at `z-index: 1100`, so the later mount wins; the plugin therefore **yields** instead of
 * raising its layer. The official overlays (the context meter's panel and the stat dialog) are portalled
 * to `body` with `role="dialog"`, so they are found by that role plus the shared z-index.
 */
export function officialOverlayOpen(): boolean {
  if (typeof document === 'undefined') return false
  try {
    for (const element of document.body.querySelectorAll('[role="dialog"]')) {
      if (getComputedStyle(element).zIndex !== '1100') continue
      if (!(element instanceof HTMLElement)) continue
      if (element.style.display === 'none' || getComputedStyle(element).visibility === 'hidden') continue
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return true
    }
  } catch {
    // A hostile DOM must not take the dock down; "no overlay" is the safe answer.
  }
  return false
}
