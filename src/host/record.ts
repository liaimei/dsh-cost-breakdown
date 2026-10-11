/** 每个不可信 payload 在读取字段前都要过一遍的唯一一次纯对象复核。数组被排除：
 * 它们运行时确实是对象，却没有可按键读取的记录。 */

/** 纯对象的记录视角；输入为 null、数组或原始值时返回 null，
 * 调用方因此不必在每一步都写 typeof 守卫就能探测字段。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
