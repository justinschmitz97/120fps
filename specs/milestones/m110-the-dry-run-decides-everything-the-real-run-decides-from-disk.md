---
kind: milestone
status: draft
tests:
  # Lane C
  - test/unit/dry-run-predicts-the-composed-scene.test.ts
  - test/unit/requested-matrix-names-what-took-precedence.test.ts
  - test/unit/dry-run-prints-project-transform-warnings.test.ts
  - test/unit/dry-run-names-the-unresolved-prebundle-entry.test.ts
  # Lane A
  - test/unit/prebundle-entry-that-resolves-to-nothing-warns.test.ts
  - test/unit/import-clause-across-lines-is-scanned.test.ts
  - test/unit/data-file-import-names-its-loader-plugin.test.ts
  - test/unit/project-transform-hits-are-classified-once.test.ts
---

# M110: The dry run decides everything the real run decides from disk

Lanes C (`src/analyze.ts`) and A (`src/harness.ts`, `src/preflight.ts`), per
`specs/milestones/M107-M117-MAP.md`.

## Purpose

`--explain-props` is the cheap prediction a user runs before paying for a real run. On four run-5
components it predicted a mode the real run did not take, and stayed silent about warnings the real
run printed one minute later from the same files on disk. After this milestone the dry run names the
composition decision, the mode the dispatcher would pick, every project-transform warning and every
pre-bundle entry that resolves to nothing, in the same words the real run uses.

Closes: epic-stack-F2 (major), logto-F3 (major), supabase-F3 (major), calcom-R1 (major).

Run-5 evidence: `C:\Projekte\120fps-fieldtest\EVIDENCE.md` rows for those four ids;
`verify/epic-stack.md:42-60`, `verify/logto.md:68-100`, `verify/supabase.md:40-80`,
`verify/regression-calcom.md:6-45`; logs `logs/epic-stack/ep3-dropdown-dry.log` and
`ep7-dropdown-real.log`, `logs/logto/explain-confirmmodal.log:27-34` against
`logs/logto/real-confirmmodal.log:26-38`, `logs/supabase/explain-popover.log` against
`logs/supabase/real-popover.log:36`, `logs/regression-calcom/popover-matrix.log:4` against
`logs/regression-calcom/popover-explain.log`; cluster brief
`C:\Projekte\120fps-fieldtest\remediation\cluster-briefs.md:89-114` (G4).

## Root causes (verified)

Line numbers are this worktree (`C:\Projekte\120fps-m107`). They match the map except for the real
run's transform site: the map and `verify/logto.md` cite `src/analyze.ts:3177-3184`; the code sits at
`:3338-3358` here (`grep -n classifyPreprocessorAvailability src/analyze.ts` -> `:3351`).

1. **supabase-F3, calcom-R1 (mode prediction).** The dispatcher gates matrix on
   `src/analyze.ts:3675` `matrixEligible = options.matrixMode !== false && !useFixture && !composed`,
   with `composed = compositionTree !== undefined` (`:3548`). The dry run passes
   `matrixEligible: options.matrixMode !== false && !dryRunUsesFixture` (`:2513`), hard-coding
   `composed = false` on the rationale at `:2443` and `:2496-2501` that composition needs a browser.
   The verifier disproved that rationale: composition comes from `extractExports` plus
   `extractAllProps` plus `inferComposition` (`:3004-3009`), and `inferComposition`
   (`src/composition.ts:133-169`) reads export names and schemas only. `explainProps` already calls
   `extractExports` at `:2437-2439` and already holds `schemas`.
2. **calcom-R1 (silent drop).** An explicit `--matrix` lost to an auto-composed scene prints nothing:
   the curve branch warns through `MATRIX_SUPPRESSED_BY_CURVE_WARNING` (`:240-242`, pushed `:3668`)
   and the compose and fixture branches fall through to `progress("mode: prop combos")` (`:3700`)
   with no analogue. `NO_PROPS_MEASURED_WARNING` (`:3817-3820`) discloses the empty props, prints the
   same text without `--matrix`, and carries no signal about the dropped flag.
3. **logto-F3 (transforms).** `explainProps` calls `runPreflight` at `:2375` and consumes only
   `preflight.soft` (`:2380`) and `preflight.hard` (`:2381-2383`). `preflight.transforms` comes back
   from the same call (`src/preflight.ts:594`, returned `:671`) and is read on the run path only,
   where `src/analyze.ts:3338-3358` filters it against `detectProjectTransforms` and
   `classifyPreprocessorAvailability` (`src/preflight.ts:823`) and pushes `PROJECT_TRANSFORM_WARNING`
   (`src/preflight.ts:842`). Both inputs are an import walk plus a package probe.
4. **epic-stack-F2 (pre-bundle entry).** `scanExternalDeps`'s last loop (`src/harness.ts:4226-4228`)
   reads `installedPackageDir(pkg, projectRoot)` and `continue`s when it returns `undefined`, so
   `#app` stays in the returned `optimizeDeps.include` list with no warning in either mode. Both
   modes read that scan through `collectStaticPreBuildWarnings` (`src/harness.ts:3222`, called by the
   dry run at `src/analyze.ts:2362` and by `buildAndServe` at `src/harness.ts:3453`), so the silence
   is the only reason the dry run said nothing while the real run died at browser boot.
5. **Footer.** `DRY_RUN_RUNTIME_ONLY_NOTE` (`src/analyze.ts:1046-1050`) names three runtime-only
   classes and never names auto-composition, so the compensating disclosure root cause 1's rationale
   leans on was never printed.

## MUST

### Lane C (`src/analyze.ts`)

- **C1** `explainProps` decides auto-composition from the filesystem with the dispatcher's own gate
  (`:3004`: no fixture, no `--target`, not `--no-auto-compose`, not a Vue file, more than one export,
  `inferComposition` returns a tree) and prints one line before the mode lines:
  `Composition:  would auto-compose from <Root> (<n> exports)`, or
  `Composition:  would measure <Name> alone` when no tree is inferred.
  `Matrix mode:  would auto-activate` prints only for a component the dispatcher sends to matrix; for
  a component the dispatcher composes it never prints, in any flag combination.
- **C2** `matrixIneligibleReason` (`:2242`) gains `"composed"`, and the dry run prints
  `Matrix mode:  predicate matches, but an auto-composed scene supplies the props, so this run would
  measure that scene's single combo`, naming the composed root. `"composed"` is reported only when
  the matrix predicate would otherwise activate or `--matrix` was passed, and it loses to
  `"no-matrix-flag"` and `"fixture"` in that order.
- **C3** An explicit `--matrix` the dispatcher does not honour prints one warning naming what took
  precedence, the composed root or the fixture file, in the real run and in the dry run, with the
  same wording the curve suppressor already uses. A run that never asked for `--matrix` prints no
  such warning.
- **C4** The dry run pushes the project-transform warnings the real run pushes for the same
  filesystem inputs: the same hits, the same `PROJECT_TRANSFORM_WARNING` text, the same availability
  classification, the same order, through the one classifier lane A exports (I3). `--no-transforms`
  suppresses them in both modes identically.

### Lane A (`src/harness.ts`, `src/preflight.ts`)

- **A1** An `optimizeDeps.include` candidate that resolves to no installed directory, no alias and no
  `imports` entry is dropped from the returned include list and reported once, naming the specifier,
  the file that imported it and the consequence (the pre-bundle cannot include it, so the browser
  resolves it or fails on it). Because both modes read the same scan, the line appears in
  `--explain-props` and in the real run with identical text.
- **A2** `StaticPreBuild` (`src/harness.ts:590-606`) publishes the unresolved set (I2), so lane C can
  assert parity and print the entries without re-walking the graph.
- **A3** For any project root, the transform warnings the real run prints and the warnings
  `--explain-props` prints are the same strings in the same order, including when `--no-transforms`
  empties both; a hit newly recognized by M108 appears in both modes on the same run.
- **A4** `scanExternalDeps` reads an import clause spread over several lines exactly as it reads the
  one-line form: an `import {` line, an `  x,` line and a `} from "pkg"` line yield `pkg`. A
  side-effect import
  (`import "./a.css"`) standing immediately above such a clause is still read as its own specifier,
  with or without a terminating semicolon, never swallowed into the clause below it. (gutenberg
  `packages/element/src/serialize.ts` imports `@wordpress/escape-html` across three lines; the missed
  edge hid the sibling behind it from M107's source rescue, and the run died on a Vite parse error.)
- **A5** An import of a file type Vite cannot load without a plugin (`.yaml`, `.yml`, `.toml`, `.md`,
  beside the already-recognized `.graphql`/`.gql`) is a `project-transform` preflight hit. Its owner
  names the loader plugin the project declares for that extension when it declares one (directus
  declares `@rollup/plugin-yaml` in `app/package.json` and its `vite.config.js` loads
  `src/lang/translations/en-US.yaml` with it), and keeps the recognizer's generic wording otherwise.
  The hit travels in `preflight.transforms`, the one list both modes read, so the dry run and the
  real run print it identically.

## MUST NOT

- Start a Vite server, a dev build or a browser from `--explain-props`: composition, transforms and
  include resolution are decided from parsed source and `package.json` files only.
- Predict a mode the real run would not enter, or print `Matrix mode:  would auto-activate` for a
  component the dispatcher composes.
- Add auto-composition to `DRY_RUN_RUNTIME_ONLY_NOTE` (`:1046-1050`): after C1 the decision is made
  from disk and printed, so the footer's three runtime-only classes stay exactly as they are.
- `continue` past an `optimizeDeps.include` entry that resolves to nothing.
- Change which mode a real run picks, which export it binds, or which props it measures. M110 changes
  prediction and disclosure; the only new real-run output is C3's suppression warning.
- Resolve `#`-prefixed specifiers through an `imports` field here: M108 owns that resolver, and A1
  fires only for what is still unresolved after it.

## Interfaces needed

- **I3 — producer A (`src/preflight.ts`), consumer C (`src/analyze.ts`).**
  `classifyProjectTransformHits(projectRoot, transforms, opts: { noTransforms?: boolean; workspaceRoot?: string }): Array<{ hit: PreflightHit; availability: PreprocessorAvailability }>`,
  already filtered by `detectProjectTransforms` loadability and by `availability !== "installed"`,
  in the order `src/analyze.ts:3347-3358` produces today, over a `transforms` list that already
  carries M108's two new hit sources. Lane A exports it once; the real-run site
  (`src/analyze.ts:3338-3358`) calls it instead of rebuilding the filter inline. Needed by C4 and A3.
- **I2 — producer A (`src/harness.ts`), consumer C (`src/analyze.ts`).**
  `StaticPreBuild.unresolvedExternals: Array<{ specifier: string; importer: string }>`, filled by
  `scanExternalDeps` at the site of root cause 4. Needed by A1's parity assertion and by C4's
  "everything the real run decides" claim.
- No interface is needed for composition: `inferComposition` is already exported from
  `src/composition.ts` and already imported by `src/analyze.ts:43`.

Conflicts in `M107-M117-MAP.md` (its ids, not this spec's MUST ids): map C1 — M107 and M108 land in
`scanExternalDeps` before A1; map C4 — M115 lands in `explainProps` before M110, M112 and M117 after
it; map C7 — M108's recognizers land before I3's classifier, M116's parse memo after it.

## Verification

Unit tests, `vitest run <file> --maxWorkers=2`.

- **C1, C2** `test/unit/dry-run-predicts-the-composed-scene.test.ts`. Fixture:
  `fixtures/m30-strict-compound.tsx` (existing; `Panel`, `PanelGroup`, `PanelContent`, `PanelItem`
  infer an item-based tree) and `fixtures/button.tsx` (single export, no tree). Asserts the
  `Composition:` line and `predictedMode === "combo"` for the compound file with no flags. The
  compound fixture declares only `children?: ReactNode`, so the printed
  `Matrix mode:  predicate matches, but an auto-composed scene ...` line is asserted on the same
  fixture run with `matrixMode: true` (which is what makes that branch reachable), alongside
  `matrixIneligibleReason === "composed"`.
- **C3** `test/unit/requested-matrix-names-what-took-precedence.test.ts`. Same compound fixture with
  `matrixMode: true`: the dry-run warning and the run-path warning are the same string and name
  `Panel`; a fixture-supplied run names the fixture file; a plain run emits neither.
- **C4** `test/unit/dry-run-prints-project-transform-warnings.test.ts`. Fixture:
  `fixtures/transform-project/` (existing; declares `@vanilla-extract/*` and `vite-plugin-svgr`, none
  installed). Asserts `explainProps(...).warnings` and the run path's `runWarnings` carry the same
  `[transform:...]` lines in the same order, and that `noTransforms: true` empties both.
- **A3** `test/unit/project-transform-hits-are-classified-once.test.ts`. Fixture:
  `fixtures/transform-project/`. Asserts I3's `classifyProjectTransformHits` (exported from
  `src/preflight.ts`) drops a hit whose plugin the project can load, drops an installed
  preprocessor, keeps the input order, and returns nothing under `noTransforms`.
- **A4** `test/unit/import-clause-across-lines-is-scanned.test.ts`. Asserts both shapes on one file:
  the multi-line clause's package is returned, and the side-effect import above it is still reported
  as an imported specifier (semicolon and no semicolon).
- **A5** `test/unit/data-file-import-names-its-loader-plugin.test.ts`. New fixture
  `fixtures/yaml-loader-project/` (a `package.json` declaring `@rollup/plugin-yaml`,
  `src/widget.tsx` importing `./messages.yaml`). Asserts `runPreflight` returns one
  `project-transform` hit for the `.yaml` edge whose `transformOwner` is `@rollup/plugin-yaml`, and
  that a project declaring no loader keeps the generic owner wording.
- **A1, A2** `test/unit/prebundle-entry-that-resolves-to-nothing-warns.test.ts`. New fixture
  `fixtures/unresolvable-include/` (a `package.json` with no `imports` field, `app/widget.tsx`
  importing `#app/root`). Asserts `scanExternalDeps` drops the entry, returns it on
  `unresolvedExternals`, and pushes one warning naming `#app/root` and `app/widget.tsx`; and that
  `collectStaticPreBuildWarnings` carries that warning, the single source both modes read.

Corpus, verbatim from `EVIDENCE.md` (`run120.mjs` = `C:/Projekte/120fps-fieldtest/tools/run120.mjs`,
`...` = `C:/Projekte/120fps-fieldtest`), against a scratch dist built from this worktree:

- epic-stack-F2: `node run120.mjs --cwd /e/repositories-run5/epic-stack --out .../logs/epic-stack --label ep3-dropdown-dry --timeout 1500 -- app/components/ui/dropdown-menu.tsx --explain-props ; node run120.mjs --cwd /e/repositories-run5/epic-stack --out .../logs/epic-stack --label ep7-dropdown-real --timeout 1500 -- app/components/ui/dropdown-menu.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
  Expected: the dry run and the real run print the same `#app` lines: none, because M108's `imports`
  resolver already resolved `#app/*`, and the real run reaches a report instead of dying at
  dep-optimization. A1's own text is proved by the `fixtures/unresolvable-include/` unit test and by
  any corpus specifier still unresolved after M108.
- logto-F3: `node run120.mjs --cwd .../packages/console --out .../logs/logto --label explain-confirmmodal --timeout 1500 -- src/ds-components/ConfirmModal/index.tsx --explain-props ; node run120.mjs --cwd .../packages/console --out .../logs/logto --label real-confirmmodal --timeout 1500 -- src/ds-components/ConfirmModal/index.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
  Expected: the dry run's `Warnings:` block carries the same 13 `[transform:css-preprocessor]` lines
  as `real-confirmmodal.log:26-38`.
- supabase-F3: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/supabase/packages/ui --out C:/Projekte/120fps-fieldtest/logs/supabase --label explain-popover --timeout 1500 -- src/components/shadcn/ui/popover.tsx --explain-props`
  Expected: `Composition:  would auto-compose from Popover ...` and a `Matrix mode:` line naming the
  composed scene; no `would auto-activate`.
- calcom-R1: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories/calcom --out C:/Projekte/120fps-fieldtest/logs/regression-calcom --label popover-matrix --timeout 900 -- packages/ui/components/popover/Popover.tsx --matrix --samples 3 --max-combos 4 --explore-budget 60 --no-deltas`
  Expected: `mode: prop combos` preceded by the suppression warning naming the composed root, exit 0.
- Unaffected control: one run-5 repo that reached a report (shadcn-admin `button.tsx`, bounded flags)
  still reaches the same verdict with no new warning.

Plus `node node_modules/typescript/bin/tsc --noEmit` clean and the lanes' existing analyze,
composition, matrix and harness unit files green (map baseline failures excepted). Decisive output
lines are pasted here before `status: approved`.

### Lane C evidence (2026-09-03, worktree `C:\Projekte\120fps-m107` at a261145 + lane C's own edits)

Tests, `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`:

```
 Test Files  3 passed (3)
      Tests  16 passed (16)
```

(`test/unit/dry-run-predicts-the-composed-scene.test.ts`,
`test/unit/requested-matrix-names-what-took-precedence.test.ts`,
`test/unit/dry-run-prints-project-transform-warnings.test.ts`.)

Whole suite, same flags, no regression against the map's baseline list:

```
 Test Files  299 passed (299)
      Tests  4502 passed | 1 skipped (4503)
```

`node node_modules/typescript/bin/tsc --noEmit`: clean (no output).

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/C-M110/dist/cli.js`, via
`C:/Projekte/120fps-fieldtest/tools/run120.mjs`:

- **supabase-F3** (`--cwd /e/repositories-run5/supabase/packages/ui`,
  `src/components/shadcn/ui/popover.tsx --explain-props`, label `M110-supabase-after`, exit 0).
  Before (`logs/supabase/explain-popover.log`): `Matrix mode:  would auto-activate`, no composition
  line. After, verbatim:

  ```
  Composition:  would auto-compose from Popover (5 exports)
  Matrix mode:  predicate matches, but an auto-composed scene supplies the props, so this run would measure that scene's single combo (auto-composed from Popover)
  ```

  Closed: yes.
- **logto-F3** (`--cwd /e/repositories-run5/logto/packages/console`,
  `src/ds-components/ConfirmModal/index.tsx --explain-props`, label `M110-logto-after`, exit 0).
  Before (`logs/logto/explain-confirmmodal.log:27-34`): no `[transform:...]` line at all. After:
  13 `[transform:css-preprocessor]` lines, the same count `logs/logto/real-confirmmodal.log:26-38`
  prints, first one verbatim:

  ```
  [transform:css-preprocessor] src/ds-components/ConfirmModal/index.tsx -> @/scss/modal.module.scss: this project compiles that with a CSS preprocessor (Vite needs sass/less/stylus installed in the project), which 120fps ...
  ```

  Closed: yes.
- **calcom-R1** (`--cwd /e/repositories/calcom`,
  `packages/ui/components/popover/Popover.tsx --matrix --samples 3 --max-combos 4 --explore-budget 60 --no-deltas`,
  label `M110-calcom-after`, exit 0, `Total: 1m 13s`). Before
  (`logs/regression-calcom/popover-matrix.log:4`): `mode: prop combos` with nothing said about the
  dropped `--matrix`. After, verbatim:

  ```
  mode: prop combos  (0:06)
  ⚠ --matrix did not activate: an auto-composed scene rooted at Popover supplies the props, and a composed scene measures one combo. Re-run with --no-auto-compose to force matrix instead.
  ```

  Closed: yes.
- **Unaffected control** (`--cwd /e/repositories-run5/shadcn-admin`,
  `src/components/ui/button.tsx --explain-props`, label `M110-shadcn-admin-after`, exit 0): same
  verdict, one added line and no new warning:

  ```
  Composition:  would measure Button alone
  Matrix mode:  would not auto-activate
  ```

  Closed: yes.
- **epic-stack-F2**: lane A (A1, A2). Not run by lane C; I2's
  `StaticPreBuild.unresolvedExternals` had not landed at the time of this commit.

Lane C open against lane A:

- **I3** (`classifyProjectTransformHits` in `src/preflight.ts`) had not landed at that commit. C4's
  classifier lived as `classifiedProjectTransformHits` in `src/analyze.ts`, called by the dry run and
  by the real-run site, so the two modes shared one filter. Closed by the follow-up below: the
  duplicate is deleted and both sites call lane A's export.
- `src/cli.ts`'s `explainPropsOptions` does not forward `skipAutoCompose` or `noTransforms`, so
  `--no-auto-compose --explain-props` and `--no-transforms --explain-props` still reach `explainProps`
  without those flags. `explainProps` accepts both (lane C's half of C1 and C4); the forwarding is
  lane A's line in `src/cli.ts`.

#### Lane C follow-up (2026-09-03, after lane A landed `ffba273`/`ec6ec61`)

`src/analyze.ts` no longer declares a classifier: `classifiedProjectTransformHits` is deleted and the
dry-run site and the run-path site both call `classifyProjectTransformHits` from `src/preflight.ts`
(I3). I2's `StaticPreBuild.unresolvedExternals` needed no new call site: lane A pushes
`UNRESOLVED_PREBUNDLE_ENTRY_WARNING` onto the `warnings` array of the one static pre-build both modes
read (`src/analyze.ts` dry run, `src/harness.ts` `buildAndServe`), so the dry run already prints that
line verbatim. `test/unit/dry-run-names-the-unresolved-prebundle-entry.test.ts` pins the parity
against `unresolvedExternals` itself: the dry run's unresolved lines equal
`unresolvedExternals.map(UNRESOLVED_PREBUNDLE_ENTRY_WARNING)`, and a project whose manifest `imports`
map resolves the specifier (the epic-stack shape) prints none.

Tests, `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`
(the four lane C files plus lane A's `project-transform-hits-are-classified-once.test.ts`):

```
 Test Files  5 passed (5)
      Tests  39 passed (39)
```

Every test file importing `src/analyze.js` or `src/composition.js`, same flags:

```
 Test Files  89 passed (89)
      Tests  1562 passed (1562)
```

`node node_modules/typescript/bin/tsc --noEmit`: clean (no output).

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/C-M110/dist/cli.js`, via
`C:/Projekte/120fps-fieldtest/tools/run120.mjs`:

- **epic-stack-F2, alias and unresolved parity** (`--cwd /e/repositories-run5/epic-stack`,
  `app/components/ui/button.tsx`, labels `M110-epic-stack-button-dry-after` (`--explain-props`,
  exit 0, 2s) and `M110-epic-stack-button-real-after` (`--samples 5 --max-combos 4 --explore-budget
  60 --no-deltas`, exit 0)). Both modes print the same two lines and no unresolved-include line
  (M108's `imports` resolver resolves `#app/*`), verbatim:

  ```
  tsconfig path alias "@/icon-name" -> "./app/components/ui/icons/types.ts" resolves to a location with no runtime entry (no package.json main/module/exports, no index file);
  import "openimg" resolved to an installed package with no runtime entry (no package.json main/module/exports, no index file);
  ```

  `grep -c "resolves to no installed package"` is 0 in both logs, and the real run reaches
  `Result: PASS`. Closed: yes.
- **logto-F3, through lane A's classifier** (`--cwd /e/repositories-run5/logto/packages/console`,
  `src/ds-components/ConfirmModal/index.tsx --explain-props`, label `M110-logto-after2`, exit 0).
  The 13 `[transform:css-preprocessor]` lines `diff` byte-identical against
  `logs/logto/real-confirmmodal.log`, first one verbatim:

  ```
  [transform:css-preprocessor] src/ds-components/ConfirmModal/index.tsx → @/scss/modal.module.scss: this project compiles that with a CSS preprocessor (Vite needs sass/less/stylus installed in the pro ...
  ```

  Closed: yes.
- **supabase-F3, unchanged by the re-point** (label `M110-supabase-after2`, exit 0):

  ```
  Composition:  would auto-compose from Popover (5 exports)
  Matrix mode:  predicate matches, but an auto-composed scene supplies the props, so this run would measure that scene's single combo (auto-composed from Popover)
  ```

  Closed: yes.
- **Unaffected control** (`--cwd /e/repositories-run5/shadcn-admin`,
  `src/components/ui/button.tsx --explain-props`, label `M110-shadcn-admin-after-C2`, exit 0): the
  same verdict, no `[transform:` line, no new warning:

  ```
  Composition:  would measure Button alone
  Matrix mode:  would not auto-activate
  ```

  Closed: yes.

Still open for lane A: `src/cli.ts`'s `explainPropsOptions` forwarding of `skipAutoCompose` and
`noTransforms` (unchanged from the note above).

### Lane A evidence (2026-09-03, worktree `C:\Projekte\120fps-m107` on `feat/m107-run5-remediation`)

Tests, `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`
(`test/unit/prebundle-entry-that-resolves-to-nothing-warns.test.ts`,
`test/unit/import-clause-across-lines-is-scanned.test.ts`,
`test/unit/data-file-import-names-its-loader-plugin.test.ts`,
`test/unit/project-transform-hits-are-classified-once.test.ts`):

```
 Test Files  4 passed (4)
      Tests  21 passed (21)
```

Every test file that imports `src/harness.ts` or `src/preflight.ts`, same flags:

```
 Test Files  103 passed (103)
      Tests  1625 passed | 1 skipped (1626)
```

`node node_modules/typescript/bin/tsc --noEmit`: clean (no output).

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/A-M110/dist/cli.js`, via
`C:/Projekte/120fps-fieldtest/tools/run120.mjs`:

- **epic-stack-F2, A1/A2 parity** (`--cwd /e/repositories-run5/epic-stack`,
  `app/components/ui/dropdown-menu.tsx`, labels `M110-epic-stack-dry-after` (`--explain-props`,
  exit 0) and `M110-epic-stack-real-after` (`--samples 5 --max-combos 4 --explore-budget 60
  --no-deltas`, exit 0)). Before (`logs/epic-stack/ep7-dropdown-real.log`): the real run died at
  dep-optimization on `#app` while the dry run said nothing. After: neither mode prints an
  unresolved-include line, because M108's `imports` resolver resolves `#app/*`, and the real run
  reaches a report:

  ```
  mode: prop matrix  (0:01)
  Result: PASS
  ```

  A1's own line is proved by `fixtures/unresolvable-include/` (unit test above), the only
  `#`-specifier in the corpus that resolves to nothing. Closed: yes.
- **A4, gutenberg** (`--cwd /e/repositories-run5/gutenberg/packages/components`,
  `src/button/index.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`, label
  `M110-gutenberg-after`, exit 0, `Total: 2m 20s`). Before (`logs/gutenberg/real-button.log`): exit 2
  on a Vite parse error, `@wordpress/escape-html` never reached because its import clause spans three
  lines. After, verbatim from the digest:

  ```
  component=Button path=src/button/index.tsx mode=curve pass=true noise=hostile cached=false
  W @wordpress/escape-html is a workspace package whose exports["."] names ./build-module/index.mjs, which does not exist on disk; its own source at E:/repositories-run5/gute ...
  ```

  Closed: yes.
- **A5, directus** (`--cwd /e/repositories-run5/directus/app`,
  `src/components/v-button.vue --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`, label
  `M110-directus-after2`, exit 2 in 34s). Before (`logs/directus/M110-directus-after.log`): the Vite
  parse error alone, no warning naming a plugin. After, the named hit is printed before the failure,
  verbatim:

  ```
  [transform:yaml] src/components/v-button.vue → src/components/v-icon/v-icon.vue → src/stores/user.ts → src/lang/set-language.ts → src/lang/index.ts → ./translations/en-US.yaml: this project compiles that with @rollup/plugin-yaml, which 1 ...
  ```

  The run still cannot mount (Vite parses the YAML as JavaScript without that plugin), so the exit
  code stays 2; what changed is that the cause is named. Closed: yes, as "prints the named hit".
- **Unaffected control** (`--cwd /e/repositories-run5/shadcn-admin`,
  `src/components/ui/button.tsx --explain-props`, label `M110-shadcn-admin-after-A`, exit 0): the
  same verdict lane C recorded, no new warning:

  ```
  Matrix mode:  would not auto-activate
  ```

  Closed: yes.

Lane A notes:

- **I3** is exported from `src/preflight.ts` as `classifyProjectTransformHits`. The real-run and
  dry-run call sites still go through lane C's identical `classifiedProjectTransformHits` in
  `src/analyze.ts`; swapping those two call sites onto the export is lane C's line in its own file.
- A5 needed one more edge in the walk lane A owns: `resolveVueImport` (`src/preflight.ts`) resolved
  relative SFC imports only, so the walk stopped at the first aliased `.vue` import and never reached
  the `.yaml` five files deeper. It now substitutes the governing tsconfig's `paths` before probing
  disk, the same resolution the rest of the walk already performs.
- Observed while running the epic-stack pair, for lane C: the dry run predicts
  `Matrix mode:  predicate matches, but an auto-composed scene supplies the props ...` for
  `app/components/ui/dropdown-menu.tsx`, and the real run then prints `mode: prop matrix`. Not lane
  A's files; recorded here as evidence for C1/C2.

## Deferred

- Resolving `#app`, `#imports` and `#build` through the importer's `imports` field: M108. A1 warns
  about what M108 leaves unresolved; landing M108 first removes epic-stack's entry entirely, and A1
  then covers the general case.
- Widening the workspace-sibling rescue in the same `externalPkgs` loop: M107 owns
  `src/harness.ts:4226-4252`. M110 adds only the "resolved to nothing" branch on the `continue` at
  `:4228`; M107 lands first, M110 rebases onto its loop.
- An explicit `--curve` the dispatcher cannot honour: no run-5 finding exercises it;
  `MATRIX_SUPPRESSED_BY_CURVE_WARNING` (`:240-242`) already covers the reverse direction.
- Alias-decision parity already holds: both modes read `collectStaticPreBuildWarnings`
  (`src/analyze.ts:2362`, `src/harness.ts:3453`), so M110 adds nothing there.
- The preset-aware remedy rewrite inside `explainProps` (`src/analyze.ts:2417-2427`): M112, same
  function, different region.
- `.module.scss` counting as a stylesheet (logto-F2): the verifier ruled it by-design
  (`verify/logto.md:49-67`); only the transform-warning half of logto-F3 is in scope.
- The real run's composition rollback after an empty composed mount (`src/analyze.ts:3542`) stays a
  runtime outcome. The dry run predicts the dispatcher's pre-mount choice; a scene that mounts empty
  is the class `DRY_RUN_RUNTIME_ONLY_NOTE` already covers.
- Wall-clock estimates in the dry run (M115) and once-per-run warning dedup (M117).
