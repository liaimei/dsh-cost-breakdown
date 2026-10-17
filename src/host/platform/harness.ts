/// <reference types="node" />
/**
 * Runtime harness-version probe for the baseline gate.
 *
 * The gate must know which harness it is running inside *without importing one*: importing a
 * harness package to ask for its version would make the answer depend on the very resolution
 * chain that may be broken, and would drag the harness into the plugin's dependency closure.
 * Instead the probe reads `package.json` manifests through Node's resolver, from two anchors:
 *
 * 1. **The running module tree** — `import.meta.resolve` of the library packages the host half
 *    imports at runtime. This is the exact pipeline that resolves those imports, so a host shell
 *    that redirects plugin imports redirects the probe the same way. A witness that lands
 *    inside this plugin's own root is its dependency closure, not the harness, and is discarded.
 * 2. **The harness home mirror** — `profiles/node_modules` under the harness home (resolved
 *    through the `dshHomePath` service), which points at the most recently repaired install.
 *    The `@deepseek-ai/dsh` CLI package is probed *only* here, because the plugin never
 *    imports it.
 *
 * Any failure resolves `undefined`, and the gate treats an unknown version as supported:
 * a failed probe must never disable a working deployment.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Library packages released in lockstep with the harness. */
const LIBRARY_PROBE_PACKAGES = ['@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session'] as const

/**
 * Anchor 1 order: the package the host half imports at runtime first (it must resolve for this
 * plugin to be running at all), then its sibling.
 */
const RUNNING_PROBE_PACKAGES = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection'] as const

/**
 * Anchor 2 order: the CLI first, because it carries the release version most directly, then the
 * library packages as a fall back.
 */
const HOME_PROBE_PACKAGES = ['@deepseek-ai/dsh', ...LIBRARY_PROBE_PACKAGES] as const

/** Resolve a bare specifier to a path on disk. */
type Resolve = (specifier: string) => string
/** Resolve a bare specifier to an ESM URL. */
type ResolveUrl = (specifier: string) => string

/**
 * This package's own root. A witness under it belongs to the plugin's dependency closure, not
 * to the harness. Located through the package's own `./package.json` self-reference so it is
 * right both in the source tree and in a packed install; a loader that cannot resolve it falls
 * back to this module's directory, which narrows the guard but never widens it.
 */
function ownPackageRoot(): string {
  try {
    return dirname(fileURLToPath(import.meta.resolve('dsh-cost-breakdown/package.json')))
  } catch {
    return dirname(fileURLToPath(import.meta.url))
  }
}

/** Computed once: the guard is a property of the install, not of a probe. */
const PLUGIN_ROOT = ownPackageRoot()

/**
 * The `version` of one manifest. A name mismatch is rejected so a hoisted namesake elsewhere in
 * the tree cannot answer for the package the probe asked about.
 */
function versionOfManifest(manifestPath: string, expectedName?: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as { name?: unknown; version?: unknown }
    if (expectedName !== undefined && record.name !== expectedName) return undefined
    return typeof record.version === 'string' && record.version !== '' ? record.version : undefined
  } catch {
    return undefined
  }
}

/** Direct `./package.json` subpath; fails when the export map does not publish it. */
function versionViaManifest(resolve: Resolve, packageName: string): string | undefined {
  try {
    return versionOfManifest(resolve(packageName + '/package.json'))
  } catch {
    return undefined
  }
}

/**
 * Ascend from the package entry point to its manifest. A bundled executable proxy carries the
 * real version but may export only an entry stub, and Node's exports gate can refuse the
 * `./package.json` subpath outright.
 */
function versionViaEntry(resolve: Resolve, packageName: string): string | undefined {
  let dir: string
  try {
    dir = dirname(resolve(packageName))
  } catch {
    return undefined
  }
  for (;;) {
    const version = versionOfManifest(join(dir, 'package.json'), packageName)
    if (version !== undefined) return version
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The first package on this anchor that can answer; packages that cannot are skipped. */
function probeAnchor(resolve: Resolve, packageNames: readonly string[]): string | undefined {
  for (const packageName of packageNames) {
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

/**
 * Whether `candidate` sits under `root`. A `..`-leading relative path is an escape, and a
 * cross-drive `relative()` result is absolute — both are outside.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Anchor 1's answer. A witness inside the plugin's own closure is discarded; a witness that
 * cannot produce a manifest is not an answer either.
 */
function probeRunningTree(resolve: Resolve, pluginRoot: string): string | undefined {
  for (const packageName of RUNNING_PROBE_PACKAGES) {
    let witness: string
    try {
      witness = resolve(packageName)
    } catch {
      // Absent on this anchor; the next package may still answer.
      continue
    }
    if (isInside(pluginRoot, witness)) continue
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

/** Anchor 1: Node's own resolution, seen from this module. */
function resolveRunningModule(specifier: string): string {
  return import.meta.resolve(specifier)
}

/**
 * The harness version actually in force for this process, or `undefined` when no anchor can
 * answer. The gate reads `undefined` as "supported", so a failed probe can only stay silent.
 *
 * @param ctx - the plugin context; only `dshHomePath` is read off it, and only for anchor 2.
 * @param resolveUrl - anchor 1's resolver, injectable for tests.
 * @param pluginRoot - this plugin's own root, injectable for tests.
 */
export function probeHarnessRelease(
  ctx: { get(name: string): unknown },
  resolveUrl: ResolveUrl = resolveRunningModule,
  pluginRoot: string = PLUGIN_ROOT,
): string | undefined {
  // A non-`file:` URL (an exotic loader) has no manifest on disk, so that witness is skipped
  // and anchor 2 answers instead.
  const running = probeRunningTree((specifier) => {
    const url = resolveUrl(specifier)
    if (!url.startsWith('file:')) throw new Error(`dsh-cost-breakdown: non-file module URL for ${specifier}`)
    return fileURLToPath(url)
  }, pluginRoot)
  if (running !== undefined) return running
  try {
    // app-boot's home resolver: a missing or hostile service simply produces no answer.
    const homePath = ctx.get('dshHomePath')
    if (typeof homePath === 'function') {
      const requireFromHome = createRequire((homePath as (...segments: string[]) => string)(
        'profiles',
        'dsh-cost-breakdown-version-probe.cjs',
      ))
      const home = probeAnchor(specifier => requireFromHome.resolve(specifier), HOME_PROBE_PACKAGES)
      if (home !== undefined) return home
    }
  } catch {
    // Nothing answered; the gate fails open.
  }
  return undefined
}
