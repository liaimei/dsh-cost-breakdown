# Architecture

The plugin is one package with two halves that never share a module instance: a Cordis **host** half
loaded as an ESM module by the harness, and a **browser** half loaded through
`window.__ModuleLoader__.load({ id, factory })`. The JSON between them is a contract; everything
inside either half is free to change.

## Layers

```
wire/    the contract: payload types, zod schemas, projection-key augmentation
core/    pure domain maths shared by both halves (no node:, no DOM)
host/    Cordis plugin: fold engine, projections, HTTP channels, platform adapters, settings
client/  browser half: shell adapters, data layer, i18n, UI
```

Dependencies point downward only: `client → wire, core`, `host → wire, core`, `core → wire`,
`wire → nothing but the harness's type declarations`. `core` stays environment-free so both halves
(and vitest, in either environment) can load it.

## Host half

- **`fold/`** folds the durable session log into the timeline state. `state.ts` owns the persisted
  shape and retention; `reducer.ts` dispatches per-event handlers against a lazily cloned draft;
  `surface.ts`, `records.ts`, `timing.ts`, `metering.ts` and `streams.ts` hold the sub-rules;
  `wire.ts` builds the served value.
- **`projections/`** registers three units: `contextTimeline` (29), `contextHeaders` (1),
  `contextActivity` (6). The timeline unit serves a slim head while the detail route is live and a
  fully inline value when it is not; `degraded.ts` serves the below-baseline fallbacks.
- **`http/`** arms the five POST routes behind the harness `/api` fence, plus the heap-pressure
  cold-read gate shared by the detail route and the backfill sweep.
- **`platform/`** holds the runtime-adapter seams: harness version probe, tool attribution, step-id
  guard, account balance, workbuddy catalogue rates.

Two rules are load-bearing at every fold site: an uninterested event returns the **same reference**
(the registry decides what to publish with `Object.is`), and the whole event is folded inside one
try/catch so a malformed log cannot stall the unit. Persisted state must be plain JSON — optional
fields are **absent**, never `undefined`, or every cache write for that session fails.

## Browser half

- **`shell/`** re-validates every value crossing the harness boundary and exposes typed faces for the
  services the bundle consumes. Only `slots` and `locale` are hard injects; everything else is
  deferred or checked at the call site.
- **`data/`** holds the money maths (`cost.ts`), per-platform split (`platformSpend.ts`), the
  two-generation timeline reconciliation (`timeline.ts`), the price book, balances/credits and the
  cross-session aggregation used by the statistics page.
- **`ui/`** renders the surfaces: the composer-row readout and its card, the conversation context
  view and modal, the Insights page, the settings card, the per-turn pill and the chat→context jump.
- **`i18n/`** carries the zh/en dictionaries (zh is the key-set source of truth) and the pure
  formatting helpers.

## Invariants worth stating

1. **Tokens on the wire, money in the browser.** The host writes billed token ledgers; every currency
   figure is computed client-side from them.
2. **Never render `0` where the truth is "unknown".** A dash, an explicit "no rate configured" label,
   or an omitted row — a zero claims a measurement that was never made.
3. **Units are never summed across currencies.** Each platform is a row in its own unit.
4. **USD is the accounting unit**, with a fixed CNY conversion; display currency is formatting only.
5. **The peak/off-peak split is decided by model**, so a proxied official model still bills by the
   Beijing windows.
