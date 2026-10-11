/** host `connection` service 的接缝，插件的每个 fetch 路由（detail、backfill 触发器、balance、
 * skills）都从这里注册。接口与「取值时绑定」守卫只有这一处实现：
 * 不绑定的交接会让真实接口上的 `this` 丢失。 */

/** 路由消费的 host `connection` service 形态：每个字段都可选，因为较旧的
 * harness 可能不带 fetch 注册表就暴露该 service，甚至根本不暴露。 */
export interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Response | Promise<Response>
    }): () => void
  }
}

/** 从接口取出的路由注册器，取值时即完成绑定。 */
function fetchRouteRegistrar(connection: ConnectionHostFace | undefined) {
  return typeof connection?.fetch?.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
}

/** 注入 fiber 的 `effect`，即路由注册所使用的形态。 */
interface EffectScope {
  effect(effect: () => () => void, hint?: string): unknown
}

/**
 * 注册一条插件 fetch 路由。所有路由都是同一道 `/api` 栅栏后的 POST，因此这里统一处理
 * 请求形态、取值时绑定守卫和静默拒绝的 catch，而不是在每个 watcher 里各写一遍。
 * @returns 路由此刻是否已注册——接口缺失或注册表拒绝时为 false。
 */
export function registerPostRoute(
  c: EffectScope,
  connection: ConnectionHostFace | undefined,
  path: string,
  fetch: (request: Request) => Response | Promise<Response>,
  label: string,
): boolean {
  const register = fetchRouteRegistrar(connection)
  if (register === undefined) return false
  try {
    c.effect(() => register({ path, methods: ['POST'], requestBody: 'buffered', fetch }), label)
  } catch {
    // 敌意或拒绝注册的注册表不能把插件拖垮；路由只是保持不存在而已。
    return false
  }
  return true
}
