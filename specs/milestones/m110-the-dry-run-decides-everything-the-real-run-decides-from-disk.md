---
kind: milestone
status: draft
tests:
  # Lane C
  - test/unit/dry-run-predicts-the-composed-scene.test.ts
  - test/unit/requested-matrix-names-what-took-precedence.test.ts
  - test/unit/dry-run-prints-project-transform-warnings.test.ts
  # Lane A
  - test/unit/prebundle-entry-that-resolves-to-nothing-warns.test.ts
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
