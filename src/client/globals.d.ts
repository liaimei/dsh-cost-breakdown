/**
 * Runtime globals the browser bundle's CommonJS closure provides, plus the style channels the build
 * injects.
 *
 * Declared, never imported: the build wraps the bundle in a factory that hands it `require` and a
 * module object, and the shell supplies the platform module table that `require` resolves against.
 */

/** Resolves one platform module from the shell's frozen table. */
declare function require(id: string): unknown
/** The bundle's export face; the harness reads `name`, `inject` and `apply` off it. */
declare let module: { exports: Record<string, unknown> }
declare let exports: Record<string, unknown>

// Style channels (see tsdown.config.ts). A global sheet is imported purely for cascade order; CSS
// Modules hash their class names per build, so keys are looked up as strings.
/** A side-effect stylesheet: imported only for the cascade, never read from. */
declare module '*.css'
/** CSS Modules: class names are hashed each build. */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
/** An SVG file inlined as markup text. */
declare module '*.svg?raw' {
  const markup: string
  export default markup
}
