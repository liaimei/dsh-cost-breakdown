# History: from fork to rewrite

This repository started as a fork of [dsh-context](https://github.com/bowenliang123/dsh-context)
(Apache-2.0, taken after its v0.66.1) and used to carry that project's source verbatim, with this
plugin's token-and-cost features layered on top.

It has since been **rewritten from scratch**: a new module layout (`wire` / `core` / `host` /
`client`), a new fold engine, a new browser data layer and components, and a new test suite. The
fork relationship now survives only in two places:

1. **Provenance** — `NOTICE` records where the project came from and what was changed, as
   Apache-2.0 requires; upstream's own documents are kept in `.upstream-README.md` and
   `.upstream-AGENTS.md`.
2. **The behavioural contract** — projection keys, wire fields, routes, slots, settings field names
   and the package entry shape are preserved, because other software and existing user data depend on
   them.

See `docs/architecture.md` for the current design and `NOTICE` for the licence reasoning.
