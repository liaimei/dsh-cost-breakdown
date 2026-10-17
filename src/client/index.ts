/**
 * Browser-bundle entry point.
 *
 * The build wraps this module in the harness's `window.__ModuleLoader__.load({ id, factory })` closure, so
 * the artifact's first executable statement is the factory's `require` table. That is why this file exists
 * at all instead of the entry living in `entry.ts`: the frozen `exports["./client"]` path points at
 * `lib/client.js`, and the file that produces it must not move when the implementation is reorganised.
 *
 * Style sheets are imported here, in cascade order: shared scaffolding first, then each surface. Later
 * sheets win at equal specificity, so the order is part of the styling contract.
 */

import './styles/base.css'
import './styles/context.css'
import './styles/dock.css'
import './styles/insights.css'
import './styles/turnSpend.css'

import { apply, inject, name } from './entry'

// The handoff the shell reads. Written **in the entry file** on purpose: a `module.exports` assignment
// performed inside an imported module targets that module's own wrapper object, not the entry module the
// loader reads, so the loader would receive an empty object.
module.exports = { name, inject, apply }
