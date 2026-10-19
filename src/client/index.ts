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

// Import order **is** the cascade order at equal specificity: the Tailwind utility sheet first (it is
// unlayered, so it must lose to everything below), then the shared scaffolding, then each surface's own
// sheet. Later sheets win.
import './styles/tailwind.css'
import './styles/base.css'
import './styles/stats.css'
import './styles/statsCost.css'
import './styles/jump.css'
import './styles/settings.css'
import './styles/stackedBar.css'
import './styles/trendChart.css'
import './styles/requestDetail.css'
import './styles/events.css'
import './styles/fileCard.css'
import './styles/modal.css'
import './styles/browser.css'
import './styles/detailSections.css'
import './styles/attachments.css'
import './styles/agentGraph.css'
import './styles/overview.css'
import './styles/dateRange.css'
import './styles/spend.css'
import './styles/composerDock.css'

// The rewritten surfaces' own sheets load after the ported ones, so where both describe the same element the
// current markup wins while every value it inherits is the shipped one.
import './styles/context.css'
import './styles/dock.css'
import './styles/insights.css'
import './styles/turnSpend.css'

import { apply, inject, name } from './entry'

// The handoff the shell reads. Written **in the entry file** on purpose: a `module.exports` assignment
// performed inside an imported module targets that module's own wrapper object, not the entry module the
// loader reads, so the loader would receive an empty object.
module.exports = { name, inject, apply }
