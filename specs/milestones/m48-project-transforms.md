---
kind: milestone
status: implemented
tests:
  - test/unit/m48-project-transforms.test.ts
  - test/e2e/m48-transform-passthrough.test.ts
---

# M48 — load-bearing project transforms

## Purpose

The harness never loads the project's `vite.config` — deliberately (M30: its
plugins target its own Vite major; its server options are not
measurement-safe). The cost: components whose *compilation* depends on project
plugins fail to build, or build unstyled, with errors that surface deep inside
the run and never name the missing transform. "Zero config by ignoring your
config" is the right architecture and was the wrong error experience.

## Contract

### Diagnosis

- `TRANSFORM_RECOGNIZERS` maps import shapes to the plugin family that owns
  them: SVGR (`.svg?react`), vanilla-extract, GraphQL, MDX, CSS preprocessors,
  Vue, Svelte. Each carries a stable `code`, emitted as `[transform:<code>]` in
  every message.
- Recognition rides M42's preflight walk (`PreflightResult.transforms`) and is
  never fatal.
- A recognizer receives the importing file, not only the specifier: some
  transforms are invisible from the specifier alone — vanilla-extract is
  imported as `./styles.css` while the file on disk is `styles.css.ts`.
- `PROJECT_TRANSFORM_WARNING` is emitted **only for transforms the harness will
  not apply**. Warning about one that loaded successfully is crying wolf.
- `transformFailureNote` is appended to whatever error ends the run: Vite's own
  error never mentions the plugin.

### Passthrough

- `SUPPORTED_TRANSFORM_PLUGINS` is a curated list, each entry an explicit tested
  integration following the M27 React Compiler pattern: detect in the project's
  manifest → resolve from the *project's* `node_modules` via `createRequire` →
  call the factory → append to the harness Vite config after the Tailwind and
  React Compiler entries.
- Server and HMR hooks are stripped (`configureServer`, `configurePreviewServer`,
  `handleHotUpdate`, `hotUpdate`). The harness owns its server's lifecycle, and
  a project plugin reaching into it is the failure class M30 documented.
  Build-time hooks — resolve/load/transform — are the point.
- Load failure warns (`TRANSFORM_LOAD_FAILED_WARNING`) and continues. A
  component that does not touch the transform still measures, and one that does
  gets the recognizer diagnosis anyway.
- Active transforms join the M39 fingerprint config: a transform changes the
  code that gets measured, exactly as the React Compiler does, so it belongs in
  the identity of a cached verdict. `Report.projectTransforms` records them.
- `--no-transforms` measures without them.
- MUST NOT: load the project's `vite.config` wholesale (re-litigated, still
  rejected).

## The spike, and what it decided

The draft deferred the passthrough pending a spike, naming vanilla-extract as
the doubtful case ("nontrivial dev-server integration; it may be unsupportable
without its server hooks"). A real workspace fixture
(`fixtures/transform-project`) was built with both plugins actually installed,
and both were driven end to end in a browser.

**Result: both work with server hooks stripped.** SVGR compiles `.svg?react`
into a mounted `<svg>` element; vanilla-extract compiles `styles.css.ts` and the
computed style arrives in the page. Hook-stripping is sufficient isolation for
both, so both ship.

The spike also caught a defect that would otherwise have been misread as
"vanilla-extract is unsupportable": the naive `mod.default ?? mod` factory
resolution fails for both packages. Real export shapes in the wild:

| package | shape |
|---|---|
| `vite-plugin-svgr` | CJS interop double-wrap — the factory is `mod.default.default` |
| `@vanilla-extract/vite-plugin` | no default at all — named export `vanillaExtractPlugin` |

`resolvePluginFactory(mod, exportName?)` handles all three shapes (real default,
double-wrapped default, named export). Without it the first spike run reported
both plugins as unloadable, which looked exactly like the isolation failure the
draft predicted. Measuring the cause rather than accepting the symptom is what
separated the two.

## Hardening

| # | Hypothesis | Result |
|---|---|---|
| H1 | Detection reads the wrong manifest or throws on a missing one | Pass — returns empty |
| H2 | Stripping removes hooks the transform needs | Pass — both plugins compile without them |
| H3 | A stripped plugin still reaches the harness server | Pass — all four hooks removed |
| H4 | A plugin with no server hooks is mangled | Pass — untouched |
| H5 | An unloadable plugin aborts the run | Pass — warns and continues |
| H6 | A loaded transform still warns as unsupported | Pass — filtered out of the warning set |
| H7 | `--no-transforms` silently still loads them | Pass — component fails visibly instead |

## Deferred

- Transforms beyond the two spiked. The `[transform:<code>]` codes exist so the
  real distribution decides the order, rather than the list being guessed.
- Whether a loaded transform should also key the M38 server pool. Today the pool
  keys on projectRoot and config, and transforms are a deterministic function of
  the project, so two components of one sweep always agree — but a future
  per-component override would need the key extended.
- `--vite-plugin <name>` for arbitrary user-named plugins.
- Detecting unstyled-but-mounting cases (Emotion without its babel plugin still
  renders, styled differently).
