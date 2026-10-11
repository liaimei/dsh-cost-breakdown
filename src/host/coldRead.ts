/**
 * 全 host 共用的冷读闸门（issue #121）。
 *
 * 每次冷读（预热遍历的逐 session fold、detail 路由的冷档）
 * 都会把整份持久日志实体化：持久化后端必须先解码每一帧才能切出一个事件，
 * 于是一个 1 万事件的 session 落地就是数百 MB 的对象图。
 * 闸门一次只放行一个读取（FIFO），且仅在堆还留有余量时放行；
 * 被跳过的读取走调用方自己设计的无数据路径，而不是变成一次可见的失败。
 */

import { getHeapStatistics } from 'node:v8'

/** 进程堆的一次瞬时读数，单位字节；`limit` 是 V8 的上限，不是操作系统的。 */
export interface HeapReading {
  used: number
  limit: number
}

/** 两条冷读路径共用的放行接口。 */
export interface ColdReadGate {
  /** 因压力跳过该读取时 resolve 出 `undefined`——改由调用方自己的无数据路径作答。 */
  admit<T>(read: () => Promise<T>): Promise<T | undefined>
}

/** 只有当已用堆低于进程自身 V8 上限的三分之二时冷读才启动，
 * 把上面三分之一留给读取本身以及 harness 自身的解码日志占用。 */
const HIGH_WATER = 2 / 3

function v8Reading(): HeapReading {
  const stats = getHeapStatistics()
  return { used: stats.used_heap_size, limit: stats.heap_size_limit }
}

/** 把队列链与某次读取的结果解耦，一次读取被拒就不会染污队尾、
 * 连带跳过之后所有的放行。 */
const noop = (): void => {}

/** 每个 host 进程一个闸门，两条冷读路径共用。`reading` 可注入以便测试；
 * 探测抛错或返回垃圾数据时按放行处理——这个表绝不能挡住读取。 */
export function makeColdReadGate(reading: () => HeapReading = v8Reading): ColdReadGate {
  const clear = (): boolean => {
    try {
      const { used, limit } = reading()
      if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return true
      return used < limit * HIGH_WATER
    } catch {
      return true
    }
  }
  let tail: Promise<unknown> = Promise.resolve()
  return {
    admit<T>(read: () => Promise<T>): Promise<T | undefined> {
      // 余量检查在队列头部执行，而不是入队时——排队期间内存压力会变。
      const run = tail.then(() => (clear() ? read() : undefined))
      tail = run.then(noop, noop)
      return run
    },
  }
}
