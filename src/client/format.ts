/** 紧凑的 token/计数数字：`k`/`M`/`B` 量级保留一位小数，1000 以下为取整后的裸整数。
 *  `null`、`undefined` 与 `NaN` 一律显示长破折号，因为统计卡里
 *  缺失的数字和零不能看起来一样。 */
export function fmt(n: number | null | undefined): string {
  if (n === undefined || n === null || isNaN(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const a = Math.abs(n)
  if (a >= 1e9) return sign + (a / 1e9).toFixed(1) + 'B'
  if (a >= 1e6) return sign + (a / 1e6).toFixed(1) + 'M'
  if (a >= 1000) return sign + (a / 1000).toFixed(1) + 'k'
  return sign + String(Math.round(a))
}

/** 十进制 kB/MB，绝不用 KiB：数字来自 harness 自己的字节计数，
 *  UI 其他位置的说明文字也用同一种十进制写法。负字节数
 *  按缺失处理，而不是带符号渲染出来。 */
export function fmtBytes(n: number | null | undefined): string {
  if (n === undefined || n === null || isNaN(n) || n < 0) return '—'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB'
  if (n >= 1000) return (n / 1000).toFixed(1) + ' kB'
  return String(Math.round(n)) + ' B'
}

/** 计费 prompt 输入中的缓存命中占比，**截断**到两位小数（harness 聊天统计行
 * 与 token 卡片角标展示的数字）；epsilon 只用来吸收浮点噪声。
 * 没有任何计费时返回 null。 */
export function cacheHitPercent(reads: number, billed: number): string | null {
  // 截断而非四舍五入：0.999 个百分点不能打印成 1.00，
  // 那会在 harness 自己的行显示 0.99 时谎称已满一个百分点。
  if (!(billed > 0)) return null
  const scaled = Math.trunc((reads / billed) * 100 * 100 + 1e-9)
  return `${Math.floor(scaled / 100)}.${String(scaled % 100).padStart(2, '0')}`
}

/** 共用一个 formatter：每次调用都新建 Intl formatter 的开销约为格式化本身的 50 倍。 */
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })

/** 按浏览器本地时区的 24 小时制 `HH:MM:SS`，刻意与 locale 无关：
 *  只有每行等宽，时间条的等宽标题列才能对齐。 */
export function fmtTime(t: number): string {
  // en-GB 会给 HH:MM:SS 补零；非法日期必须显示 '—'（format 会抛 RangeError）。
  const d = new Date(t)
  if (isNaN(d.getTime())) return '—'
  return TIME_FMT.format(d)
}

/** 占整体的比例：会被 0.1% 精度抹掉的非零碎屑显示 '<0.1%'；占比上限为 100%。 */
export function fmtShare(part: number, total: number): string {
  // 总量非正时无所谓占比，因此显示破折号而不是 0%
  // （后者看起来像对空整体做出的一次真实测量）。
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—'
  if (part <= 0) return '0.0%'
  const pct = Math.min(1, part / total) * 100
  if (pct < 0.1) return '<0.1%'
  return `${pct.toFixed(1)}%`
}

/** 整个 session 的时长，用与 locale 无关的紧凑单位表示；非正输入显示破折号。 */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (ms < 3_600_000) return `${m}m${s}s`
  return `${Math.floor(m / 60)}h${m % 60}m`
}
