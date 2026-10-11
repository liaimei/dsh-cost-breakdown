/**
 * DeepSeek 视觉模型的单图 token 估算——移植自 DeepSeek API 文档里的官方图片 token 计算器（https://api-docs.deepseek.com/zh-cn/quick_start/token_usage）：
 * 先保持宽高比缩放，
 * 再套 14px patch 网格与 3:1 下采样，
 * 每张图封顶 384 token。
 *
 * 纯数学，Host fold（消息计价）与 Client（附件卡片角标）共用。
 */

const PATCH_SIZE = 14
const DOWNSAMPLE_RATIO = 3
/** 官方规定的单图上限；下面预留的余量用于把最后一个网格步长压回上限之内。 */
const MAX_TOKENS = 384
const COMPRESS_PAD_TO = 4
/** 宽高比钳制：最宽允许 8:1，这也让高瘦分支永远走不到。 */
const MAX_WH_RATIO = 8
/** 像素数低于此值的图片会被上采样到该值，与官方计算器一致。 */
const MIN_PIXELS = 147456

const floorDiv = (a: number, b: number): number => Math.floor(a / b)
const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b)

/** 官方 patch 网格的 token 公式：`+1` 那一列是每行的分隔 token，
 * 奇偶项则对应网格强制的半行配对。 */
function gridTokens(rows: number, cols: number): number {
  let n = rows * (cols + 1) + 2
  if (rows % 2 === 1) n += cols + 1
  n += (ceilDiv(rows, 2) * (cols + 1) % 2) * 2
  return n
}

/** 一次求解结果：下采样后的 LLM 网格尺寸、
 * 对应的像素尺寸，以及最终 token 数。 */
interface ResizeSolution {
  nLlmH: number
  nLlmW: number
  bestHeight: number
  bestWidth: number
  numTokens: number
}

/** 给定 token 预算时闭式求解最优缩放，移植自官方计算器；
 * `bestWidth`/`bestHeight` 会先向下取整到整数个 patch。 */
function solveResizeRatio(height: number, width: number, budget: number): ResizeSolution {
  const ratio = height / width
  const gridW = Math.sqrt((budget - 2) / ratio + 0.25) - 0.5
  const gridH = gridW * ratio
  const unit = PATCH_SIZE * DOWNSAMPLE_RATIO
  let bestHeight: number
  let bestWidth: number
  if (gridW < 1) {
    let rows = floorDiv(budget - 2, 2)
    /* v8 ignore else -- 高瘦分支从不递减，因此这里的 rows 必为奇数。 */
    if (rows % 2 === 1) rows -= 1
    bestWidth = unit
    bestHeight = rows * unit
  /* v8 ignore start -- 不可达：MAX_WH_RATIO 的钳制让 height/width ≥ 1/8，
     gridH 因此不可能低于 2；此处逐字保留官方计算器的移植。 */
  } else if (gridH < 2) {
    const cols = floorDiv(budget - 2, 2) - 1
    if (cols <= 1) throw new Error('image tokens: budget too small to solve')
    bestHeight = 2 * unit
    bestWidth = cols * unit
  /* v8 ignore stop */
  } else {
    const cols = Math.trunc(gridW)
    // 官方网格按行配对：奇数行数向下取整。
    let rows = Math.trunc(gridH)
    if (rows % 2 === 1) rows -= 1
    const scale = Math.min(cols * unit / width, rows * unit / height)
    bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE
  }
  const nLlmH = ceilDiv(floorDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const nLlmW = ceilDiv(floorDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO)
  return { nLlmH, nLlmW, bestHeight, bestWidth, numTokens: gridTokens(nLlmH, nLlmW) }
}

/** 先按补边后的图片原样计价，只有超出预算时才回落到比例求解，
 * 每次把预算下调一个 token，直到求解收敛。 */
function safeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): ResizeSolution {
  const nLlmH = ceilDiv(floorDiv(paddedHeight, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const nLlmW = ceilDiv(floorDiv(paddedWidth, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const pad = COMPRESS_PAD_TO - 1
  const budget = MAX_TOKENS - pad
  let result: ResizeSolution = {
    nLlmH,
    nLlmW,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(nLlmH, nLlmW),
  }
  if (result.numTokens > budget) {
    result = solveResizeRatio(height, width, budget)
    let nextBudget = budget
    while (result.numTokens > budget) {
      nextBudget -= 1
      result = solveResizeRatio(height, width, nextBudget)
    }
  }
  result.numTokens += pad
  return result
}

/** 钳制宽高比、补足最小像素面积、补边到整数个 patch，然后求解。 */
function calcResizeInner(width: number, height: number): ResizeSolution {
  let w = width
  let h = height
  if (w > h * MAX_WH_RATIO) w = h * MAX_WH_RATIO
  const pixels = w * h
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    w = Math.trunc(w * scale)
    h = Math.trunc(h * scale)
  }
  const paddedWidth = ceilDiv(w, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(h, PATCH_SIZE) * PATCH_SIZE
  return safeResize(h, w, paddedHeight, paddedWidth)
}

/** 估算一张图的 DeepSeek 视觉 token；尺寸退化或求解不收敛时返回 null，
 * 调用方随即回落到结构性计价。 */
export function estimateImageTokens(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  try {
    let result = calcResizeInner(width, height)
    // 补边可能把结果重新顶回预算之上，因此反复重跑直到某一轮所有字段都不再变化；
    // 不收敛时报 null，而不是死循环。
    for (let i = 1; i < 10; i++) {
      const next = calcResizeInner(result.bestWidth, result.bestHeight)
      if (next.nLlmH === result.nLlmH && next.nLlmW === result.nLlmW
        && next.bestHeight === result.bestHeight && next.bestWidth === result.bestWidth
        && next.numTokens === result.numTokens) return result.numTokens
      result = next
    }
    return null
  } catch {
    /* v8 ignore next -- 唯一的抛出点是被钳制屏蔽掉的预算守卫；这里保证
       恶意尺寸不会拖垮 fold。 */
    return null
  }
}
