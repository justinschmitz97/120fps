---
kind: milestone
status: implemented
tests:
  - test/unit/m62-shim-usage-reporting.test.ts
  - test/unit/m62-shim-usage-harden.test.ts
  - test/e2e/shim-detect.test.ts
---

# M62 — Next.js shim-usage reporting is dead; fix it

## Purpose

`activeShims` / `report.nextJsShims` was always `undefined`, for every
project, unconditionally (traced during dogfooding, DOGFOOD-2026-08-18.md P1
§4). Root cause in `scanExternalDeps`/`resolveLocalImport` (src/harness.ts):
the shim-redirect alias (`^next/image$` → `shims/next-image.js`) is registered
before the external-dep scan, so `resolveLocalImport(file, "next/image", ...)`
matches the alias, returns the shim file's real path, and the import is
treated as **local** — it is queued for walking and never reaches the branch
that records the specifier. `SHIM_MODULES.filter(s =>
importedSpecifiers.has(s.module))` is therefore always empty. The shims
themselves still work (`next/image` renders fine); only the usage report was
dead. Downstream plumbing (`Report.nextJsShims`, `buildReport`, the
`formatTable` "Next.js shims: …" line) was already correct and unused — this
milestone wires the one missing link.

## Contract

- MUST: when a scanned file imports a specifier that resolves through a shim
  alias (`SHIM_MODULES`), that specifier MUST still be recorded as "imported"
  even though it also resolves to a local file (the shim). `activeShims`
  (harness.ts) and `report.nextJsShims` MUST be populated whenever the scanned
  graph imports one or more shim modules and shims are active.
- MUST: the shim redirect itself keeps working — the specifier still resolves
  to the shim file and gets queued for walking (so the shim's own deps, e.g.
  `react`, are still discovered).
- MUST NOT: change resolution behavior for non-shim aliases (tsconfig
  `paths`). A specifier that resolves via a tsconfig alias MUST NOT be added
  to the shim-usage set, whether or not its text happens to collide with a
  `SHIM_MODULES` entry (a project's own `next/image` tsconfig alias shadows
  the shim per M19 — reporting must reflect that the shim was never reached).
- MUST NOT: change `externalPkgs` (the `scanExternalDeps` return value used
  for `optimizeDeps.include`) — a shim-redirected specifier resolves locally
  and MUST NOT be pushed into the external-package set.
- Report surfacing (JSON field name, terminal line, ordering) is unchanged —
  this is a plumbing fix, not a new feature (see m19-nextjs-shim.md).

## Design

- `resolveLocalImport` gained a third bit of information: not just *whether*
  a bare specifier resolved locally, but *whether the alias that matched it
  was a shim alias*. `buildShimAliases` tags its entries `isShim: true`;
  tsconfig aliases (`loadTsconfigAliases`) carry no such tag, so they leave
  `viaShimAlias: false` on a match. Alias precedence is unchanged — the first
  alias in the combined list (`[...tsconfigAliases, ...shimAliases]`) whose
  `find` matches still wins, so a user's own `next/image` tsconfig alias
  still shadows the shim exactly as M19 specifies; it just also now correctly
  reports as *not* a shim hit.
- `scanExternalDeps` now decides whether to add a bare specifier to
  `specifiersOut` at the point of resolution, not only in the "nothing
  resolved" branch: unresolved bare specifiers are recorded as before, and a
  bare specifier resolved via a shim alias is *additionally* recorded. A bare
  specifier resolved via a non-shim alias (tsconfig paths, or no alias table
  at all if none configured) is still never recorded — matching prior
  behavior for that path exactly.
- `specifiersOut` remains scoped to bare (non-relative) specifiers only,
  matching its existing use as the raw-import-text source for the
  `SHIM_MODULES ∩ importedSpecifiers` intersection in `buildAndServe`; that
  intersection logic in `buildAndServe` is unchanged.

## Notes

- The pre-existing e2e coverage (`test/e2e/shim-detect.test.ts`) passed
  before this fix for the wrong reason: under `vitest`, `harness.ts` runs as
  transformed TS source, so `buildShimAliases`'s `import.meta.dirname`
  resolves to `src/shims/`, which holds only `.ts` files — the shim alias
  target never exists as a file, `resolveLocalImport` fails to resolve it
  locally, and the specifier falls through to the ordinary
  external-specifier branch that already worked. Against the real build
  (`dist/shims/*.js`, which is what `npx 120fps` actually runs), the target
  *does* exist, `resolveLocalImport` succeeds, and the bug reproduces exactly
  as dogfooded. `test/unit/m62-shim-usage-reporting.test.ts` reproduces the
  bug directly against `scanExternalDeps` with a synthetic alias pointing at
  a real file, independent of this src/dist quirk. A new block in
  `test/e2e/shim-detect.test.ts` additionally exercises the compiled
  `dist/harness.js` so the accidental-pass gap cannot reopen silently.
