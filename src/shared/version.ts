/** harness 版本闸门的共用算术：受支持的 dsh 基线与背后的比较逻辑。
 * 无依赖的运行时代码，两侧都要用（host 负责探测和拦停，client 负责展示 wire 记录）。
 * 基线与 docs/compatibility.md 及 package
 * 的 `dsh.compatibility.dshReleases` 声明保持一致。 */

/** fold 的各项假设所验证过的 dsh 版本（docs/compatibility.md）；
 * 闸门只拦停能被证明低于它的版本。 */
export const BASELINE_DSH_VERSION = '0.1.7-rc.2'

/** X.Y.Z 相同时按发布通道排名：正式版 > rc > beta > alpha。 */
function channelRank(channel: 'alpha' | 'beta' | 'rc'): number {
  return channel === 'rc' ? 3 : channel === 'beta' ? 2 : 1
}
const RELEASE_RANK = 4

/** 版本号拆成的有序字段：`rank` 是发布通道（4 = 正式版，见 {@link RELEASE_RANK}），
 * `serial` 是该通道后的 `.N`。 */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  rank: number
  serial: number
}

/** 解析 `v?X.Y.Z[-(alpha|beta|rc)[.N]][+build]`；其他通道（nightly、dev 等）无法解析——闸门对它们放行。 */
export function parseVersion(version: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.(\d+))?)?(?:\+[0-9a-z.-]+)?$/i.exec(version.trim())
  if (match === null) return null
  const channel = match[4]?.toLowerCase() as 'alpha' | 'beta' | 'rc' | undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rank: channel === undefined ? RELEASE_RANK : channelRank(channel),
    serial: match[5] ? Number(match[5]) : 0,
  }
}

/** 逐字段比较，绝不按字符串字典序：字符串下 `'0.1.10' < '0.1.9'`，会把闸门的判断整个反过来。 */
function compareParsed(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.rank !== b.rank) return a.rank - b.rank
  return a.serial - b.serial
}

/** 有意设计为失败即放行：无法解析的版本（dev/nightly 构建）不该让正常运行的部署直接失效，
 * 因此只有被证明低于基线的版本才会触发闸门。 */
export function meetsBaseline(version: string, baseline: string = BASELINE_DSH_VERSION): boolean {
  const v = parseVersion(version)
  const b = parseVersion(baseline)
  if (v === null || b === null) return true
  return compareParsed(v, b) >= 0
}
