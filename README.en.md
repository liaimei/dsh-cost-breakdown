# dsh-cost-breakdown — official CNY cost metering

> This plugin is a refactor on top of [dsh-context](https://github.com/bowenliang123/dsh-context)
> (`main@209169d`, the `main` line just after v0.66.1): **`src/` is upstream
> dsh-context verbatim**, so its 2000+ tests pass unmodified, and this repository
> **adds** two features on top — an **official CNY price table with peak/off-peak
> windows and Chinese public holidays**, and a **persistent cost readout under the
> composer**.

## What the base keeps

Because `src/` is upstream unchanged (apart from the wiring files listed below),
every context-insight surface is preserved:

- **Context dashboard**: composition (system / tools / user / assistant / tool results),
  trend chart, context browser, event list, file activity, agent network;
- **Cost Statistics page** (left nav, the renamed Context Insights page): cross-session KPI
  band, billed tokens split by the platform's own four buckets, context-composition donut,
  7-day usage chart, activity heatmap, skill loads, per-session cards, account-balance capsule;
- **the `/context` command** and its modal;
- **the per-session token and cost cards** (subagent costs folded in).

## What this fork adds

### ① The official CNY price table (`src/shared/officialRates.ts`)

Upstream prices only from the models.dev **USD** book, doubling a DeepSeek `peak`
bucket by a flat `PEAK_FACTOR = 2`, and it has **no holiday table**. This plugin
prices from the **official CNY list instead**:

| Model | Off-peak (cache hit / miss / output, CNY per 1M tokens) | Peak |
|---|---|---|
| DeepSeek-V4.1-Flash | 0.02 / 1 / 4 | 0.04 / 2 / 8 |
| DeepSeek-V4-Pro | 0.15 / 4.5 / 13.5 | 0.3 / 9 / 27 |

- **Peak windows**: Beijing time, Monday–Friday, 09:00–12:00 and 14:00–18:00.
  Everything else is off-peak, and off-peak is exactly half of peak.
- **Chinese public holidays**: the 2026 State Council arrangement (31 days) is built in.
  A holiday bills **off-peak all day**, exactly like a weekend. Override through the host
  config `holidays: ['2026-10-01', ...]` (Beijing dates).
- **Safe fallback**: a config value that yields no usable date falls back to the built-in
  table rather than being read as "no holidays" — the latter would bill every holiday at
  the peak rate and silently double those days.
- **The official table wins for the models it lists** (its peak column is the off-peak
  rate doubled); every other model still prices through upstream's models.dev tiers. So
  **DeepSeek costs show up even when the models.dev book never loads**.
- The period is resolved **host-side** (`src/host/foldMetering.ts`, `isPeakAt`), so the
  persisted buckets carry the rate that was **actually charged**, and a holiday really
  does land in the off-peak bucket.

### ② The persistent readout under the composer (`src/client/components/composerDock.tsx`)

Upstream has no such surface. Collapsed it is one line: **this session's cost ·
balance · current peak/off-peak**. Its box and palette match the official neighbours
(`ContextMeter.module.css`'s `.trigger` and `StatsPills.module.css`'s `.pill`, which sit
either side of it) item by item: the same 13px size, the same 20px line box and the same
`padding: 1px 8px`, so both stand 22px tall; the same `label-tertiary` rest colour, the
same `label-secondary` hover, and the official `separator-primary` for the separators,
none of them bolded. So it neither stands at a different height nor reads as a foreign
control. Only peak/off-peak keeps its semantic red/green — that is the one thing this
line exists to say. The period itself is **computed live**, never a hardcoded label: the
badge carries a **countdown to the next flip**, ticking once a second (the one-second
cadence in `usePricingPeriod`, which skips re-rendering frames where the period did not
move); the tooltip and the expanded card also spell out **which windows are peak**
(`09:00–12:00, 14:00–18:00`, derived from `PEAK_WINDOWS`, so changing the table changes
the label). Weekends and listed holidays are off-peak all day — then no countdown is
shown, since it would read as if peak were still coming today; the reason is stated
instead. **A status bar that cannot fit the full reading switches to an icon**: the whole
sentence (`Off-peak in 6h 38m`) collapses to a **clock icon plus a compact reading**
(`6h38m`, with the sentence kept in the tooltip), while the cost, the balance and the
peak/off badge all stay. The verdict compares **the space LEFT for this row** with the
width the full reading needs — not a hardcoded breakpoint against the row's total width:
the official usage pill and context ring sit in that same row and take their share first,
so the row can be wide while what remains for this line is not (live: an ~860px row, ~260px
taken by the official pair, ~570px left, ~600px needed). The available width is derived
from the parent's content box minus the sibling entries and the gaps; the needed width
comes from a measuring probe that is **always rendered at the full sentence but moved out
of view**, so neither figure depends on which form is currently shown and the row cannot
oscillate (compact → narrower → "there is room again" → back). The official `StatsPills`
responds to that same quantity (`min-width: 0` + `text-overflow: ellipsis`, shrinking by
actual available width). Click to expand a detail card that
**embeds the two
Summary Statistics cards themselves** — Token Stats and Cost Stats — plus the official
rate table for the period in force: one dataset, one layout, so the readout and the
statistics page can never disagree (the balance rides the cost card's own row rather than
appearing twice). The card is `position: fixed` and measured from the trigger so it
escapes the composer's own `overflow` clipping. Its look follows the **official harness
panel** (`stat-dialog.module.css`): the same `--dsw-specific-menu` surface, the same
`--dsw-radius-lg` radius, the same hairline stroke plus `--dsw-elevation-prominent`
shadow, and the same `z-index: 1100`, so it reads as one layer with the official popup
the session footer opens. Its width matches that panel's 440px cap (even for a short
trigger) and is clamped to the viewport, so it neither clips the right-hand figures nor
grows a horizontal scrollbar; all three blocks inside declare `box-sizing: border-box`
themselves, because the base `.lc-card` rule only sets it under `.lc-root`, which the
floating card has no ancestor of. It flips
below the trigger when there is no room above. The period badge flips on the local clock.

The balance comes from **two sources**, tried in order: (1) DSH's own account sign-in (the
`deepseekAccount` service, which needs **no API key** — this is what a signed-in desktop user has),
and (2) the API-key provider when no account service exists. The remembered figure paints
immediately and the readout re-reads it on a **60-second** cadence: the number moves with every
billed request, so a long-lived mount that read once would show a stale figure.

### ③ The Cost Statistics page: the platform's own billing buckets (`src/client/components/overviewBilled.tsx`)

The left-nav page, the right-sidebar tab and the conversation tab are all named **Cost Statistics**
now (renamed from Context Insights), and the page gains a
**Billed Tokens** card: the four buckets the platform actually bills, all **provider-reported and
exact** (never estimated).

| Bucket | Meaning |
|---|---|
| Cache input | `cacheReadTokens`, the cached part of the input |
| Uncached input | `inputTokens` (cache writes included), billed at the miss rate |
| Output | `outputTokens`, reasoning included |

Under the ring sits the **peak / off-peak cost split**, answering "how much of this rode the peak
rate". It complements the **context-composition donut** beside it — the same tokens, split by what
they were (system / tools / user / assistant / tool results): one says when the money was spent,
the other says what the tokens contained.

### ④ The session's cost card (`src/client/components/statsCost.tsx`)

The Summary Statistics head row gains a **Cost Stats** card between **Token Stats** and
**Timing Stats**, laid out like the donut cards on either side:

- **Bucket costs**: the session's spend split by the four billed buckets — cache input / uncached
  input / cache write / output. The ring carries the shares; each legend sub-row carries that
  bucket's money. Rates come from the same table the Token card uses, so "used more" and "paid
  more" are two views of one number.
- **Peak / off-peak split**: how much of the money rode each window, with its share. A zero window
  is still listed — the ring skips a zero arc, but the legend should not vanish with it.
- **Account balance**: the same two sources as the Insights capsule — the remembered figure is
  painted first, then the host route refreshes it. When neither answers, the row is absent rather
  than a zero standing in for "unknown".

All four cost surfaces (this card, the dock readout, the billed-tokens card and the Token card's
figures) price through the one entry point in `client/cost.ts` (`estimateSessionCostByBucket`), so
they cannot drift apart.

## Relationship to upstream

| This repository | Upstream |
|---|---|
| Official CNY table + peak/off-peak + Chinese holidays | models.dev USD book + flat `PEAK_FACTOR = 2`, no holiday table |
| Persistent composer-dock readout | none |
| Cost Stats card on the Summary Statistics page (buckets + peak/off-peak + balance) | none |
| `holidays` field in `host/config.ts` | none |
| `contextTimeline` stateVersion 29, `contextActivity` 6 | 27 / 4 |

The full change list is in `NOTICE`; fork notes are in `FORK.md`.

## Data sources

| Data | Source |
|---|---|
| Balance | upstream `host/balance.ts`: reads `settings` + `credentials`, then `api.deepseek.com/user/balance` (the plugin never touches your token) |
| Usage | the `usage` on each `assistant/message` in the session log, folded by the host into cumulative per-(provider, model, period) buckets |
| Price | this plugin's official CNY table (`src/shared/officialRates.ts`); models it does not list price from models.dev |
| Period | Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00 (excluding weekends and Chinese public holidays) |

## Billing semantics (important)

DSH records `inputTokens` as **cache-miss** input and `cacheReadTokens` as
**cache-hit** input; those and `outputTokens` are **disjoint** buckets. A real record:

```
{inputTokens: 192, outputTokens: 238, totalTokens: 13102, cacheReadTokens: 12672}
      192 +        12672       +        238      = 13102
```

Treating `inputTokens` as the whole prompt would bill the 12672 cached tokens at the
miss rate and **overstate the cost by roughly an order of magnitude**. This plugin
prices the three buckets separately (cache writes are not billed separately; they price
at the miss rate).

Costs are **estimates**, computed from the tokens DSH recorded against the official
price table; the platform invoice is authoritative. A model neither table lists counts
toward requests but is **not priced**, and the UI says so — it is never treated as free.

### Seeded sessions are counted once

This part is upstream behaviour, kept as-is: a forked or summary-rebuilt session is
**seeded** — its log opens with a copy of its ancestor's events, and those requests were
already billed in the ancestor. The host fold cuts the inherited prefix at the
`session/end-seed { inherited: true }` marker, so a child counts only what it really did.

## Install

This repository's package name is `dsh-cost-breakdown`, distinct from upstream's
`dsh-context`, so the two can coexist (though enabling both duplicates the context
surfaces in the UI — pick one).

From the GitHub source (the repository ships its build output, so no build step):

```bash
dsh plugin --profile web add github:liaimei/dsh-cost-breakdown
```

> **Never add a `prepare`/`postinstall` lifecycle script to `package.json`.**
> `lib/` is committed, so installation needs no build; but pnpm runs those scripts for
> git dependencies, and their presence is rejected with
> `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. The only way out for a consumer is to add the
> package — keyed by commit SHA — to `allowBuilds`, i.e. re-edit the allowlist on every
> push. Build through the explicit `pnpm run build` instead.

From a local checkout (for development; `link:` means a rebuilt `lib/` takes effect on
a page refresh):

```bash
dsh plugin --profile web add "dsh-cost-breakdown@link:/path/to/dsh-usage-meter"
```

Then **restart DSH** (the host half does not hot-reload); the persistent readout
appears under the composer.

### Notes when troubleshooting an install

- **Do not reach for `dsh plugin list` just to read state**: that subcommand is not
  read-only — it triggers a reconcile and writes to disk (observed removing dependencies
  no longer declared in the lockfile). Reading `~/.dsh/profiles/<profile>/package.json`
  and `node_modules/` directly is safer.
- **Confirm the host half is actually the new one**: `POST /api/dsh-cost-breakdown/skills`
  (with a session cookie) should answer 200; a 404 means old code is still loaded — restart
  DSH.
- **After moving the path or upgrading**, check that `dsh.profile.bundles` lists
  `dsh-cost-breakdown` exactly once, and that `cordis.patch.yml` has no `- id: <old name>`
  row pointing at a removed package.

> **On `dsh plugin list`**: that subcommand is not read-only — it triggers a reconcile and
> writes to disk (observed removing dependencies no longer declared in the lockfile). When
> you only want to inspect state, read `~/.dsh/profiles/<profile>/package.json` and
> `node_modules/` directly instead.

## Source and build

Source is TypeScript (`src/`), the artifacts are `lib/`, and **tsdown** builds two entries:

| Source | Artifacts | Notes |
|---|---|---|
| `src/host/index.ts` | `lib/index.js` + `lib/index.d.ts` | Host half (ESM). Needs a **DSH restart** after a change |
| `src/client/index.ts` | `lib/client.js` | Browser half (CJS, wrapped in `window.__ModuleLoader__.load`). A page refresh suffices |

```bash
pnpm install
pnpm run build      # tsdown -> lib/
pnpm run typecheck  # tsc --noEmit -p tsconfig.tests.json
```

The browser half has a **purity gate** (`tsdown.config.ts`): only `react` / `react-dom` /
`dsh-client-ui-primitives` may survive as runtime `require`s; everything else inlines.
A new inlineable dependency must also be added to `onlyBundle`.

## Verification

```bash
NODE_OPTIONS=--localstorage-file=/tmp/ls.db pnpm exec vitest run --coverage
```

- **2070 tests pass** and **100 % per-file coverage** is the repository's gate;
- 2000+ of them are upstream's own tests; 8 upstream spec files only had assertions
  updated for behaviour this fork deliberately changes (the official table superseding
  models.dev pricing, holidays no longer billing at peak, five slots becoming six,
  stateVersion 27→29 / 4→6) — no assertion was weakened;
- `tests/compat/bundle.spec.ts` loads the **built** `lib/client.js`, exercising the
  handoff protocol, the CSS channel and the slot registrations — so run
  `pnpm run build` first;
- this fork's own specs: `tests/shared/officialRates.spec.ts` (table / peak boundaries /
  holidays / fallback), `tests/client/components/composerDock.spec.ts` (the readout
  and its card), and `tests/client/components/statsCost.spec.ts` (the cost card:
  buckets / peak-off-peak / balance / empty state).

### Environment notes

1. **The DSH-bundled Node cannot run `tsdown`**: macOS rejects rolldown's native `.node`
   inside the app's signature (`different Team IDs`). Build with a normal Node
   (`/opt/homebrew/bin/node`); running the plugin is unaffected.
2. **Node 26 shadows jsdom's `localStorage`** with its own, which is `undefined` without
   `--localstorage-file`; ten client specs fail on it (upstream fails identically). Hence
   `NODE_OPTIONS=--localstorage-file=/tmp/ls.db`.

## Known limits

- **Holiday table**: the 2026 arrangement is built in. When the State Council publishes
  the next one, override with `holidays: [...]` or update `DEFAULT_HOLIDAYS` in
  `src/shared/officialRates.ts`.
- **Models in neither table**: unpriced and marked as such, never billed as free.
- **Currency display**: the official table is CNY; the English UI converts at
  **1 CNY = 0.15 USD**.
- **DSH traffic only**: requests made by other clients or by calling the API directly are
  not counted.

## Permissions & external services

| Item | Description |
|---|---|
| **Reads session logs** | read-only observation of local session events, to tally token usage |
| **Reads the balance** | via upstream `host/balance.ts`, reading `settings` + `credentials` then calling `api.deepseek.com` (the plugin never touches your token) |
| **Network** | the front-end models.dev price book (only needed for models outside the official table) and the balance query; everything else is local, and **nothing is reported anywhere** |
| **Local storage** | only the remembered balance (`localStorage`); no files, no database |
| **Telemetry** | none |
| **Writes** | none. The plugin is read-only: it never modifies your sessions, config or code |

## License

[Apache-2.0](LICENSE) © 2026 liaimei (a fork of the Apache-2.0 dsh-context; see `NOTICE`)
