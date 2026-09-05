---
kind: milestone
status: draft
tests:
  - test/unit/unbuilt-sibling-subpath-resolves-to-its-source.test.ts
---

# M126: an exports subpath of an unbuilt sibling resolves to its source

Lane C (`src/harness/workspace-entries.ts`). Extends M107
(`specs/milestones/m107-workspace-siblings-resolve-by-their-real-entry.md`, A2).

## Purpose

M107 rescues an unbuilt workspace sibling by aliasing it to the source its own `package.json` points
at, and applies the same derivation to every `exports` subpath key. The derivation only looks beside
the declared build output, so a package that builds flat into `dist/` from a nested `src/` tree keeps
none of its subpaths. twenty is that shape: 15 of its 20 export keys declare `./dist/<name>.mjs`
while the source sits at `src/<name>/index.ts`, so measuring any component that imports one of them
stops the run. After this milestone the subpath resolves to that source, exactly as the root entry
already does.

Run-6 evidence: `C:/Projekte/120fps-fieldtest/smoke/lane-c/twenty/twenty-real.log:3` (exit 2 in 59 s)
and `twenty-dry.log` (exit 0, the same two subpaths disclosed as unrescued).

## Root causes (verified)

1. **Every source candidate is derived beside the build output** — `sourceCandidatesFor`
   (`src/harness/workspace-entries.ts:43-60`) builds four paths from a declared target, all resolved
   against the package root: the target, the target minus its extension, and, when the target has
   more than one segment, the same two with the first segment dropped. It never prepends `src/`. The
   verifier: for twenty-ui's `"./theme-constants"`, whose conditions are
   `{"types": "./dist/theme-constants/index.d.ts", "import": "./dist/theme-constants.mjs", "require": "./dist/theme-constants.cjs"}`,
   the candidates are `dist/theme-constants.mjs`, `dist/theme-constants`, `theme-constants` and
   `theme-constants.mjs`; `dist/` holds two CSS files and nothing else, and the source that does
   exist, `src/theme-constants/index.ts`, is never probed. The root entry survives only because
   `resolveWorkspaceSourceEntry` (`:111-118`) has `<pkg>/src` as a last fallback, which no subpath
   has.
2. **An unrescued subpath is dropped from the pre-bundle, and only warned about** —
   `applyDecision` (`src/harness/deps-scan.ts:429-439`) removes the specifier and emits
   `UNALIASED_WORKSPACE_SUBPATH_WARNING` (`:129-135`), whose own text predicts the failure: "this
   import may still fail when the browser loads it, not only at pre-bundle time." Vite then fails at
   request time and `bundler-failure.ts:108-114,164-182` renders
   `… imports "twenty-ui/theme-constants", which the dev server could not resolve to a loadable file.`

## MUST

- **C1** A declared `exports` subpath whose target does not exist on disk resolves to the sibling's
  own source when one exists under `src/`, using the same derivation the root entry uses: the
  declared path, that path with its leading segment dropped, and either of those under `src/`. The
  first candidate that resolves wins.
- **C2** A rescued subpath is aliased to that source and queued into the import walk, so its own
  imports are scanned, and it no longer appears in the external-package list. The package's single
  rescue disclosure (`UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING`) stays the only message; a rescued
  subpath adds none.
- **C3** A subpath with no source candidate keeps today's behaviour unchanged: dropped from the
  pre-bundle, disclosed once by `UNALIASED_WORKSPACE_SUBPATH_WARNING`.

## MUST NOT

- Change which entry an already-resolving package gets: the `src/`-prefixed candidates are appended
  after the existing ones, so any layout that resolves today resolves to the same file.
- Alias a subpath to a `.d.ts` file, or queue one into the walk (M107's MUST NOT, unchanged).
- Introduce a prefix or wildcard alias: an alias still matches one exact specifier, so an
  undeclared subpath of a sibling stays undeclared.

## Verification

- C1, C2 — `test/unit/unbuilt-sibling-subpath-resolves-to-its-source.test.ts`: a sibling shaped like
  twenty-ui (`exports["./theme-constants"] = {types: "./dist/theme-constants/index.d.ts", import:
  "./dist/theme-constants.mjs"}`, `dist/` absent, source at `src/theme-constants/index.ts`) is
  aliased for `@w/ui/theme-constants`, the specifier leaves the external list, the subpath's own
  imports are walked, and no unaliased-subpath warning is emitted.
- C3, MUST NOT — same file: a subpath whose source does not exist anywhere keeps the unaliased
  warning; a package that resolves a subpath beside its build output keeps that target even when a
  decoy exists under `src/`; a subpath whose only counterpart is a `.d.ts` is not aliased.
- Suite: the tests above plus `test/unit/workspace-sibling-entry-resolution.test.ts`,
  `test/unit/workspace-sibling-transitive-rescue.test.ts`,
  `test/unit/workspace-sibling-diagnosis-wording.test.ts`,
  `test/unit/unbuilt-workspace-source-alias.test.ts`, `test/unit/import-scanner-coverage.test.ts`,
  `test/unit/remedy-commands-name-the-directory-to-run-in.test.ts`.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Corpus: twenty (`--cwd E:/repositories/twenty/packages/twenty-front`, component
  `src/modules/ui/navigation/bread-crumb/components/Breadcrumb.tsx`) must no longer stop on
  `twenty-ui/theme-constants`, and shadcn-admin must still reach a report. Runs carry
  `--no-preflight`, since lane B's M124 turns twenty's `@lingui/core/macro` finding into a refusal
  that would stop the run before the harness builds.

Recorded run of this milestone's verification:

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   -> TSC_CLEAN
vitest run test/unit/unbuilt-sibling-subpath-resolves-to-its-source.test.ts \
  test/unit/workspace-sibling-entry-resolution.test.ts \
  test/unit/workspace-sibling-transitive-rescue.test.ts \
  test/unit/workspace-sibling-diagnosis-wording.test.ts \
  test/unit/unbuilt-workspace-source-alias.test.ts test/unit/import-scanner-coverage.test.ts \
  test/unit/remedy-commands-name-the-directory-to-run-in.test.ts --maxWorkers=2
  -> Test Files 7 passed (7), Tests 56 passed (56)
```

Corpus, through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --timeout 600 --cli
C:/Projekte/120fps-fieldtest/scratch/lane-c/dist/cli/main.js`, scratch dist built from this worktree:

- twenty, `--cwd E:/repositories/twenty/packages/twenty-front -- src/modules/ui/navigation/bread-crumb/components/Breadcrumb.tsx
  --no-preflight --samples 3 --max-combos 2 --explore-budget 30 --no-deltas` (label `m126-real`) ->
  exit 2 in 119 s. Before: the run stopped on `twenty-ui/theme-constants` (`twenty-real.log:3`).
  Now the subpath resolves, the walk enters the sibling's own source, and the run stops one layer
  deeper, `m126-real.log:3`:
  `Error: ../twenty-ui/src/theme-constants/ThemeProvider.tsx imports "@ui/utilities/utils/isDefined", which the dev server could not resolve to a loadable file. Check that the target exists; if it lives in an unbuilt workspace package, run that package's own build first.`
  That specifier is twenty-ui's own tsconfig path (`@ui/* -> ./src/*`), the Deferred item below.
  `grep -c "is a subpath of the workspace package"` over the log = 0: no subpath of twenty-ui is left
  unaliased any more.
- twenty, same component, `--no-preflight --explain-props` (label `m126-dry`) -> exit 0 in 12 s, no
  unaliased-subpath disclosure, and the same `@ui/…` finding the real run stops on is disclosed
  statically (`m126-dry.log:26`, `"@ui/utilities" (imported by ../twenty-ui/src/data-display/Avatar/Avatar.tsx) resolves to no installed package, no alias and no `imports` entry…`).
- shadcn-admin, `--cwd E:/repositories-run5/shadcn-admin -- src/components/ui/label.tsx --no-preflight
  --samples 3 --max-combos 2 --explore-budget 30 --no-deltas` (label `m126-unaffected`) -> exit 0 in
  82 s, `pass=true`,
  `Total: 1m 20s  (preflight 0s, build 1s, calibration 3s, mount 6s, rerender 3s, explore 3s, attribution 0s, analysis 1m 4s)`.

## Deferred

- A rescued sibling's own `tsconfig.json` `paths` (twenty-ui maps `@ui/* -> ./src/*`) are not read,
  so this milestone moves twenty's stop rather than removing it. The design problem: Vite aliases are
  global, while these aliases are per-package. An app's `@/*` and a sibling's `@/*` routinely point
  at different directories, so a sibling's paths can only be applied to importers inside that
  sibling, which needs importer-scoped resolution (a Vite plugin or a resolver hook), not another
  entry in the alias array. `loadTsconfigAliases` is called once per run with the app as the root
  (`src/harness/prebuild.ts:58`), and `walkExternalDeps` reuses that one array for every queued file
  (`src/harness/deps-scan.ts:318`).
- Deriving a candidate from the subpath key itself rather than from its declared target: no corpus
  case needs it, and it would guess a layout no manifest field names.
