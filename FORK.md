# Fork notes: dsh-context as the base

This repository is a **fork of [bowenliang123/dsh-context](https://github.com/bowenliang123/dsh-context)**,
taken at upstream commit `209169d` (the `main` line just after **v0.66.1**), with this
plugin's own token-and-cost features added on top.

## What the base gives us

`src/` is upstream dsh-context's source (124 files) and `tests/` matches it, so the
whole upstream suite runs here. That carries all of the context insight: composition,
trend, browser, events, file activity, agent network, the Insights page, the
`/context` command, and the per-session token and cost cards.

The source is upstream's code, not upstream's bytes: a documentation pass added
doc comments across the tree and wrote them in Chinese, so most files differ from
their upstream revisions by comments alone (see `NOTICE`). Code was verified
token-identical to upstream after that pass, so the behavioural claim above still
holds; only a rebase has to absorb the comment churn.

Comments are in Chinese by choice, not by inheritance: everything else in the
runtime (identifiers, wire names, locale namespace, user-facing strings) keeps
upstream's spelling, and `i18n.ts` still ships both `zh` and `en` dictionaries.

Eight upstream spec files carry small assertion updates for behaviour this fork
deliberately changes — the official price table superseding models.dev pricing,
holidays no longer billing at peak, five slots becoming six, and the two
`stateVersion` bumps. No assertion was weakened; each update encodes the new
intent (see `NOTICE`).

## What this fork adds

| Added here | Upstream |
|---|---|
| **Official CNY price table, peak/off-peak, Chinese public holidays** (`src/shared/officialRates.ts`) | models.dev USD book with a flat `PEAK_FACTOR = 2` and no holiday calendar |
| **Composer-dock readout** (`src/client/components/composerDock.tsx`, `src/client/dockReading.ts`) | no equivalent |

Both deltas are **additive**: they are new files plus small, localised edits to the
files that have to learn about them (`host/config.ts`, `host/foldMetering.ts`,
`host/activity.ts`, `host/fold.ts`, `host/timeline.ts`, `host/index.ts`,
`client/cost.ts`, `client/index.ts`, `client/i18n.ts`).

### Pricing, precisely

Upstream prices every bucket from the client's models.dev book and doubles a
DeepSeek `peak` bucket. This fork adds an **authoritative official CNY book**:

- `OFFICIAL_MODELS` carries each model's published CNY rates for both periods;
  off-peak is exactly half of peak in every column.
- `isPeakBeijing` decides the period from Beijing wall-clock windows
  (09:00–12:00 and 14:00–18:00, weekdays only) **minus the Chinese public
  holidays**, which bill off-peak all day like a weekend.
- The host resolves each settlement's period with this same table
  (`host/foldMetering.ts` `isPeakAt`), so the folded buckets carry the rate that
  was actually charged and a holiday really does bill at the off-peak rate.
- `client/cost.ts` prices official models from this table **first**, in both
  periods, and needs no registry book for them; every other model still prices
  from models.dev through the unchanged tiers.

`holidays` is a host config field. A value that yields no usable date falls back to
the built-in table rather than being read as "no holidays", because the latter would
bill every holiday at the peak rate and silently double those days.

## Licence (compliance)

Upstream is **Apache-2.0**. This fork keeps that licence:

- `LICENSE.apache` — the upstream Apache-2.0 text, unmodified.
- `NOTICE` — attribution and a statement of what was changed, as section 4 requires.
- `.upstream-README.md` / `.upstream-AGENTS.md` — upstream's own docs, kept for provenance.
- `README.md` documents this fork's behaviour.

Published artifacts stay Apache-2.0; the `LICENSE` file records that.

## Build

The build needs Node 24 or 26 with `--localstorage-file` for the client test
project, and the native `@rolldown/binding-darwin-arm64` package for `tsdown`.

```bash
pnpm install
pnpm run build          # tsdown -> lib/
pnpm exec vitest run    # the upstream suite + this fork's own specs
```

Two environment notes, both verified:

1. **The DSH-bundled Node cannot run `tsdown`.** macOS rejects rolldown's native
   `.node` binary inside it (`different Team IDs` — a code-signing mismatch with
   the app's signature). Use a normal Node (`/opt/homebrew/bin/node`) to build.
   Running the built plugin is unaffected.
2. **Node 26 shadows jsdom's `localStorage`** with its own, which is `undefined`
   unless `--localstorage-file` is given. Without it, ten client specs fail on
   `globalThis.localStorage` — upstream fails identically, so this is a Node/verify
   interaction, not a fork defect. Run: `NODE_OPTIONS=--localstorage-file=/tmp/ls.db`.

## Workflow

Upstream moves fast (0.65 -> 0.66 in days). Keep this fork's changes **small and
localised** so rebasing stays cheap:

- Prefer adding files over editing upstream ones.
- Where an upstream file must change, keep the edit to the smallest diff and note
  it in `NOTICE`.
