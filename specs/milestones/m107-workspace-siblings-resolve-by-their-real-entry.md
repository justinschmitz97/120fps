---
kind: milestone
status: draft
tests:
  - test/unit/workspace-sibling-entry-resolution.test.ts
  - test/unit/workspace-sibling-transitive-rescue.test.ts
  - test/unit/workspace-sibling-diagnosis-wording.test.ts
---

# M107: workspace siblings resolve by their real entry

Lane A (`src/harness.ts`). First milestone of wave 1 in `specs/milestones/M107-M117-MAP.md`.

## Purpose

A developer measures a component in a monorepo they did not build. Its package imports workspace
siblings that were never built. Today the run aborts with exit 2 on directus and gutenberg, and on
react-spectrum it prints a warning asserting a `dist/` the sibling never declared. After this
milestone the sibling is aliased to the source its own `package.json` points at, whatever layout
that package uses, and the message a user reads names the field that was followed and the file that
was expected.

Closes: directus-F1 (blocker), gutenberg-F1 (blocker), react-spectrum-F1 (major).

Run-5 evidence: `C:\Projekte\120fps-fieldtest\EVIDENCE.md:58,60,76,105`,
`verify\directus.md:9-48`, `verify\gutenberg.md:6-30`, `verify\react-spectrum.md:9-26`,
`remediation\cluster-briefs.md:10-35`, logs `logs/directus/real-vbutton.log`,
`logs/gutenberg/real-button.log`, `logs/react-spectrum/explain-button.log`.

## Root causes (verified)

All line numbers re-checked with `grep -n` against `C:\Projekte\120fps-m107\src` on branch
`feat/m107-run5-remediation`. Where the map or EVIDENCE.md cites a different line, the worktree line
is given first and the cited one named after it.

1. **`<pkg>/src` is the only source candidate** — `src/harness.ts:4240`
   (`const resolvedSourceEntry = resolveTarget(path.join(real, "src"));`; EVIDENCE.md:58 cites
   `:4239`, the map `:4232-4250`). The verifier: the declared entry is never consulted when deriving
   where the source lives, so `@directus/utils` (`exports["."]`/`main` = `./dist/shared/index.js`,
   no `src/`, source at `shared/index.ts`) gets no alias, and `diagnoseUnbuiltWorkspacePackage`
   (`src/harness.ts:2770`, map cites `:2771`) turns Vite's per-request failure into the exit-2 abort
   (`verify/directus.md:14-30`).
2. **The rescue runs once, after the walk** — `src/harness.ts:4226-4256` (loop head `:4226`, alias
   push `:4244`). The verifier: the aliases pushed into `extraAliasesOut` are never re-scanned, so a
   sibling reachable only through an already-aliased sibling never enters `externalPkgs`
   (`verify/gutenberg.md:9-20`).
3. **The walk queues only locally resolved files** — `src/harness.ts:4120-4123`. The verifier:
   `@wordpress/hooks` is imported from `packages/components/src/higher-order/with-filters/index.tsx`,
   a file reached only through the alias for `@wordpress/components`; its absence from every warning
   in that run's log proves it never entered `externalPkgs` at all (`verify/gutenberg.md:28-30`).
4. **Subpath specifiers never reach an alias** — `src/harness.ts:4175` records
   `@directus/utils/browser` verbatim; `installedPackageDir` (`src/project-model.ts:168`) looks for a
   `package.json` at `node_modules/@directus/utils/browser`, finds none, and the loop `continue`s at
   `src/harness.ts:4228` (`cluster-briefs.md:15,16`). The alias regex at `:4244` is `^<pkg>$`, so
   even the root alias does not cover the subpath.
5. **Both warnings assert an unbuilt `dist/` with no manifest check** —
   `UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING` (`src/harness.ts:4030-4040`) and
   `UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING` (`src/harness.ts:4016-4021`). The verifier:
   `@react-types/shared` declares only `types: "src/index.d.ts"` and no `main`/`module`/`exports`, so
   the first warning claims a `dist/` and a browser-load risk for a package that ships `.d.ts` only
   (`verify/react-spectrum.md:11-20`). `.d.ts` is outside `SOURCE_EXTENSIONS`
   (`src/harness.ts:3818-3819`), so both `resolveTarget` probes fail for it.
6. **The abort recommends a build for a package whose source is on disk** —
   `diagnoseUnbuiltWorkspacePackage` (`src/harness.ts:2770-2794`) checks only that the declared entry
   is missing (`:2791-2792`), never that a source entry resolves (`verify/gutenberg.md:17-20`,
   `verify/directus.md:14-18`).

## MUST

### Lane A (`src/harness.ts`)

- **A1** An unbuilt workspace sibling is aliased to the source its own `package.json` points at.
  Candidates are derived in this order and the first that resolves on disk wins: `source`; `exports`
  conditions `development`, `source`, `import` (then `default`/`require`); a string-valued `exports`
  key is treated as `main` is; the derivation drops the entry path's leading segment and applies each
  source extension in turn (`dist/shared/index.js` -> `shared/index.ts`, `dist/browser/index.js` ->
  `browser/index.ts`), and when nothing resolves the next candidate is tried; `module`/`main` with the
  build-output segment dropped and a source extension applied (`dist/shared/index.js` resolves to
  `shared/index.ts`); `types` whose `.d.ts` sits beside a source file of the same stem; and last
  `<pkg>/src`. The run reaches a verdict instead of exiting 2, and the printed warning names the
  field that was followed and the path it resolved to.
- **A2** Every `exports` subpath key whose target is a module (the `./package.json` key and any target
  with no source counterpart are skipped) gets the same candidate derivation A1 applies to the root
  entry: `@directus/utils/browser`, declared `./dist/browser/index.js`, resolves to `browser/index.ts`.
  No subpath specifier of an aliased sibling remains in the returned external-package list.
- **A3** A sibling first reached through an import the scanner could not resolve is rescued in the
  same pass: once a sibling is aliased, the walk continues from its entry, and any further unbuilt
  sibling found there is aliased too. The pass reaches a fixed point, bounded by the number of
  workspace packages, and reports each alias once.
- **A4** A sibling that declares no `main`, `module` or `exports` at all is disclosed as a types-only
  workspace package: the message names the package and the `types` path it declares, states that no
  runtime entry is declared, and carries no `dist/` claim and no browser-load-risk claim.
- **A5** No message names a `dist/` unless the entry it followed is a path whose own segments contain
  `dist`. Every unbuilt-sibling message names the manifest field it followed (`source`,
  `exports["<key>"]`, `module`, `main`, `types`), the path that field declared, and whether that path
  exists on disk; the gutenberg sibling's message names `build-module/index.mjs`, never a `dist/`.
- **A6** A run never aborts for a sibling whose source resolves: when a source entry exists, the
  "needs a build step" diagnosis is not produced, and the exit code is the verdict's, never 2.

## MUST NOT

- Alias a package whose installed directory resolves inside a `node_modules` segment: a registry
  install keeps the target it resolves to today.
- Claim that a package "points at an unbuilt dist/" without having read a `main`, `module` or
  `exports` entry from its manifest.
- Recommend a build command for a package whose source entry resolves.
- Alias any sibling to a `.d.ts` file, or queue one into the import walk: a types-only sibling gets
  A4's message instead.
- Walk outside the workspace root, or revisit a package already aliased in the same pass.
- Print a workspace-sibling alias, types-only or no-source message in the real run that the dry run
  for the same component does not print, or the reverse (M100): the three messages come from
  `scanExternalDeps` and appear verbatim in both.
- Change how an already-aliased sibling with a `src/` entry resolves: the five directus siblings that
  resolve today (`composables`, `types`, `system-data` checked directly, `verify/directus.md:26-27`)
  keep the identical alias target.

## Interfaces needed

None (`cluster-briefs.md:33` records "Cross-lane: none" for G1).

Sequencing is conflict C1 in `M107-M117-MAP.md`, which governs `src/harness.ts:4074-4252`: M107 lands
first (the entry derivation at `:4240` and the rescue fixed point at `:4226-4256`), then M108's
`imports`-field classification at `:4119`/`:4153-4177`, then M110's report on the `continue` at
`:4228` (I2), then M116's memo. Conflict C3 governs the remedy text at `:4030-4041` and `:4249`:
M107 first, M111 second.

## Verification

Fixtures: the checked-in monorepo `fixtures/workspace-monorepo/` (members `packages/ui`,
`packages/vue-widget`, `pnpm-workspace.yaml`) documents the shape, but `isWorkspaceSibling`
(`src/harness.ts:4062`) requires the installed location's realpath to resolve outside every
`node_modules` segment, which only a real junction produces. The unit tests therefore build the
workspace in a temp directory with the `mkWorkspace`/`linkSibling` helpers already used by
`test/unit/unbuilt-workspace-source-alias.test.ts:25-52`, and add no directory under `fixtures/`.

- A1, A5 — `test/unit/workspace-sibling-entry-resolution.test.ts`: siblings `@w/utils`
  (`main: "./dist/shared/index.js"`, no `dist/`, source `shared/index.ts`), `@w/src-layout`
  (`main: "./dist/index.js"`, source `src/index.ts`, asserting the unchanged target) and
  `@w/source-field` (`source: "./lib/index.ts"`). Assert the alias target per package, and that the
  warning for `@w/source-field` names `source` and carries no `dist/` substring, and `@w/both`
  (`source: "./lib/index.ts"` and `main: "./dist/index.js"` with `dist/` absent but `index.ts`,
  `lib/index.ts` and `src/index.ts` all on disk), asserting the alias target is `lib/index.ts` and
  that the warning names `source`.
- A2 — same file: `@w/utils` also declares `exports: { ".": ..., "./browser": "./dist/browser.js" }`
  with `browser/index.ts` on disk. Assert an alias for `@w/utils/browser`, and that the returned
  external list contains neither `@w/utils` nor `@w/utils/browser`.
- A3 — `test/unit/workspace-sibling-transitive-rescue.test.ts`: `@w/ui` (aliased to `src/index.ts`)
  re-exports `./with-filters`, which imports `@w/hooks` (unbuilt, source `src/index.ts`). Assert
  `@w/hooks` is aliased from a scan started at a file that imports `@w/ui` only, that its warning is
  printed once, and that a cycle between two siblings terminates.
- A4, A6 — `test/unit/workspace-sibling-diagnosis-wording.test.ts`: `@w/types-only`
  (`types: "src/index.d.ts"` only, no `main`/`module`/`exports`) produces the types-only message with
  no `dist/` substring and no load-risk sentence; `diagnoseUnbuiltWorkspacePackage` returns
  `undefined` for a package whose source entry resolves, and keeps its current text for one whose
  entry is genuinely absent.

Suite and types: `vitest run test/unit/workspace-sibling-entry-resolution.test.ts test/unit/workspace-sibling-transitive-rescue.test.ts test/unit/workspace-sibling-diagnosis-wording.test.ts test/unit/unbuilt-workspace-source-alias.test.ts test/unit/import-scanner-coverage.test.ts --maxWorkers=2`
green; `node node_modules/typescript/bin/tsc --noEmit` clean.

Corpus, verbatim from the EVIDENCE.md rows (`:58`, `:60`, `:76`), run through a scratch dist built
from this worktree. The directus and gutenberg rows are truncated in EVIDENCE.md at the point marked
`[trunc]`; the truncated tail is restored from `findings/directus.md:21` and `findings/gutenberg.md:17`,
which record the same runs in full.

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/directus/app --out C:/Projekte/120fps-fieldtest/logs/directus --label real-vbutton --timeout 1500 -- src/components/v-button.vue --samples 5 --max-combos 4 --explore-budget 60 --no-deltas
```

Expected: no exit 2 and no "needs a build step" line for `@directus/utils`; instead one warning
naming the entry it followed (`packages/utils/dist/shared/index.js`, absent) and the source it
aliased (`E:/repositories-run5/directus/packages/utils/shared/index.ts`), and a verdict.

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/gutenberg/packages/components --out C:/Projekte/120fps-fieldtest/logs/gutenberg --label real-button --timeout 1500 -- src/button/index.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas
```

Expected: an alias line for `@wordpress/hooks` naming
`E:/repositories-run5/gutenberg/packages/hooks/src/index.ts`, beside the 8 siblings already aliased in
`logs/gutenberg/real-button.log:5-14`; the line names the entry it followed (`build-module/index.mjs`)
and contains no `dist/` substring; no "needs a build step" abort.

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/react-spectrum/packages/react-aria-components --out C:/Projekte/120fps-fieldtest/logs/react-spectrum --label explain-button --timeout 1500 -- src/Button.tsx --explain-props
```

Expected: for `@react-types/shared`, a types-only workspace-package line naming `src/index.d.ts`,
with no "unbuilt dist/" substring and no "may still fail when the browser loads it" sentence.

Unaffected control: a run-5 pass-gate repo (shadcn-admin, its button component) still reaches a
report with the verdict it produced at `7177203`.

## Deferred

- `#`-prefixed and `imports`-field specifiers, the Nuxt `#build`/`#imports` diagnosis, and virtual or
  macro imports: M108 owns the same classification block (`cluster-briefs.md:222`).
- A warning when a specifier has no installed directory at all (`src/harness.ts:4228` `continue`):
  M110 owns dry-run and real-run parity for that decision.
- Memoising the import-graph walk per (file, mtime-set) so the fixed point is paid for once across the
  dry run, the real run and a sweep: M116, gated by M115's numbers.
- Running the sibling's own build: out of scope. The harness reads the repository, never builds it.
- Subpath aliasing for packages that are not workspace siblings: no run-5 finding requires it, and it
  would change resolution for registry installs.
- Adding `.d.ts` to `SOURCE_EXTENSIONS`: a declaration file is not a module a browser loads; A4 gives
  the types-only sibling its own message instead.
