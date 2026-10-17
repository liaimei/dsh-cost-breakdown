/**
 * Harness version gate arithmetic.
 *
 * The gate only stops a harness that can be *proven* older than the baseline: an unparsable
 * version (a nightly or a dev build) must keep working, not be refused.
 */

/** The oldest harness this plugin's fold assumptions were verified against. Keep in step with
 * `package.json#dsh.compatibility.dshReleases`. */
export const BASELINE_RELEASE = '0.1.7-rc.2'

/** Channel rank used when major.minor.patch tie: release > rc > beta > alpha. */
const RELEASE_RANK = 4
const CHANNEL_RANK: Record<string, number> = { rc: 3, beta: 2, alpha: 1 }

/** A version split into comparable fields. */
export interface Release {
  major: number
  minor: number
  patch: number
  /** {@link RELEASE_RANK} for a release, otherwise the channel rank. */
  rank: number
  /** The `.N` after the channel, 0 when absent. */
  serial: number
}

/** Parse `v?X.Y.Z[-(alpha|beta|rc)[.N]][+build]`. Other channels return `null` (the gate lets
 * them through). */
export function parseRelease(version: string): Release | null {
  if (typeof version !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)(?:\.(\d+))?)?(?:\+[0-9a-z.-]+)?$/i.exec(version.trim())
  if (match === null) return null
  const channel = match[4] === undefined ? undefined : match[4].toLowerCase()
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    rank: channel === undefined ? RELEASE_RANK : (CHANNEL_RANK[channel] ?? 0),
    serial: match[5] === undefined ? 0 : Number(match[5]),
  }
}

/** Field-by-field comparison. Never string order: `'0.1.10' < '0.1.9'` lexicographically, which
 * would invert the gate. */
export function compareReleases(left: Release, right: Release): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  if (left.rank !== right.rank) return left.rank - right.rank
  return left.serial - right.serial
}

/** Whether a harness version is at or above the baseline. Fails **open**: anything unparsable
 * counts as supported. */
export function meetsBaseline(version: string, baseline: string = BASELINE_RELEASE): boolean {
  const parsed = parseRelease(version)
  const floor = parseRelease(baseline)
  if (parsed === null || floor === null) return true
  return compareReleases(parsed, floor) >= 0
}
