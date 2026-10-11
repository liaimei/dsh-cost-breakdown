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
balance · current peak/off-peak**. Click to expand a detail card carrying the three
token buckets (cache hit / miss / output), the cost split by period, and the official
rate table for the period in force. The card is `position: fixed` and measured from the
trigger so it escapes the composer's own `overflow` clipping, flipping below the trigger
when there is no room above. The period badge and its countdown flip on the local clock.

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

## Relationship to upstream

| This repository | Upstream |
|---|---|
| Official CNY table + peak/off-peak + Chinese holidays | models.dev USD book + flat `PEAK_FACTOR = 2`, no holiday table |
| Persistent composer-dock readout | none |
| `holidays` field in `host/config.ts` | none |
| `contextTimeline` stateVersion 28, `contextActivity` 5 | 27 / 4 |

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
  stateVersion 27→28 / 4→5) — no assertion was weakened;
- `tests/compat/bundle.spec.ts` loads the **built** `lib/client.js`, exercising the
  handoff protocol, the CSS channel and the slot registrations — so run
  `pnpm run build` first;
- this fork's own specs: `tests/shared/officialRates.spec.ts` (table / peak boundaries /
  holidays / fallback) and `tests/client/components/composerDock.spec.ts` (the readout
  and its card).

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
