---
kind: milestone
status: draft
tests:
  - test/unit/nuxt-app-is-refused-or-reaches-the-first-measurement.test.ts
---

# M123: A Nuxt app is refused, or reaches the first measurement

## Purpose

Neither Nuxt app in the run-6 corpus reached a measurement, and neither said why. A Nuxt project
whose generated `.nuxt/` directory does not hold the files its own tsconfig names is refused before
the browser, with the same text in the dry run, carrying the `nuxi prepare` remedy 120fps already
owns. A readiness timeout that captured no page error at all names the stylesheet the run injected
into the harness entry and the two commands that decide whether it is the cause.

Closes: run-6 smoke cluster 4 (nocodb `packages/nc-gui`, nuxt.com). Evidence:
`C:\Projekte\120fps-fieldtest\smoke\run6-smoke1\FINDINGS.md` cluster 4,
`smoke/run6-smoke1/logs/{nocodb,nuxt.com}/real.log`, `smoke/run6-solo1/logs/nuxt.com/real.log`.

## Root causes (verified)

1. **nocodb: the tsconfig names a file `nuxi prepare` never wrote.**
   `E:/repositories-run6/nocodb/packages/nc-gui/tsconfig.json:2` is `"extends": "./.nuxt/tsconfig.json"`.
   `.nuxt/` exists (`app.config.mjs`, `components.d.ts`, `fetch.d.ts`, `imports.d.ts`, `types/`) and
   holds no `tsconfig.json`: the repository's install script failed before `nuxi prepare` finished
   (`FINDINGS.md`, "Environment facts"). 120fps reads the breakage at preflight — `warnTsconfigOnce`
   (`src/project/compiler-options.ts:12`), fed by `resolveGoverningTsconfig`'s
   `TSCONFIG_EXTENDS_BROKEN_WARNING` (`src/project/model.ts:355-357`) — prints
   `Warning: problem reading tsconfig at …: Cannot read file '….nuxt/tsconfig.json'.` and continues.
   Vite's esbuild then reads the same file for the harness entry and answers 500:
   `failed to resolve "extends":"./.nuxt/tsconfig.json"`, reported as a generic readiness timeout.
   The existing Nuxt diagnosis (`src/harness/bundler-failure.ts:188-217`) cannot fire: it matches
   `Missing "#build" specifier in "<pkg>" package` only.
2. **nuxt.com is not a `nuxi prepare` case at all.** Its `.nuxt/` is complete: 32 entries including
   `tsconfig.json` (31,765 bytes), `components.d.ts`, `imports.d.ts`, `nuxt.d.ts`. Its root
   `tsconfig.json` is a solution file (`"files": []` and four `references` into `.nuxt/`), all four
   present.
3. **nuxt.com stalls on the stylesheet the run injected.** Isolated by experiment on the run-6 CLI
   built from this worktree: the run as smoke made it is
   `exit=2 killed=false seconds=39` / `component harness did not become ready within timeout. No page errors were captured.`;
   the same command with `--no-css` is `exit=2 killed=false seconds=7` and reaches
   `calibration → mode: curve on items → mount: 6 scale points` before failing on a component fact
   (`TypeError: Cannot destructure property 'item' of 'undefined'` at `Carousel.vue:7`, the
   auto-imported `UCarousel` that does not resolve); the same command with
   `--css app/assets/css/twoslash.css` takes the same fast path. The injected sheet was
   `app/assets/css/main.css`, picked by the largest-stylesheet fallback ("low confidence"), a
   Tailwind 4 entry: `@import "tailwindcss"; @import "@nuxt/ui"; @import "./twoslash.css";`
   `@source "../../../content/**/*"; @source "../../../node_modules/.c12"`. `cssImportBlock` puts it
   as the first import of the generated entry (`src/harness/entry.ts:287` for Vue, `:389`/`:463` for
   React), so its compile blocks the whole module graph: nothing evaluates, nothing throws, and the
   readiness wait expires with an empty page-error capture.

## MUST

- A project that declares `nuxt` or ships a `nuxt.config.*`, and whose own tsconfig chain names a
  file under `.nuxt/` that is not on disk, is a hard preflight refusal before the browser, identical
  in the dry run. The message names the config that names it, the missing file, and carries the
  `nuxi prepare` remedy.
- A project whose `.nuxt/` holds every file its tsconfig names is not refused: nuxt.com must still
  reach the browser.
- A readiness failure that captured no page error, in a run that injected a stylesheet, keeps
  everything the readiness wait already reports and adds: the stylesheet is the entry's first import,
  a stylesheet that compiles slowly or not at all holds the entry module without raising a page
  error, and `--no-css` and `--css <file>` decide whether it is the cause here.
- That addition is a ranked suspect, never a verdict, and stays true beside lane A's compile probe
  (M121): a sheet the probe cleared can still be slow in the browser, and an explicitly named `--css`
  sheet is never dropped.

## MUST NOT

- Refuse a Nuxt project on `.nuxt/` alone: without a config that names a missing file inside it,
  nothing here proves the build fails.
- Print the stylesheet note for a readiness failure that did carry page errors, or for a run that
  injected no stylesheet (`--no-css`, "none found", a sheet dropped after a read failure).
- State that the stylesheet is the cause.
- Print `nuxi prepare` for a repository that does not declare `nuxt` (M108 A2).

## Verification

Tests, `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`.

`test/unit/nuxt-app-is-refused-or-reaches-the-first-measurement.test.ts` with M122's file:
`Test Files 2 passed (2)`, `Tests 32 passed (32)`.

Whole suite and its six worktree-install failures: recorded in M122's Verification, which this
milestone shares.

`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`: clean, no output.

Corpus, `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cli
C:/Projekte/120fps-fieldtest/scratch/lane-b/dist/cli/main.js`, one run at a time.

- nocodb, `--cwd E:/repositories-run6/nocodb/packages/nc-gui -- components/nc/Divider.vue`.
  before (`smoke/run6-smoke1/logs/nocodb/real.log:4,9`):
  `Error: component harness did not become ready within timeout. Page errors:` /
  `failed to resolve "extends":"./.nuxt/tsconfig.json" in E:\repositories-run6\nocodb\packages\nc-gui\tsconfig.json`,
  after 30 s in a browser.
  after, dry run (`--explain-props`, label `m123-dry`): `exit=2 killed=false seconds=2`

      Warning: problem reading tsconfig at E:/repositories-run6/nocodb/packages/nc-gui/tsconfig.json: Cannot read file 'E:/repositories-run6/nocodb/packages/nc-gui/.nuxt/tsconfig.json'.
      Error: Cannot measure this component in a browser: components/nc/Divider.vue is measured in a Nuxt project that `nuxi prepare` has not finished: tsconfig.json names .nuxt/tsconfig.json, which is not on disk.
        components/nc/Divider.vue
      Vite's esbuild reads that config for every file it transforms, so the dev server would answer 500 on the harness entry before this component is measured.
      Run `nuxi prepare` in this project, then measure again. Pass --no-preflight to attempt the run anyway.

  after, real run (`--samples 3 --max-combos 2 --explore-budget 30 --no-deltas`, label `m123-real`):
  `exit=2 killed=false seconds=2`, and the text from `Error:` to the end of the message is identical
  to the dry run's, compared string-for-string. No browser starts in either mode.
- nuxt.com, `--cwd E:/repositories-run6/nuxt.com -- app/components/content/Carousel.vue`.
  Its `.nuxt/` holds every file its tsconfig references, so it is not refused: the dry run
  (label `m123-dry`) is `exit=0 killed=false seconds=4` and prints
  `Stylesheets: app/assets/css/main.css (largest-stylesheet fallback, low confidence — verify with --css)`
  with no `nuxt-not-prepared` refusal, and the real run reaches the browser.
  after, real run (label `m123-real`): `exit=2 killed=false seconds=33`

      Error: component harness did not become ready within timeout. No page errors were captured.
      The first import of the generated harness entry is the stylesheet this run injected: app/assets/css/main.css. A stylesheet that compiles slowly, or not at all, holds that entry module without raising a page error, which is the shape of this failure. Re-run with --no-css to take it out of the graph, or with --css <file> to name a smaller one: if the harness becomes ready then, that stylesheet is what held it.

  This arrives on the navigation half of the wait (`gotoWithErrorContext`,
  `src/pipeline/analyze.ts:475`), which carries no readiness note of its own, so the addition
  displaces nothing M125 prints.
  after, the same command with `--no-css` (label `m123-nocss`): `exit=2 killed=false seconds=5`,
  `Stylesheets: none (--no-css)`, no stylesheet note, and the run reaches
  `calibration  (0:01)` / `mode: curve on items  (0:03)` / `mount: 6 scale points  (0:03)` before

      Error: mount phase failed on combo 0 of Carousel.vue: page.evaluate: TypeError: Cannot destructure property 'item' of 'undefined' as it is undefined.

  at `app/components/content/Carousel.vue:7` — the deferred auto-import failure, not this
  milestone's. 33 s to a mute timeout against 5 s to a mount is the experiment the message asks the
  reader to run, and it decides the suspect here.
- Unaffected control: shadcn-admin, `--cwd E:/repositories-run5/shadcn-admin --
  src/components/ui/label.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas`
  (label `m122-m123-control`): `exit=0 killed=false seconds=66`, `Result: PASS`.

## Deferred

- A Nuxt project with no tsconfig naming anything under `.nuxt/`: nothing on disk then proves the
  build fails, and such a component may well measure.
- nuxt.com's remaining failure with `--no-css`: `UCarousel` and `ProseImg` are Nuxt auto-imported
  components that resolve to nothing in the harness, so the synthesized `items` array reaches a
  slot that never renders. Nuxt auto-import resolution is its own milestone.
- Running `nuxi prepare` on the user's behalf: 120fps never writes into the measured repository
  beyond its own harness directory.
- Measuring how long the injected stylesheet actually took: that instrument belongs with lane A's
  compile probe (M121), which times the transform before the page opens.
