/** activity fold（host）与概览热力图（client）
 * 共用的本地日键（`YYYY-MM-DD`）：
 * 两侧都按机器自身的本地日分桶，fold 出来的键与浏览器里的格子才落在同一套日历上。
 * 日键的字典序就是时间序， fold 的保留上限与热力图的周计算都依赖这一点。 */

/** 持久化状态或浏览器传来的日键的形状校验；正则本身查不出滚动越界的日期（`2026-02-30`），
 * 这由 {@link dateOfDayKey} 另行拒绝。 */
export const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 月键的形状校验；月份 1-12 的范围由 `shiftMonthKey` 再查一遍，
 * 因为正则也接受 `2026-13`。 */
export const MONTH_KEY_RE = /^\d{4}-\d{2}$/

/** epoch 毫秒时刻对应的本地日键；超出有限且可表示的范围时返回 null——
 * 不可信的日志数据因此造不出垃圾键。 */
export function dayKeyOf(time: number): string | null {
  if (!Number.isFinite(time)) return null
  const d = new Date(time)
  const y = d.getFullYear()
  if (!Number.isFinite(y) || y < 1970 || y > 9999) return null
  return `${String(y).padStart(4, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 日键对应的本地零点 Date；键畸形或字段会滚动越界（2026-02-30）时返回 null。 */
function dateOfDayKey(key: string): Date | null {
  if (!DAY_KEY_RE.test(key)) return null
  const y = Number(key.slice(0, 4))
  const m = Number(key.slice(5, 7))
  const d = Number(key.slice(8, 10))
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return date
}

/** 把日键按本地天数推进 `delta` 天；走日期字段运算，夏令时造成的长短日才不会算错
 * （直接加 epoch 毫秒会在跨日边界时漂移一小时）。 */
export function shiftDayKey(key: string, delta: number): string | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setDate(date.getDate() + delta)
  return dayKeyOf(date.getTime())
}

/** 日键的本地星期（0 = 周日）；键畸形或滚动越界时返回 null。 */
export function weekdayOf(key: string): number | null {
  const date = dateOfDayKey(key)
  return date === null ? null : date.getDay()
}

/** 日键所在周的起始键，
 * 也就是开启本地周的周日——热力图的列原点；键畸形时返回 null。 */
export function sundayOfWeek(key: string): string | null {
  const weekday = weekdayOf(key)
  return weekday === null ? null : shiftDayKey(key, -weekday)
}

/** 日键的本地首毫秒——所选区间的闭始点；键畸形时返回 null。 */
export function startOfDayKey(key: string): number | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 日键的本地末毫秒——所选区间的闭终点，整天都被算进去。 */
export function endOfDayKey(key: string): number | null {
  const date = dateOfDayKey(key)
  if (date === null) return null
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

/** 把月键按本地月份推进 `delta` 个月；键畸形或目标超出 1970-9999 时返回 null。 */
export function shiftMonthKey(month: string, delta: number): string | null {
  if (!MONTH_KEY_RE.test(month)) return null
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  if (index < 1 || index > 12) return null
  const total = year * 12 + (index - 1) + delta
  const y = Math.floor(total / 12)
  if (y < 1970 || y > 9999) return null
  return `${String(y).padStart(4, '0')}-${String(total - y * 12 + 1).padStart(2, '0')}`
}

/** 一个月按周日起首展开成日键网格，每周用 null 补齐到七格；键畸形时返回 null。 */
export function monthGridOf(month: string): (string | null)[][] | null {
  const first = `${month}-01`
  const lead = weekdayOf(first)
  if (lead === null) return null
  const weeks: (string | null)[][] = []
  let week: (string | null)[] = []
  // 前导空格把该月第一天顶到它所属的星期列。
  for (let i = 0; i < lead; i++) week.push(null)
  for (let day = 0; ; day++) {
    const key = shiftDayKey(first, day)
    if (key === null || key.slice(0, 7) !== month) {
      while (week.length < 7) week.push(null)
      weeks.push(week)
      return weeks
    }
    week.push(key)
    if (week.length === 7) {
      weeks.push(week)
      week = []
    }
  }
}
