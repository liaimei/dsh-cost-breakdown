/**
 * DeepSeek vision token estimator.
 *
 * Ported from the provider's published image token calculator: scale while preserving the
 * aspect ratio, snap to a 14 px patch grid downsampled 3:1, and cap each image at 384 tokens.
 * Pure maths, shared by the host fold (message pricing) and the browser (attachment badges).
 */

const PATCH = 14
const DOWNSAMPLE = 3
/** The provider's per-image ceiling. */
const TOKEN_CEILING = 384
/** Padding reserved so the last grid step can be pulled back under the ceiling. */
const PAD_TO = 4
/** Widest allowed aspect ratio; also keeps the tall branch of the solver unreachable. */
const MAX_RATIO = 8
/** Images below this pixel count are upscaled to it, matching the official calculator. */
const MIN_PIXELS = 147_456

const floorDiv = (a: number, b: number): number => Math.floor(a / b)
const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b)

/** Token cost of a grid: `+1` is the per-row separator, and the parity terms are the grid's
 * forced half-row pairing. */
function gridTokens(rows: number, cols: number): number {
  let total = rows * (cols + 1) + 2
  if (rows % 2 === 1) total += cols + 1
  total += (ceilDiv(rows, 2) * (cols + 1) % 2) * 2
  return total
}

interface Fit {
  rows: number
  cols: number
  height: number
  width: number
  tokens: number
}

/** Closed-form scale solve for a token budget, ported from the official calculator. `width` and
 * `height` come back floored to whole patches. */
function fitToBudget(height: number, width: number, budget: number): Fit {
  const ratio = height / width
  const gridWidth = Math.sqrt((budget - 2) / ratio + 0.25) - 0.5
  const gridHeight = gridWidth * ratio
  const unit = PATCH * DOWNSAMPLE
  let bestHeight: number
  let bestWidth: number
  if (gridWidth < 1) {
    let rows = floorDiv(budget - 2, 2)
    if (rows % 2 === 1) rows -= 1
    bestWidth = unit
    bestHeight = rows * unit
  } else if (gridHeight < 2) {
    const cols = floorDiv(budget - 2, 2) - 1
    if (cols <= 1) throw new Error('image token estimate: budget too small to solve')
    bestHeight = 2 * unit
    bestWidth = cols * unit
  } else {
    const cols = Math.trunc(gridWidth)
    let rows = Math.trunc(gridHeight)
    if (rows % 2 === 1) rows -= 1
    const scale = Math.min(cols * unit / width, rows * unit / height)
    bestWidth = Math.trunc(width * scale / PATCH) * PATCH
    bestHeight = Math.trunc(height * scale / PATCH) * PATCH
  }
  const rows = ceilDiv(floorDiv(bestHeight, PATCH), DOWNSAMPLE)
  const cols = ceilDiv(floorDiv(bestWidth, PATCH), DOWNSAMPLE)
  return { rows, cols, height: bestHeight, width: bestWidth, tokens: gridTokens(rows, cols) }
}

/** Price the padded original as-is; only an over-budget result falls back to the ratio solver,
 * lowering the budget one token at a time until it converges. */
function fitPadded(height: number, width: number, paddedHeight: number, paddedWidth: number): Fit {
  const rows = ceilDiv(floorDiv(paddedHeight, PATCH), DOWNSAMPLE)
  const cols = ceilDiv(floorDiv(paddedWidth, PATCH), DOWNSAMPLE)
  const budget = TOKEN_CEILING - PAD_TO + 1
  let fit: Fit = {
    rows, cols, height: paddedHeight, width: paddedWidth, tokens: gridTokens(rows, cols),
  }
  if (fit.tokens > budget) {
    let nextBudget = budget
    fit = fitToBudget(height, width, nextBudget)
    while (fit.tokens > budget) {
      nextBudget -= 1
      fit = fitToBudget(height, width, nextBudget)
    }
  }
  fit.tokens += PAD_TO - 1
  return fit
}

/** Clamp the aspect ratio, lift the pixel floor, pad up to whole patches, then fit. */
function fitImage(width: number, height: number): Fit {
  let w = width
  let h = height
  if (w > h * MAX_RATIO) w = h * MAX_RATIO
  const pixels = w * h
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    w = Math.trunc(w * scale)
    h = Math.trunc(h * scale)
  }
  return fitPadded(h, w, ceilDiv(h, PATCH) * PATCH, ceilDiv(w, PATCH) * PATCH)
}

/**
 * Estimated vision tokens for one image.
 *
 * Returns `null` for degenerate dimensions or a non-converging solve, so the caller can fall
 * back to structural pricing instead of pricing a guess.
 */
export function estimateImageTokens(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  try {
    let fit = fitImage(width, height)
    // Padding can push the result back over the budget, so re-run until every field is stable.
    for (let attempt = 1; attempt < 10; attempt++) {
      const next = fitImage(fit.width, fit.height)
      const stable = next.rows === fit.rows && next.cols === fit.cols
        && next.height === fit.height && next.width === fit.width && next.tokens === fit.tokens
      if (stable) return fit.tokens
      fit = next
    }
    return null
  } catch {
    // The only throw is the budget guard the aspect clamp keeps unreachable; keep the fold safe.
    return null
  }
}
