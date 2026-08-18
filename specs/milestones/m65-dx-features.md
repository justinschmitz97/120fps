---
kind: milestone
status: implemented
tests:
  - test/unit/m65-dx-features.test.ts
  - test/unit/m65-dx-harden.test.ts
  - test/e2e/m65-named-export.test.ts
---

# M65 — DX features

## Purpose

Five gaps that every dogfooding worker hit independently. None of them changes a
measurement; all of them change whether the measurement can be trusted, aimed,
or waited for.

- **No way to see what will be measured.** The M58 mis-binding class went
  unnoticed for six components because resolving props required a full run.
- **No output during a run.** A six-minute silent wall is indistinguishable from
  the tracing hang of P1 §5, and nothing states how long a run took.
- **Provider throws look like a component bug.** A component that needs
  `NextIntlClientProvider` crashes with a raw page error and no idea that the
  import graph already said so.
- **One export per file is reachable.** `KbdCombo` cannot be measured when
  `Kbd` is what the resolver picks.
- **Two resolvers disagree on the stem rule.** M58 normalized the file stem;
  `detectComponentExport` did not, so a file with several exports and a
  separator in its name renders one component while the schema describes
  another.

## Contract

### C1 — `--explain-props` (dry run)

- `120fps <component> --explain-props` MUST resolve and print, and MUST NOT
  start Vite, launch a browser, or write any file. Exit code 0 on success, 2
  when the component path cannot be resolved.
- The output MUST name: the resolved component, the declaration it bound to as
  `file:line`, the file's component exports, every extracted prop with kind,
  required flag and value pool, each degenerate prop with M60's reason, which
  prop would drive curve mode (with `detectScalingProps`' reason) or that none
  would, whether matrix mode would auto-activate, and every extraction warning
  the same run would have printed.
- `<stem>.props.tsx` presets MUST be applied before printing: the pool shown is
  the pool that would be measured.
- `.vue` and `.tsx`/`.jsx` MUST both work. A Vue SFC has one component and no
  declaration to point at, so it reports the SFC-derived name with no binding
  line.
- A file with no component export MUST still print, naming the filename-derived
  fallback and an empty export list.
- `--explain-props` MUST take precedence over every mode flag: `--json`,
  `--ci`, `--curve`, `--matrix`, `--isolate` change nothing about it and no
  report file is written.
- With several component paths, each is explained in turn under its own header.

### C2 — progress heartbeat

- A run MUST print one-line progress markers at pipeline phase boundaries on
  stdout: preflight, harness build, the mode it resolved to, each measurement
  pass (mount, rerender, explore, prop deltas, scaling curves, react analysis),
  and the report write.
- Markers MUST carry the unit of work when the phase has one (`mount: 8 combos`,
  `explore: 6 combos, budget 60s`).
- Markers MUST be suppressed in `--ci` mode, whose contract (M22) is JSON only.
- No spinner, no ANSI control sequences, no timer, no interval: every marker is
  emitted from a natural point in the pipeline, so a suite that drives the
  pipeline deterministically stays deterministic.
- The reporter is a function on `AnalyzeOptions` (`onProgress`), defaulted to a
  stdout writer by the CLI, so a programmatic caller can capture or silence it.

### C3 — total wall clock

- Every terminal report MUST be followed by `Total: <duration>` measured across
  that component's `analyze` call: `Total: 4m 12s` at or above a minute,
  `Total: 42.1s` below one.
- Suppressed in `--ci` mode with the rest of the terminal output.
- The formatter is pure (`formatWallClock(ms)`); only the CLI reads a clock.

### C4 — provider-hook detection

- The preflight import-graph walk MUST additionally record provider-dependent
  imports as `PreflightResult.providers`:
  - a package import matching a known provider library — `next-intl`,
    `react-i18next`, `react-redux`, `@tanstack/react-query` — including
    sub-path specifiers (`next-intl/client`);
  - a *local* imported module whose source contains `createContext(` and a
    `throw new Error`, which is the shape of a context hook that refuses to run
    outside its provider. The hook name is read with a regex when one is
    exported; no type checking, no resolution beyond the walk the preflight
    already does.
- Detection alone MUST NOT warn, fail, or appear in the report. A healthy run's
  output is byte-identical to what it was without this milestone.
- When M59's render-health gate marks any combo `"error"` (or curve mode's
  equivalent run warning fires), the report MUST carry
  `providerCandidates: string[]` and the `renderError` hint MUST name them:
  `component imports next-intl (useTranslations) — likely needs a provider
  wrapper; see --wrap / 120fps.setup.tsx`.

### C5 — named-export targeting

- The component argument accepts `<file>#ExportName`. The harness imports that
  export, M58's prop resolver binds to it, and the report names it.
- The split is decided without touching the filesystem: only a final `#`
  followed by a JavaScript identifier, on a left side that already ends in an
  accepted component extension, is a target separator. `C:\p\c#1\B.tsx`,
  `C:\p\B#2.tsx` and any path whose `#` fragment is not an identifier stay
  whole paths.
- An export that does not exist MUST fail before any harness is built, naming
  the file and listing the file's component exports (or stating it has none).
  Exit code 2.
- An explicit target disables auto-composition: the user named the one export
  to render.
- `--fixture` owns its own scene, so `#Export` combined with it is a usage
  error.
- The programmatic entry point takes the same value as `AnalyzeOptions.target`.

### C6 — one stem rule

- `detectComponentExport` MUST compare the file stem to export names after
  dropping non-alphanumerics and lowercasing both sides, the normalization M58
  introduced. `hotspot-image.tsx` resolves to `HotspotImage`, not to the first
  export declared above it.
- M58's H19, which asserted the divergence, is replaced by its inverse.

### MUST NOT

- No behavior change for an invocation that uses none of the new flags or the
  `#` syntax: same measurements, same report shape, same exit codes.
- No new dependency, no new browser pass, no change to any timeout.

## Design

**Why explain lives beside the pipeline.** `explainProps` reuses `analyze`'s own
resolution order — project root, framework, preset detection, extraction,
`detectScalingProps`, `shouldAutoActivateMatrix` — so the dry run and the real
run cannot disagree. It stops before the first side effect: no harness
directory, no dev server, no browser.

**Why extraction grew a detailed form.** `extractProps` returns schemas and
writes warnings to stderr through a once-per-process dedupe. Explain needs the
target's name and source position, and needs the warnings as data. Both come
from `extractPropsDetailed`, which takes an optional `onWarning` sink;
`extractProps` is the thin wrapper that keeps the stderr behavior. The sink is
a parameter rather than module state, so nothing about test ordering can change
what a run prints.

**Why the target is a parse-level split.** Doing it in `parseArgs` keeps the CLI
pure and testable on Windows path shapes without a filesystem. The identifier
plus extension rule is what makes it safe: an identifier cannot contain `.` or
a separator, so no real path fragment can be mistaken for an export name.

**Why provider candidates ride on the report.** The hint is printed from the
report alone (`formatTable`), long after preflight ran, so the candidates have
to be in the report to be nameable. They are attached only when a render error
actually happened, which is what keeps a healthy run's JSON unchanged.

**Why the heartbeat has no timer.** A timer would make output depend on wall
clock, which makes a test flaky and a CI log non-reproducible. Phase boundaries
are where a run can stall for minutes, so they are where the information is.

## Notes

- Explain prints the value pool truncated to four entries per prop; the pool is
  a sample of what would be measured, not the combination space.
- `providerCandidates` is a display list, not a diagnosis: a component can fail
  to render for reasons unrelated to any of the named packages.
- Curve mode's per-scale-point render errors set `providerCandidates` through
  the same run-warning path the combo gate uses.
