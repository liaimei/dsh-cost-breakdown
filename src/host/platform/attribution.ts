/// <reference types="node" />
/**
 * Live "tool → owning plugin" attribution, layered on top of the static remedies in
 * `./tool-sources.ts`.
 *
 * The durable log records tools as plain schemas, so the registering plugin has to be observed
 * at runtime. Cordis fires the `internal/get` waterfall on every service *read* and passes the
 * reading context as the first argument — so the reader's fiber name identifies the plugin that
 * is about to call `register()`.
 *
 * Three constraints shape the implementation:
 *
 * - **Keep a name, never a Context.** Holding the reader context would pin its whole agent (and
 *   that agent's session) past dispose. A string cannot pin anything.
 * - **Patch the stable instance, return the caller's proxy.** Cordis hands out a fresh traced
 *   proxy per read; the bookkeeping is keyed by identity, so it is done on the raw target
 *   (`Symbol.for('cordis.original')`). The proxy is still what the caller receives, because its
 *   `this` binding carries the reader's scoped registration semantics.
 * - **Idempotent, unwindable.** A reload re-installs the hook on an already-wrapped instance;
 *   the wrapper carries the original under a marker so wrapping never stacks, and disposal
 *   restores every patched instance.
 *
 * Best effort by design: an `await` between the read and `register()` can let another plugin's
 * read overwrite the slot, and the stack fallback needs a resolvable `package.json`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { UNATTRIBUTED_TOOL } from '../../wire/model'
import { mcpSourceOf, pinnedSourceOf } from './tool-sources'

/** What the headers unit consumes: an optional plugin label for a tool name. */
export interface ToolAttribution {
  ownerOf(name: string): string | undefined
}

/** This module's own path; used to skip the plugin's own frames in a caller stack. */
const SELF_URL = normalize(fileURLToPath(import.meta.url))

/** Directory → package name cache, miss results included (a deep walk runs at most once). */
const packageNameCache = new Map<string, string | undefined>()

/** How far the package walk climbs: far enough for any real `node_modules` nesting, shallow
 * enough that a corrupt path cannot spin. */
const PACKAGE_WALK_DEPTH = 12

/**
 * Best-effort package name of a module file: the nearest `package.json` carrying a `name`.
 * Every visited directory is cached whatever the outcome.
 *
 * @param file - absolute path of a module file.
 */
export function packageNameFrom(file: string): string | undefined {
  let dir = dirname(file)
  for (let depth = 0; depth < PACKAGE_WALK_DEPTH; depth++) {
    const cached = packageNameCache.get(dir)
    if (cached !== undefined) return cached
    const packageFile = join(dir, 'package.json')
    if (existsSync(packageFile)) {
      try {
        const name = (JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: unknown }).name
        if (typeof name === 'string' && name !== '') {
          packageNameCache.set(dir, name)
          return name
        }
      } catch {
        // Malformed or unreadable manifest: keep climbing.
      }
    }
    const parent = dirname(dir)
    packageNameCache.set(dir, undefined)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

/** Trailing `:line:column` of a stack frame. */
const FRAME_POSITION = /:\d+:\d+$/

/** The symbol cordis puts on a traced proxy; reading it yields the wrapped target. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * Strip the per-read traced proxy down to the stable instance, so identity-keyed bookkeeping
 * sees one object per service.
 */
function rawInstanceOf(service: unknown): unknown {
  const raw = (service as { [key: symbol]: unknown } | undefined | null)?.[CORDIS_ORIGINAL]
  return raw ?? service
}

/** This plugin's own package name, captured once: frames from it are never an attribution. */
const SELF_PACKAGE = packageNameFrom(SELF_URL)

/**
 * Resolve the registering package from a caller stack: the package of the first frame outside
 * this package. Both `file://` URLs and bare paths are understood.
 *
 * @param stack - `Error().stack`; pass `undefined` to skip the fallback entirely.
 */
export function callerPackageFrom(stack: string | undefined): string | undefined {
  if (stack === undefined || stack === '') return undefined
  for (const raw of stack.split('\n').slice(1)) {
    let line = raw.trim()
    if (!line.startsWith('at ')) continue
    line = line.slice(3)
    if (line.startsWith('async ')) line = line.slice(6)
    line = line.replace(/\)\s*$/, '')
    const position = FRAME_POSITION.exec(line)
    if (position === null) continue
    let target = line.slice(0, -position[0].length)
    if (target.includes('(')) target = target.slice(target.lastIndexOf('(') + 1)
    if (target.startsWith('file://')) {
      try {
        target = normalize(fileURLToPath(target))
      } catch {
        continue
      }
    } else if (!/^[A-Za-z]:[\\/]/.test(target) && !target.startsWith('/') && !target.startsWith('\\\\')) {
      // A bare specifier or an eval frame has no location we can map to a manifest.
      continue
    } else {
      target = normalize(target)
    }
    if (target === SELF_URL) continue
    const name = packageNameFrom(target)
    if (name !== undefined && name !== SELF_PACKAGE) return name
  }
  return undefined
}

/** The narrow slice of the tools service consulted for the boot snapshot. */
interface ToolsServiceFace {
  layers?: {
    global?: {
      tools?: {
        entries?: () => Iterable<[string, unknown]>
      }
    }
  }
}

/** One registration's shape, as far as attribution reads it. */
interface ToolDefinitionFace {
  name?: unknown
}

/** A wrapped `register` that remembers the function it replaced, so reloads never stack. */
type MarkedRegister = ((this: unknown, definition?: ToolDefinitionFace) => unknown) & {
  attributedOriginal?: unknown
}

/**
 * Install the live attribution hook on the plugin's fiber. It lives and dies with the calling
 * fiber, so disposing the plugin unwraps everything it patched.
 *
 * @param ctx - the context the plugin runs in; its own fiber name is excluded as an owner.
 */
export function createToolAttribution(ctx: Context): ToolAttribution {
  const live = new Map<string, string>()
  const wrapped = new WeakSet<object>()
  const self = ctx.fiber.name
  // Only the reader's fiber NAME is retained: keeping the context would pin its agent.
  let lastReader: string | undefined
  // One restore closure per instance patched by this incarnation (run by the dispose effect).
  const restores: (() => void)[] = []

  const wrapInstance = (tools: unknown): void => {
    if (tools === null || typeof tools !== 'object' || wrapped.has(tools)) return
    const instance = tools as { register?: unknown }
    const register = instance.register
    if (typeof register !== 'function') return
    wrapped.add(tools)
    // A reload re-installs the hook on an instance that is still wrapped: unwrap the previous
    // incarnation first, so wrappers cannot nest.
    const original = (register as MarkedRegister).attributedOriginal ?? register
    if (typeof original !== 'function') return
    const wrappedRegister = function (this: unknown, definition?: ToolDefinitionFace): unknown {
      const toolName = definition?.name
      let owner = lastReader
      if (owner === undefined || owner === '' || owner === 'root' || owner === self) {
        owner = callerPackageFrom(new Error().stack)
      }
      const dispose = (original as (this: unknown, definition?: unknown) => unknown).call(this, definition)
      if (typeof toolName === 'string' && owner !== undefined && owner !== 'root' && owner !== self && owner !== SELF_PACKAGE) {
        live.set(toolName, owner)
        if (typeof dispose === 'function') {
          // A registration's own disposer retires its live entry; a stale entry would attribute
          // a re-registered tool to its previous owner.
          return () => {
            try {
              return (dispose as () => unknown)()
            } finally {
              live.delete(toolName)
            }
          }
        }
      }
      return dispose
    } as MarkedRegister
    wrappedRegister.attributedOriginal = original
    instance.register = wrappedRegister
    restores.push(() => {
      if (instance.register === wrappedRegister) instance.register = original as typeof instance.register
    })
  }

  ctx.on('internal/get', (reader: Context, name: string, _error: Error, next: () => unknown) => {
    if (name !== 'tools') return next()
    const tools = next()
    // Patch the stable instance, but hand the caller its own proxy back: the proxy's `this`
    // binding carries the reader's scoped registration semantics.
    //
    // Everything here is best effort. `internal/get` is a Cordis-internal waterfall (verified on
    // cordis 4.1.0: `(ctx, name, error, next) => any`), not a public plugin extension point, so a
    // shape change or a hostile reader must degrade to "no attribution" rather than throw inside
    // another plugin's service read.
    try {
      const fiberName = reader?.fiber?.name
      if (typeof fiberName === 'string' && fiberName !== '') lastReader = fiberName
      wrapInstance(rawInstanceOf(tools))
    } catch {
      // Attribution is optional: the headers unit renders unattributed tools as such.
    }
    return tools
  })

  // Disposal unwraps every instance this incarnation patched. A closure that finds a newer
  // incarnation's wrapper in place does nothing: restoring is that incarnation's job.
  ctx.effect(() => () => {
    for (const restore of restores.splice(0)) restore()
  }, 'tools.register attribution')

  // An instance that was already provided before this plugin started is wrapped too, so it
  // captures later registrations. The tools it already held were registered before the hook
  // could observe them, so the boot snapshot marks them UNATTRIBUTED_TOOL rather than leaving
  // them blank (blank reads as "no plugin").
  const bootTools = rawInstanceOf(ctx.get('tools', false)) as ToolsServiceFace | undefined
  wrapInstance(bootTools)
  const boot = new Set<string>()
  try {
    const entries = bootTools?.layers?.global?.tools
    // Called as a method: `entries()` reads `this.data` and must keep its receiver. Any
    // unexpected shape degrades to "no boot snapshot" — attribution must never break startup.
    if (entries !== undefined && typeof entries.entries === 'function') {
      for (const [name] of entries.entries()) boot.add(name)
    }
  } catch {
    // Unsupported tools-service internals: degrade to no boot snapshot.
  }

  return {
    ownerOf: name =>
      mcpSourceOf(name) ?? live.get(name) ?? pinnedSourceOf(name)
        // A tool that existed at boot but was never captured cannot be attributed; the sentinel
        // keeps "unknown plugin" distinguishable from "no plugin" (undefined).
        ?? (boot.has(name) ? UNATTRIBUTED_TOOL : undefined),
  }
}
