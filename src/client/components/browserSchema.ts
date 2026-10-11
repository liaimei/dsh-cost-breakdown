/** 上下文浏览器的工具 schema 读取器：随生产者而变的参数词汇。 */

/**
 * 从 wire 上读到的一段 JSON-Schema 参数片段。每个字段都是 `unknown`，
 * 因为生产者（宿主折叠出的工具定义，或快照里的一个 `block`）不可信；
 * `{@link typeOf}` 在使用处逐个收窄。
 */
export interface ParamSchema {
  type?: unknown
  description?: unknown
  enum?: unknown
  items?: unknown
  anyOf?: unknown
  oneOf?: unknown
}

/** 把联合关键字收拢成一个 `A | B` 标签；片段两者都没有时返回 null。 */
function unionTypesOf(p: ParamSchema): string | null {
  const branches: unknown[] = []
  if (Array.isArray(p.anyOf)) branches.push(...p.anyOf as unknown[])
  if (Array.isArray(p.oneOf)) branches.push(...p.oneOf as unknown[])
  if (branches.length === 0) return null
  const parts: string[] = []
  for (const b of branches) {
    if (b !== null && typeof b === 'object') parts.push(typeOf(b))
  }
  return parts.length > 0 ? parts.join(' | ') : null
}

/**
 * 单个参数片段的展示标签。`anyOf`/`oneOf` 要在 `type` 之前检查，
 * 因为一个联合片段仍可能带一个裸 `type`，那样会盖住它的各个分支。
 * 读不出来的部分一律降级成 `'unknown'`——绝不降级成空白单元格，
 * 那会被读成「这个参数没有类型」。
 */
export function typeOf(p: ParamSchema): string {
  const u = unionTypesOf(p)
  if (u !== null) return u
  const t = p.type
  if (t === 'array') {
    const items = p.items
    if (items !== null && typeof items === 'object') {
      const inner = typeOf(items)
      return 'array<' + inner + '>'
    }
    return 'array'
  }
  if (typeof t === 'string') {
    if (t === 'object') {
      const props = (p as { properties?: unknown }).properties
      if (props !== null && typeof props === 'object' && Object.keys(props).length > 0) {
        // 属性名会把类型这一列撑爆，所以只显示它们的数量。
        return `object{${Object.keys(props).length}}`
      }
    }
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      return t + ' (enum)'
    }
    return t
  }
  if (Array.isArray(p.enum) && p.enum.length > 0) return '(enum)'
  return 'unknown'
}

/** 工具 schema 会把参数嵌在 `parameters`、`input_schema` 或 `inputSchema` 下（随生产者而变），
 * `type === 'object'` 时则直接平铺在顶层。 */
export function paramsOf(schema: unknown): ParamSchema | null {
  if (schema === null || typeof schema !== 'object') return null
  const s = schema as Record<string, unknown>
  const candidate = (v: unknown): ParamSchema | null =>
    v !== null && typeof v === 'object' ? v : null
  const nested = candidate(s.parameters) ?? candidate(s.input_schema)
    ?? candidate(s.inputSchema)
  if (nested !== null) return nested
  if (s.type === 'object' && s.properties !== undefined && typeof s.properties === 'object') {
    return s
  }
  return null
}

