/**
 * DeepSeek 官方人民币价目表、北京峰时时段，
 * 以及把节假日按谷时价计费的中国法定节假日日历。
 *
 * 两侧共用：host fold 解析每笔结算所属的时段，
 * 分桶因此带着实际计费的费率；client 再对这些分桶计价。
 * 费率单位为「元 / 1M token」。
 * 缓存写入不单独计费，因此按缓存未命中费率计价。
 */

/** 某个时段的费率，单位「元 / 1M token」。 */
export interface OfficialRate {
  hit: number
  miss: number
  out: number
}

/** 一条官方价目：对外服务的 id、展示名，以及 API 用过的全部 wire id
 * （已退役与带版本号的写法都按同一模型计费）。 */
export interface OfficialModelRow {
  id: string
  label: string
  aliases: readonly string[]
  offPeak: OfficialRate
  peak: OfficialRate
}

/** 官方价目行。每一列上谷时价都恰好是峰时价的一半。 */
export const OFFICIAL_MODELS: readonly OfficialModelRow[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek-V4.1-Flash',
    aliases: [
      'deepseek-flash',
      'deepseek-v4.1-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4.1-flash-vision-exp',
    ],
    offPeak: { hit: 0.02, miss: 1, out: 4 },
    peak: { hit: 0.04, miss: 2, out: 8 },
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek-V4-Pro',
    aliases: ['deepseek-v4-pro', 'deepseek-v4.1-pro', 'deepseek-pro'],
    offPeak: { hit: 0.15, miss: 4.5, out: 13.5 },
    peak: { hit: 0.3, miss: 9, out: 27 },
  },
]

/** 北京峰时时段，用「左闭右开」的 [起始小时, 结束小时) 钟点区间表示。 */
export const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [14, 18],
]

/**
 * 中国法定节假日，按北京日期（`YYYY-MM-DD`）列出。这些日子全天按谷时计费，
 * 与周末一致。调休安排不明的日期宁可不列也不猜，
 * 因为错认一个节假日会让当天的每个请求都算错价。
 */
export const DEFAULT_HOLIDAYS: readonly string[] = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
]

/** 某个时刻的北京钟点字段；单独拆出来，
 * 让节假日判断和时段判断共用同一次换算。 */
export interface BeijingParts {
  year: number
  month: number
  day: number
  hour: number
  weekday: number
  /** 北京日历日期，形如 `YYYY-MM-DD`。 */
  date: string
}

/** 北京固定为 UTC+8 且不实行夏令时，偏移量因此是常量，
 * 直接用 UTC 取值器就能读到北京钟点。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 某个 epoch 时刻的北京钟点字段；非有限值按 epoch 处理。 */
export function beijingParts(time: number): BeijingParts {
  const shifted = new Date((Number.isFinite(time) ? time : 0) + BEIJING_OFFSET_MS)
  const month = shifted.getUTCMonth() + 1
  const day = shifted.getUTCDate()
  const year = shifted.getUTCFullYear()
  return {
    year,
    month,
    day,
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

/** 某个时刻是否落在北京峰时时段内；周末和列出的节假日全天谷时，
 * 12:00-14:00 这段空档同样是谷时。 */
export function isPeakBeijing(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): boolean {
  const parts = beijingParts(time)
  if (parts.weekday === 0 || parts.weekday === 6) return false
  if (holidays.includes(parts.date)) return false
  return PEAK_WINDOWS.some(([from, to]) => parts.hour >= from && parts.hour < to)
}

/** 这一天为什么全天谷时；不是这种日子则返回 null。
 *  与 {@link isPeakBeijing} 共用同一份周末/节假日规则，
 *  界面因此能说「今天为什么没有峰时」，而不是报一个指向下一个工作日的倒计时。 */
export function allDayOffReason(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): 'weekend' | 'holiday' | null {
  const parts = beijingParts(time)
  if (parts.weekday === 0 || parts.weekday === 6) return 'weekend'
  if (holidays.includes(parts.date)) return 'holiday'
  return null
}

/**
 * 某个 wire 模型 id 对应的官方价目行；
 * 价目表里没有的 id 返回 null。
 *
 * 匹配时忽略大小写，与每行的 id 和 aliases 精确比对。
 * 这里刻意不做子串猜测：
 * 单凭 `pro`/`flash` 猜会把别家厂商的模型套上 DeepSeek 费率，
 * 未列入的 DeepSeek 版本交给模型侧价目表，好过在这里算错价。
 */
export function matchOfficialModel(model: unknown): OfficialModelRow | null {
  const name = typeof model === 'string' ? model.trim().toLowerCase() : ''
  if (name === '') return null
  for (const row of OFFICIAL_MODELS) {
    if (row.id === name || row.aliases.includes(name)) return row
  }
  return null
}

/** 某模型在给定时段的计费费率；模型未列入时返回 null。 */
export function officialRateOf(model: unknown, peak: boolean): OfficialRate | null {
  const row = matchOfficialModel(model)
  return row === null ? null : (peak ? row.peak : row.offPeak)
}

/** 某个时刻所属的计价时段，以及它下一次翻转的时刻。 */
export interface PricingPeriod {
  peak: boolean
  /** 下次翻转发生的时刻及翻转后进入的时段；扫描范围内找不到则返回 null。 */
  next: { at: number; peak: boolean } | null
}

/** 时段扫描的步长；每个翻转边界都对齐到整点，以整小时为步长不会漏掉任何一个。 */
const HOUR_MS = 60 * 60 * 1000
/** 八天必定跨过一次边界：任何峰时时段或连续节假日都不超过一周。 */
const PERIOD_SCAN_MS = 8 * 24 * HOUR_MS

/**
 * `time` 所属的计价时段，以及它下一次翻转的时刻。
 *
 * 扫描以整北京小时为步长，这是精确做法而非近似：每个时段边界（09:00、12:00、14:00、18:00）
 * 以及每一次跨日/跨星期/节假日变化都落在整点上，所以不会漏掉任何翻转，
 * `next.at` 就是翻转后的第一个瞬间。
 */
export function periodAt(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): PricingPeriod {
  const now = Number.isFinite(time) ? time : 0
  const peak = isPeakBeijing(now, holidays)
  const limit = now + PERIOD_SCAN_MS
  for (let t = Math.ceil(now / HOUR_MS) * HOUR_MS; t <= limit; t += HOUR_MS) {
    // 边界本身属于新时段，因此踩在边界上的这一步就会报告翻转。
    if (isPeakBeijing(t, holidays) !== peak) return { peak, next: { at: t, peak: !peak } }
  }
  return { peak, next: null }
}

/**
 * 收窄 `holidays` 配置字段。不是数组（或其中没有可用项）就返回 undefined，
 * 以便启用内置表：空表会让每个节假日都按峰时价计费，
 * 悄无声息地让这些日子的费用翻倍。
 */
export function holidaysFrom(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const valid = value.filter((entry): entry is string =>
    typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry))
  return valid.length > 0 ? valid : undefined
}

/** 峰时时段的可读写法，例如 `09:00–12:00, 14:00–18:00`。
 *  由 {@link PEAK_WINDOWS} 派生，改表即改文案，不会各说各话。
 *  `separator` 由调用方按语言给出——这里不写死分隔符，
 *  否则中文顿号会被带到英文界面上。 */
export function peakWindowsText(separator = ', '): string {
  return PEAK_WINDOWS
    .map(([from, to]) => `${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00`)
    .join(separator)
}

/**
 * 下一次时段边界距离 `time` 还有多少毫秒；扫描窗口内找不到翻转时返回 null。
 * 边界已过或恰好踩线时返回 0 而不是负数——调用方的节拍可能刚好晚于边界一瞬，
 * 报一个负的剩余时间只会让人怀疑读数坏了。
 */
export function msUntilFlip(time: number, holidays: readonly string[] = DEFAULT_HOLIDAYS): number | null {
  const now = Number.isFinite(time) ? time : 0
  const next = periodAt(now, holidays).next
  return next === null ? null : Math.max(0, next.at - now)
}

/** 倒计时的时分秒拆解，供调用方按语言拼装文案；
 *  这里只做算术，不含任何语言的单位词。 */
export interface CountdownParts {
  hours: number
  minutes: number
  seconds: number
}

/** 把剩余毫秒拆成时分秒；负值与非有限值一律按 0 处理。 */
export function countdownParts(remainingMs: number | null): CountdownParts | null {
  if (remainingMs === null || !Number.isFinite(remainingMs)) return null
  const total = Math.max(0, Math.floor(remainingMs / 1000))
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  }
}
