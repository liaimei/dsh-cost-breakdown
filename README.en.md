# dsh-cost-breakdown — context insight and official CNY cost accounting

A DeepSeek Harness (DSH) plugin that keeps **context insight** and **per-platform cost accounting** in one
place. All money is estimated in the browser from the official CNY price table; the host writes **token
ledgers only** and never converts to a currency.

> **This repository is a complete rewrite.** The module layout and the implementation are newly written;
> no existing plugin's code organisation is reused. The behavioural contract (projection keys, wire fields,
> routes, slots, settings namespace) is unchanged, so it replaces the previous version in place.
> See `NOTICE` for provenance and licensing.

## Features

**Context insight (tokens only — no currency appears on these surfaces)**

- Conversation "Context" view: live composition strip, trend chart per step or turn (total / delta, with a
  duration curve), context browser by stage (system / tools / user / inject / skill / assistant / tool),
  context events, file activity, agent network, timing strip, and the selected request's detail.
- Right-sidebar session summary: this session's token totals plus per-platform spend.
- Left-sidebar "Statistics" page: token totals across sessions (billed buckets, stage composition, 7-day
  usage, activity heatmap, skill loads, session cards) and a **spend section** with one card per platform,
  each carrying its own currency and per-model detail.
- The `/context` command and dialog, plus a per-turn spend readout under each reply.

**Pricing**

- **Official CNY table**: DeepSeek-V4.1-Flash `0.02 / 1 / 4`, DeepSeek-V4-Pro `0.15 / 4.5 / 13.5`
  (off-peak, CNY per million tokens: cache hit / miss / output). Peak is exactly double.
- **Peak windows**: Beijing time, weekdays `09:00–12:00` and `14:00–18:00`; everything else is off-peak.
  Weekends and Chinese public holidays bill off-peak all day. The period is decided by **model**, not by
  route: an official-table model splits by the Beijing windows whichever route carried it.
- **Holiday fallback**: a `holidays` value that yields no usable date falls back to the built-in calendar —
  never to "no holidays", which would bill every holiday at the peak rate and silently double those days.
- **Per-platform, never summed**: CNY for DeepSeek, USD for third parties, credits for credit platforms.
  A model with no rate is labelled "no rate configured", never rendered as ¥0.
- **Relay price lists**: relay routes such as `woyao` resell other vendors, so the public registry cannot
  price them; the plugin reads the relay's own published list (USD per million tokens) while a user-declared
  rate still wins per model.
- **Subscriptions are quota, not money**: GLM Coding Plan, MiniMax M Plan, Kimi Code Plan, Alibaba Cloud
  Token Plan and Xiaomi MiMo Token Plan (plus the Z.AI international GLM plan) bill in quota credits and are
  never added to metered spend. Live remaining quota is shown when the vendor's usage API answers, and
  labelled "quota unavailable" when it does not — never 0.
- **Balance**: account login first, API key second; unreadable means nothing is shown — no guessing, no stale
  numbers.

## Install

```bash
dsh plugin --profile <profile> add github:liaimei/dsh-cost-breakdown   # ships lib/, no build needed
dsh plugin --profile <profile> add "dsh-cost-breakdown@link:/path/to/dsh-cost-breakdown"  # local dev
```

Do not add `prepare`/`postinstall` lifecycle scripts: `lib/` is committed and pnpm refuses to run such
scripts for git dependencies (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`). Build explicitly with
`pnpm run build`.

Restart DSH after installing (the host half assembles at boot). The composer-row readout, the left-sidebar
Statistics entry and the conversation Context tab then appear.

Compatibility: verified against DSH **0.2.2-rc.1** (cordis 4.1); `dsh.compatibility.dshReleases` declares
support from `0.1.7-rc.2`, and an older host takes the degraded path (zeroes plus an upgrade notice) instead
of failing to load.

## Configuration

Settings → Plugins → "Summary". Everything lives under the loader row id namespace
`cost-breakdown`: retention bounds (`maxRequestSteps`, `maxKeptTurns`, `maxEvents`, `maxNodes`,
`maxArchiveNodes`, `maxFileOps`), the `holidays` calendar, and the display preferences
(`defaultPlacement`, `defaultGranularity`, `defaultTrendMode`, `defaultToolSort`, `defaultFileSort`,
`insightsEntry`, `defaultDurationCurve`, `defaultPlanTier`).

`thirdPartyRates` and `creditRates` are hand-declared rate tables, currently edited only in
`cordis.patch.yml` (there is no settings editor for them yet). Keys are flat `<provider>:<model>`:

```yaml
- id: cost-breakdown
  name: dsh-cost-breakdown
  config:
    thirdPartyRates:
      'woyao-pro-2:gpt-5': { input: 1, output: 4, cacheRead: 0.5 }
    creditRates:
      'workbuddy:glm-5.3': 2
```

The browser half re-validates both tables entry by entry, so one malformed rate is dropped instead of
failing the whole row.

## Development

```bash
pnpm install
pnpm run build      # tsdown -> lib/index.js (host ESM) + lib/client.js (browser CJS closure)
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest: core / wire / host / client / bundle
```

| Directory | Contents |
|---|---|
| `src/wire/` | Wire contract: types, zod schemas, projection-key augmentation |
| `src/core/` | Shared pure maths: Beijing calendar and peak windows, official rates, token estimation, file-op derivation, ledger, subscription plans and quotas |
| `src/host/` | The Cordis plugin: fold engine, three projection units, seven HTTP channels, platform adapters, settings schema |
| `src/client/` | Browser half: shell adapters, data layer (incl. relay price lists and plan quotas), i18n, UI surfaces |

## Verification

```bash
pnpm run typecheck && pnpm test
```

The suite covers the shared maths, the wire schemas, the fold reducer (reference discipline, error
containment, metering, retention), the three projection units and their degraded fallbacks, the browser data
layer (price precedence, aggregation, boundary washers), and the **built artifacts'** loadability (client
closure protocol, platform-module table, host `apply()` assembling three projections and seven routes).

## Data and permissions

Reads session logs (read-only), the account balance (login first, API key second; the plugin never touches
tokens), the models.dev price table only for models the official table does not list, relay-published price
lists, subscription usage/quota APIs, and remembers the last balance in `localStorage`. No telemetry, no files
written.

## Licence

[Apache-2.0](LICENSE). See `NOTICE`: this project started as a fork of the Apache-2.0
[dsh-context](https://github.com/bowenliang123/dsh-context) and has since been rewritten as an independent
implementation.
