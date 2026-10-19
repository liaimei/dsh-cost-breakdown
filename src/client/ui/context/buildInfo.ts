/**
 * The build's identity, as baked in by the bundler.
 *
 * `tsdown` substitutes both macros at build time, so the version and repository a card prints cannot drift
 * from the artifact that is actually running. Outside a built artifact (a spec, a dev server) they are
 * simply absent, and the card omits the line rather than printing a guess.
 */

/** The package version the build was made from. */
declare const __DSH_CTX_VERSION__: string | undefined
/** The repository URL recorded in `package.json` at build time. */
declare const __DSH_CTX_REPO__: string | undefined

/** One read of the build's identity. */
export interface BuildInfo {
  version: string
  repo: string | null
}

/** Read the build macros defensively: an undeclared macro throws on access in a bare Node context. */
export function buildInfo(): BuildInfo {
  let version = 'unknown'
  let repo: string | null = null
  try {
    if (typeof __DSH_CTX_VERSION__ === 'string' && __DSH_CTX_VERSION__ !== '') version = __DSH_CTX_VERSION__
  } catch {
    // Not a built artifact.
  }
  try {
    if (typeof __DSH_CTX_REPO__ === 'string' && __DSH_CTX_REPO__ !== '') repo = __DSH_CTX_REPO__
  } catch {
    // Not a built artifact.
  }
  return { version, repo }
}
